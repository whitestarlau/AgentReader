import { spawn } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ModelEntry } from "./catalog.ts";
import { TTS_MODELS } from "./catalog.ts";
import { pickModelFile } from "./providers/sherpa.ts";
import { TtsError } from "./types.ts";

/**
 * Model lifecycle for the on-device engine: download → verify → extract → validate.
 *
 * A manual "download a .tar.bz2 and unpack it yourself" flow is where this
 * feature would die, so the app owns the whole path: files land in
 * `{userData}/tts-models/{id}/`, partial downloads go to a temp directory, and a
 * bundle only becomes usable after it validates as a real model.
 */

export type ModelPhase = "download" | "extract" | "done" | "error" | "cancel";

export type ModelProgress = {
	id: string;
	phase: ModelPhase;
	received: number;
	total: number;
	message?: string;
};

const PROGRESS_INTERVAL_MS = 250;
/** Archive/extracted size differs by a few percent; reject anything grossly short. */
const SIZE_TOLERANCE = 0.02;

/** Root directory holding one folder per model; the caller owns the base path. */
export function modelDir(id: string, root: string): string {
	return join(root, id);
}

/** True when the directory holds real weights (not a partial or LFS-pointer download). */
export function isInstalled(entry: ModelEntry, root: string): boolean {
	const dir = modelDir(entry.id, root);
	if (!existsSync(dir)) return false;
	try {
		const files = listFiles(dir);
		if (!pickModelFile(files)) return false;
		if (entry.vocoderName) {
			const vocoder = files.find((f) => f.name === entry.vocoderName);
			if (!vocoder || vocoder.size < 1_000_000) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** Every installed catalog entry, preferred one first. */
export function installedModels(root: string): ModelEntry[] {
	return TTS_MODELS.filter((m) => isInstalled(m, root));
}

export function installedBytes(entry: ModelEntry, root: string): number {
	try {
		return listFiles(modelDir(entry.id, root)).reduce((n, f) => n + f.size, 0);
	} catch {
		return 0;
	}
}

const inflight = new Map<string, AbortController>();

export function isDownloading(id: string): boolean {
	return inflight.has(id);
}

/** Download, extract and validate one model. Progress is reported throughout. */
export async function downloadModel(
	entry: ModelEntry,
	onProgress: (p: ModelProgress) => void,
	root: string,
): Promise<void> {
	if (inflight.has(entry.id)) {
		throw new TtsError("unsupported", "该模型正在下载中", { engineId: "sherpa" });
	}
	const controller = new AbortController();
	inflight.set(entry.id, controller);
	const tmp = join(root, ".tmp", entry.id);
	const total = entry.assets.reduce((n, a) => n + a.bytes, 0);

	try {
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(tmp, { recursive: true });

		let done = 0;
		for (const asset of entry.assets) {
			const target = join(tmp, asset.name);
			await downloadToFile(asset.url, target, asset.bytes, controller.signal, (received) => {
				onProgress({ id: entry.id, phase: "download", received: done + received, total });
			});
			done += asset.bytes;
		}

		onProgress({ id: entry.id, phase: "extract", received: total, total, message: "正在解包" });
		const dest = modelDir(entry.id, root);
		rmSync(dest, { recursive: true, force: true });
		mkdirSync(dest, { recursive: true });

		const bundle = entry.assets.find((a) => a.kind === "bundle");
		if (bundle) await extractArchive(join(tmp, bundle.name), dest);
		for (const asset of entry.assets.filter((a) => a.kind === "file")) {
			renameSync(join(tmp, asset.name), join(dest, asset.name));
		}

		if (!isInstalled(entry, root)) {
			throw new TtsError("internal", "模型文件不完整，请重试", { engineId: "sherpa" });
		}
		onProgress({ id: entry.id, phase: "done", received: total, total });
	} catch (e) {
		const aborted = controller.signal.aborted;
		onProgress({
			id: entry.id,
			phase: aborted ? "cancel" : "error",
			received: 0,
			total,
			message: aborted ? "已取消" : messageOf(e),
		});
		rmSync(modelDir(entry.id, root), { recursive: true, force: true });
		rmSync(tmp, { recursive: true, force: true });
		throw e;
	} finally {
		inflight.delete(entry.id);
		rmSync(tmp, { recursive: true, force: true });
	}
}

export function cancelDownload(id: string): boolean {
	const controller = inflight.get(id);
	if (!controller) return false;
	controller.abort();
	return true;
}

export function removeModel(entry: ModelEntry, root: string): void {
	inflight.get(entry.id)?.abort();
	rmSync(modelDir(entry.id, root), { recursive: true, force: true });
}

async function downloadToFile(
	url: string,
	path: string,
	expectedBytes: number,
	signal: AbortSignal,
	onBytes: (received: number) => void,
): Promise<void> {
	let res: Response;
	try {
		res = await fetch(url, { signal, redirect: "follow" });
	} catch (e) {
		if (signal.aborted) throw new TtsError("aborted", "已取消", { engineId: "sherpa" });
		throw new TtsError("network", `下载失败：${messageOf(e)}`, { engineId: "sherpa", cause: e });
	}
	if (!res.ok || !res.body) {
		throw new TtsError("network", `下载失败：HTTP ${res.status}`, {
			engineId: "sherpa",
			status: res.status,
		});
	}

	let received = 0;
	let lastReport = 0;
	const counter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			received += chunk.length;
			const now = Date.now();
			if (now - lastReport > PROGRESS_INTERVAL_MS) {
				lastReport = now;
				onBytes(received);
			}
			callback(null, chunk);
		},
	});

	try {
		const body = Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
		await pipeline(body, counter, createWriteStream(path), { signal });
	} catch (e) {
		if (signal.aborted) throw new TtsError("aborted", "已取消", { engineId: "sherpa" });
		throw new TtsError("network", `下载中断：${messageOf(e)}`, { engineId: "sherpa", cause: e });
	}

	const size = statSync(path).size;
	if (expectedBytes > 0 && size < expectedBytes * (1 - SIZE_TOLERANCE)) {
		throw new TtsError("network", `下载不完整（${size}/${expectedBytes} 字节）`, {
			engineId: "sherpa",
		});
	}
	onBytes(received);
}

/**
 * Unpack a `.tar.bz2` bundle with the system tar.
 *
 * Node has no bzip2 decoder, and pulling a JS one in would mean another
 * dependency in the main bundle. tar ships with macOS, Linux and Windows 10+.
 */
function extractArchive(archive: string, dest: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("tar", ["-xjf", archive, "-C", dest, "--strip-components=1"], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-4000);
		});
		child.on("error", (e) => {
			reject(
				new TtsError("internal", `无法解压模型：${e.message}（需要系统 tar 命令）`, {
					engineId: "sherpa",
				}),
			);
		});
		child.on("close", (code) => {
			if (code === 0) resolve();
			else {
				reject(
					new TtsError(
						"internal",
						`解包失败：${stderr.trim().slice(0, 300) || `tar 退出码 ${code}`}`,
						{
							engineId: "sherpa",
						},
					),
				);
			}
		});
	});
}

function listFiles(dir: string): { name: string; size: number }[] {
	return readdirSync(dir)
		.filter((name) => !name.startsWith("."))
		.map((name) => {
			try {
				return { name, size: statSync(join(dir, name)).size };
			} catch {
				return { name, size: 0 };
			}
		});
}

function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
