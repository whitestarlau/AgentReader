import { writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
	app,
	BrowserWindow,
	dialog,
	type FileFilter,
	ipcMain,
	type SaveDialogOptions,
	shell,
} from "electron";
import {
	defaultExportFileName,
	type ExportBundle,
	type ExportFormat,
	type ExportOptions,
	type ExportRequest,
	type ExportResult,
	ensureExtension,
	formatFromPath,
	normalizeExportOptions,
} from "../shared/chat-export.ts";
import { collectBundle, readDocMeta } from "./export/collect.ts";
import { renderHtml } from "./export/html.ts";
import { renderJson } from "./export/json.ts";
import { renderMarkdown } from "./export/markdown.ts";
import { getDocDir, libraryRoot } from "./paths.ts";

/** Export one conversation of the selected document. */

const DOC_ID_RE = /^[0-9a-f]{16}$/i;
const CONV_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FILTERS_BY_FORMAT: Record<ExportFormat, FileFilter[]> = {
	md: [
		{ name: "Markdown", extensions: ["md", "markdown"] },
		{ name: "HTML", extensions: ["html", "htm"] },
		{ name: "JSON", extensions: ["json"] },
	],
	html: [
		{ name: "HTML", extensions: ["html", "htm"] },
		{ name: "Markdown", extensions: ["md", "markdown"] },
		{ name: "JSON", extensions: ["json"] },
	],
	json: [
		{ name: "JSON", extensions: ["json"] },
		{ name: "Markdown", extensions: ["md", "markdown"] },
		{ name: "HTML", extensions: ["html", "htm"] },
	],
};

export function registerExportIpc() {
	ipcMain.handle("chat:export", async (event, req: ExportRequest): Promise<ExportResult> => {
		const win = BrowserWindow.fromWebContents(event.sender);
		try {
			if (!req || typeof req.docId !== "string" || typeof req.convId !== "string") {
				throw new Error("导出参数不完整");
			}
			if (!DOC_ID_RE.test(req.docId)) throw new Error("无效的文档 ID");
			if (!CONV_ID_RE.test(req.convId)) throw new Error("无效的对话 ID");

			// Resolve/validate before touching the filesystem: docId is a path
			// segment, and conversations.chatFile() joins convId into a path too.
			safeDocDir(req.docId);
			const doc = readDocMeta(req.docId);
			if (doc.id !== req.docId) throw new Error("文档元数据不匹配");
			const options = normalizeExportOptions(req.options);
			const bundle = collectBundle(doc, req.convId, app.getVersion());
			const conversation = bundle.conversations[0];

			const saveOptions: SaveDialogOptions = {
				title: "导出对话",
				buttonLabel: "导出",
				defaultPath: join(
					app.getPath("documents"),
					defaultExportFileName(doc.title, conversation.title, options.format),
				),
				filters: FILTERS_BY_FORMAT[options.format],
				properties: ["createDirectory", "showOverwriteConfirmation"],
				showsTagField: false,
			};
			const result = win
				? await dialog.showSaveDialog(win, saveOptions)
				: await dialog.showSaveDialog(saveOptions);
			if (result.canceled || !result.filePath) return { ok: false, canceled: true };

			// The dialog's filter may have switched the extension; honour it.
			const format = formatFromPath(result.filePath) ?? options.format;
			const filePath = ensureExtension(result.filePath, format);
			const finalOptions: ExportOptions = { ...options, format };
			const text = await renderBundle(bundle, finalOptions);
			writeFileSync(filePath, text, "utf-8");

			if (finalOptions.openAfter) void shell.openPath(filePath).catch(() => {});
			return {
				ok: true,
				path: filePath,
				format,
				bytes: Buffer.byteLength(text, "utf8"),
				messages: conversation.messages.length,
			};
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});
}

/** Keep the resolved doc directory under the library root. */
function safeDocDir(docId: string): string {
	const root = resolve(libraryRoot());
	const dir = resolve(getDocDir(docId));
	if (dir !== root && !dir.startsWith(`${root}${sep}`)) {
		throw new Error("非法的文档路径");
	}
	return dir;
}

async function renderBundle(bundle: ExportBundle, options: ExportOptions): Promise<string> {
	switch (options.format) {
		case "html":
			return renderHtml(bundle, options);
		case "json":
			return renderJson(bundle);
		default:
			return renderMarkdown(bundle, options);
	}
}
