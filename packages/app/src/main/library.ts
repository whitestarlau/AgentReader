import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dialog, ipcMain } from "electron";
import { ensureCover } from "./covers.ts";
import { clearChapterCache } from "./doc-state.ts";
import { clearDocCaches, clearDocTitleCache } from "./doc-text.ts";
import { ensureLibrary, getDocDir, libraryRoot } from "./paths.ts";
import { markDocDirty } from "./sync/dirty.ts";
import { syncBaseDocFile } from "./sync/paths.ts";

/** Import-based library management under `library/{hash}/`. */

export function registerLibraryIpc() {
	ipcMain.handle("library:list", () => {
		ensureLibrary();
		const root = libraryRoot();
		if (!existsSync(root)) return [];
		return readdirSync(root)
			.filter((id) => existsSync(join(root, id, "doc.json")))
			.map((id) => {
				const meta = JSON.parse(readFileSync(join(root, id, "doc.json"), "utf-8"));
				// EPUB 的阅读位置记在 reader-chapter.json（doc.json 的 lastPage 只服务 PDF），
				// 书架的进度条要同时认这两种来源，否则 EPUB 永远显示「未开始」。
				const chapterFile = join(root, id, "reader-chapter.json");
				if (existsSync(chapterFile)) {
					try {
						const chapter = Number(JSON.parse(readFileSync(chapterFile, "utf-8"))?.chapter);
						if (Number.isFinite(chapter) && chapter > 0) meta.chapter = Math.floor(chapter);
					} catch {}
				}
				return meta;
			});
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
		markDocDirty(docId);
		return meta;
	});

	/** 书架封面：按需生成（PDF 渲染首页 / EPUB 解封面图），生成失败返回 null */
	ipcMain.handle("library:cover", async (_e, docId: string) => ensureCover(String(docId ?? "")));

	ipcMain.handle("library:remove", async (_e, docId: string) => {
		const dir = getDocDir(docId);
		// Release in-memory handles/caches before deleting the folder from disk.
		clearDocCaches(docId);
		clearChapterCache(docId);
		clearDocTitleCache(docId);
		// 基线跟着删：否则重新导入同一本书时会拿过期基线去三方合并
		rmSync(syncBaseDocFile(docId), { force: true });
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		return true;
	});
}
