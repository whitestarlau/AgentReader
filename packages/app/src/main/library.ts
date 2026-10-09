import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dialog, ipcMain } from "electron";
import { clearChapterCache } from "./doc-state.ts";
import { clearDocCaches } from "./doc-text.ts";
import { LIBRARY_ROOT, ensureLibrary, getDocDir } from "./paths.ts";

/** Import-based library management under `library/{hash}/`. */

export function registerLibraryIpc() {
	ipcMain.handle("library:list", () => {
		ensureLibrary();
		if (!existsSync(LIBRARY_ROOT)) return [];
		return readdirSync(LIBRARY_ROOT)
			.filter((id) => existsSync(join(LIBRARY_ROOT, id, "doc.json")))
			.map((id) => JSON.parse(readFileSync(join(LIBRARY_ROOT, id, "doc.json"), "utf-8")));
	});

	ipcMain.handle("library:import", async () => {
		ensureLibrary();
		const { canceled, filePaths } = await dialog.showOpenDialog({
			properties: ["openFile"],
			filters: [{ name: "Documents", extensions: ["pdf", "epub"] }],
		});
		if (canceled || !filePaths[0]) return null;
		const src = filePaths[0];
		const buf = readFileSync(src);
		const hash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
		const docId = hash;
		const dir = getDocDir(docId);
		mkdirSync(dir, { recursive: true });
		const ext = src.split(".").pop() ?? "pdf";
		copyFileSync(src, join(dir, `original.${ext}`));
		const meta = {
			id: docId,
			title: src.split("/").pop() ?? docId,
			ext,
			hash,
			importedAt: Date.now(),
			originalPath: src,
		};
		writeFileSync(join(dir, "doc.json"), JSON.stringify(meta, null, 2));
		if (!existsSync(join(dir, "annotations.json")))
			writeFileSync(join(dir, "annotations.json"), "[]");
		return meta;
	});

	ipcMain.handle("library:remove", async (_e, docId: string) => {
		const dir = getDocDir(docId);
		// Release in-memory handles/caches before deleting the folder from disk.
		clearDocCaches(docId);
		clearChapterCache(docId);
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		return true;
	});
}
