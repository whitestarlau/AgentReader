import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ipcMain } from "electron";
import { getDocDir } from "./paths.ts";
import { syncClock } from "./sync/device.ts";
import { markDocDirty } from "./sync/dirty.ts";

/**
 * 给标注补 `updatedAt` / `deviceId`。
 *
 * 只给「内容真的变了」的标注发新戳：否则每次保存都会把所有标注刷成刚改过，
 * 另一台机器一同步就会把它们全部判成「双方都改」，冲突面板直接爆炸。
 */
function stripStamp(row: Record<string, unknown>): string {
	const { updatedAt: _updatedAt, deviceId: _deviceId, ...rest } = row;
	return JSON.stringify(rest);
}

function stampAnnotations(docId: string, next: unknown): unknown {
	const file = join(getDocDir(docId), "annotations.json");
	let previous: Record<string, unknown>[] = [];
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8"));
		if (Array.isArray(parsed)) {
			previous = parsed.filter(
				(row): row is Record<string, unknown> => typeof row === "object" && row !== null,
			);
		}
	} catch {}
	const byId = new Map<string, Record<string, unknown>>();
	for (const row of previous) {
		if (typeof row.id === "string") byId.set(row.id, row);
	}
	if (!Array.isArray(next)) return next;
	const clock = syncClock();
	return next.map((row) => {
		if (typeof row !== "object" || row === null) return row;
		const record = row as Record<string, unknown>;
		const before = typeof record.id === "string" ? byId.get(record.id) : undefined;
		if (before && stripStamp(before) === stripStamp(record)) return before;
		const stamp = clock.next();
		return { ...record, updatedAt: stamp.at, deviceId: stamp.dev };
	});
}

/**
 * Small per-document state that lives beside the original file: annotations,
 * the reader's current EPUB chapter, and the last reading position.
 */

// --- Annotations ---

export function registerAnnotationIpc() {
	ipcMain.handle("doc:annotations:get", (_e, docId: string) => {
		const p = join(getDocDir(docId), "annotations.json");
		if (!existsSync(p)) return [];
		return JSON.parse(readFileSync(p, "utf-8"));
	});

	ipcMain.handle("doc:annotations:save", (_e, docId: string, annotations: unknown) => {
		const stamped = stampAnnotations(docId, annotations);
		writeFileSync(join(getDocDir(docId), "annotations.json"), JSON.stringify(stamped, null, 2));
		markDocDirty(docId);
	});
}

// --- Current EPUB chapter ---

// The chapter (1-based) the reader is currently on. The single, stable position
// anchor shared by the UI and the AI tools. EPUB is reflowable and has no fixed
// page numbers — chapters are exact and render-independent, and `section.index`
// from epub.js follows the same spine order the main process parses.
function chapterFile(docId: string) {
	return join(getDocDir(docId), "reader-chapter.json");
}
const chapterCache = new Map<string, number>();
export function readReaderChapter(docId: string): number | undefined {
	if (chapterCache.has(docId)) return chapterCache.get(docId);
	const p = chapterFile(docId);
	let v: number | undefined;
	if (existsSync(p)) {
		try {
			const n = Number(JSON.parse(readFileSync(p, "utf-8"))?.chapter);
			if (Number.isFinite(n) && n >= 1) v = Math.floor(n);
		} catch {}
	}
	if (v !== undefined) chapterCache.set(docId, v);
	return v;
}
export function clearChapterCache(docId: string) {
	chapterCache.delete(docId);
}

export function registerChapterIpc() {
	ipcMain.handle("doc:chapter:get", (_e, docId: string) => readReaderChapter(docId) ?? null);
	ipcMain.handle("doc:chapter:set", (_e, docId: string, chapter: number) => {
		const n = Math.max(1, Math.floor(Number(chapter) || 1));
		chapterCache.set(docId, n);
		try {
			const stamp = syncClock().next();
			writeFileSync(
				chapterFile(docId),
				JSON.stringify({ chapter: n, at: stamp.at, dev: stamp.dev }),
			);
			markDocDirty(docId);
		} catch {}
	});
}

// --- Reading position (PDF page / EPUB location), stored in doc.json ---

export function registerReadingIpc() {
	ipcMain.handle("reading:get", (_e, docId: string) => {
		try {
			const m = JSON.parse(readFileSync(join(getDocDir(docId), "doc.json"), "utf-8")) as {
				lastPage?: number;
				lastLocation?: string;
			};
			return { page: m.lastPage ?? null, location: m.lastLocation ?? null };
		} catch {
			return { page: null, location: null };
		}
	});

	ipcMain.handle(
		"reading:save",
		(_e, docId: string, patch: { page?: number; location?: string }) => {
			try {
				const p = join(getDocDir(docId), "doc.json");
				const meta = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
				const changed =
					(typeof patch.page === "number" && patch.page > 0 && meta.lastPage !== patch.page) ||
					(typeof patch.location === "string" &&
						patch.location.length > 0 &&
						meta.lastLocation !== patch.location);
				if (typeof patch.page === "number" && patch.page > 0) meta.lastPage = patch.page;
				if (typeof patch.location === "string" && patch.location)
					meta.lastLocation = patch.location;
				if (changed) {
					// 位置与标题共用时间戳会让「只改标题」也把阅读位置判新，所以单独一套戳
					const stamp = syncClock().next();
					meta.positionUpdatedAt = stamp.at;
					meta.positionDevice = stamp.dev;
				}
				writeFileSync(p, JSON.stringify(meta, null, 2));
				if (changed) markDocDirty(docId);
			} catch {}
		},
	);
}

export function registerDocStateIpc() {
	registerAnnotationIpc();
	registerChapterIpc();
	registerReadingIpc();
}
