import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ipcMain } from "electron";
import { getDocDir } from "./paths.ts";

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
		writeFileSync(join(getDocDir(docId), "annotations.json"), JSON.stringify(annotations, null, 2));
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
			writeFileSync(chapterFile(docId), JSON.stringify({ chapter: n }));
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

	ipcMain.handle("reading:save", (_e, docId: string, patch: { page?: number; location?: string }) => {
		try {
			const p = join(getDocDir(docId), "doc.json");
			const meta = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
			if (typeof patch.page === "number" && patch.page > 0) meta.lastPage = patch.page;
			if (typeof patch.location === "string" && patch.location) meta.lastLocation = patch.location;
			writeFileSync(p, JSON.stringify(meta, null, 2));
		} catch {}
	});
}

export function registerDocStateIpc() {
	registerAnnotationIpc();
	registerChapterIpc();
	registerReadingIpc();
}
