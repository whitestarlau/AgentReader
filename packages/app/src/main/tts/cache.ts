import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AudioFormat, TtsBoundary, TtsResult } from "./types.ts";

/**
 * On-disk audio cache shared by every document.
 *
 * Reading is highly repetitive: re-reading a page, switching books and coming
 * back, or going offline after a session. Keying synthesized audio by content
 * makes all three free, and it is also the cheapest form of "offline" support —
 * everything already spoken can be replayed without any engine at all.
 */

export type CacheEntry = {
	format: AudioFormat;
	sampleRate: number;
	boundaries: TtsBoundary[];
	durationMs?: number;
	bytes: number;
	createdAt: number;
	/** Absolute path of the audio file. */
	path: string;
};

type StoredMeta = Omit<CacheEntry, "path">;

const EXT: Record<AudioFormat, string> = {
	mp3: "mp3",
	opus: "opus",
	wav: "wav",
	pcm16: "pcm",
};

export class TtsCache {
	private readonly dir: string;
	private readonly maxBytes: number;
	private writtenSincePrune = 0;

	constructor(dir: string, maxBytes = 500 * 1024 * 1024) {
		this.dir = dir;
		this.maxBytes = maxBytes;
	}

	getDir(): string {
		return this.dir;
	}

	/** Read a cached result, or null when it is missing or corrupt. */
	get(key: string): CacheEntry | null {
		const metaPath = join(this.dir, `${key}.json`);
		if (!existsSync(metaPath)) return null;
		try {
			const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as StoredMeta;
			const ext = EXT[meta.format] ?? "bin";
			const path = join(this.dir, `${key}.${ext}`);
			const stat = statSync(path);
			// Touch so the LRU keeps recently replayed clips.
			const now = new Date();
			utimesSync(path, now, now);
			return { ...meta, bytes: stat.size, path };
		} catch {
			return null;
		}
	}

	/** Extract the cached payload (audio bytes + boundaries) for a key. */
	read(key: string): TtsResult | null {
		const entry = this.get(key);
		if (!entry) return null;
		try {
			const data = new Uint8Array(readFileSync(entry.path));
			return {
				audio: { format: entry.format, sampleRate: entry.sampleRate, data },
				boundaries: entry.boundaries,
				durationMs: entry.durationMs,
			};
		} catch {
			return null;
		}
	}

	put(key: string, result: TtsResult): CacheEntry | null {
		try {
			mkdirSync(this.dir, { recursive: true });
			const ext = EXT[result.audio.format] ?? "bin";
			const path = join(this.dir, `${key}.${ext}`);
			const tmp = `${path}.tmp`;
			writeFileSync(tmp, result.audio.data);
			renameSync(tmp, path);
			const meta: StoredMeta = {
				format: result.audio.format,
				sampleRate: result.audio.sampleRate,
				boundaries: result.boundaries,
				durationMs: result.durationMs,
				bytes: result.audio.data.length,
				createdAt: Date.now(),
			};
			writeFileSync(join(this.dir, `${key}.json`), JSON.stringify(meta));
			this.writtenSincePrune += result.audio.data.length;
			// Rescan at most every quarter of the budget, and never more often than
			// one 8 MB write — scanning the directory per sentence would be silly.
			if (this.writtenSincePrune > Math.max(8 * 1024 * 1024, this.maxBytes / 4)) {
				this.writtenSincePrune = 0;
				this.prune();
			}
			return { ...meta, path };
		} catch {
			return null;
		}
	}

	/** Delete oldest entries until the directory fits `maxBytes`. Returns bytes freed. */
	prune(): number {
		if (!existsSync(this.dir)) return 0;
		let files: { path: string; size: number; mtime: number }[];
		try {
			files = readdirSync(this.dir)
				.filter((f) => !f.endsWith(".json") && !f.endsWith(".tmp"))
				.map((f) => {
					const path = join(this.dir, f);
					const stat = statSync(path);
					return { path, size: stat.size, mtime: stat.mtimeMs };
				});
		} catch {
			return 0;
		}
		let total = files.reduce((n, f) => n + f.size, 0);
		if (total <= this.maxBytes) return 0;
		let freed = 0;
		for (const file of files.sort((a, b) => a.mtime - b.mtime)) {
			if (total <= this.maxBytes) break;
			const metaPath = file.path.replace(/\.[a-z0-9]+$/, ".json");
			try {
				unlinkSync(file.path);
				rmSync(metaPath, { force: true });
				total -= file.size;
				freed += file.size;
			} catch {}
		}
		return freed;
	}

	/** Drop everything (settings → 清空朗读缓存). */
	clear(): void {
		try {
			rmSync(this.dir, { recursive: true, force: true });
		} catch {}
		this.writtenSincePrune = 0;
	}

	/** Bytes currently on disk. */
	size(): number {
		if (!existsSync(this.dir)) return 0;
		let total = 0;
		try {
			for (const f of readdirSync(this.dir)) {
				if (f.endsWith(".json") || f.endsWith(".tmp")) continue;
				total += statSync(join(this.dir, f)).size;
			}
		} catch {}
		return total;
	}
}
