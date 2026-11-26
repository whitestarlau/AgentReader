import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { COVER_WIDTH, epubCoverPng } from "./cover-image.ts";
import { getPdfDoc } from "./doc-text.ts";
import { getDocDir } from "./paths.ts";

/**
 * 书架封面：主进程生成并缓存到 `library/{docId}/cover.png`。
 *
 * 两条来源：
 * - PDF：渲染第 1 页（按封面宽度等比缩放）；
 * - EPUB：从 OPF 里找封面图（EPUB3 的 `properties="cover-image"`、EPUB2 的
 *   `<meta name="cover">`），居中裁成 2:3。
 *
 * 生成失败（加密 PDF、无封面的 EPUB、图片解码不了）一律返回 null —— 书架用 CSS 占位，
 * 不能因为一本书没有封面就让整个书架打不开。
 */

export async function ensureCover(docId: string): Promise<string | null> {
	const dir = getDocDir(docId);
	let ext = "pdf";
	try {
		const meta = JSON.parse(readFileSync(join(dir, "doc.json"), "utf-8")) as { ext?: string };
		if (typeof meta.ext === "string") ext = meta.ext;
	} catch {
		return null;
	}

	const original = join(dir, `original.${ext}`);
	if (!existsSync(original)) return null;

	const coverPath = join(dir, "cover.png");
	// 原书比封面新（重新导入/替换）时重建
	if (existsSync(coverPath) && statSync(coverPath).mtimeMs >= statSync(original).mtimeMs) {
		return coverPath;
	}

	try {
		if (ext === "pdf") {
			await renderPdfCover(docId, coverPath);
		} else {
			const png = await epubCoverPng(readFileSync(original));
			if (!png) return null;
			writeFileSync(coverPath, png);
		}
		return existsSync(coverPath) ? coverPath : null;
	} catch (error) {
		console.error("[cover] 生成失败", docId, error);
		return null;
	}
}

async function renderPdfCover(docId: string, coverPath: string): Promise<void> {
	const doc = await getPdfDoc(docId);
	if (doc.numPages < 1) return;
	const page = await doc.getPage(1);
	if (!page.getViewport || !page.render) return;
	const base = page.getViewport({ scale: 1 });
	const viewport = page.getViewport({ scale: COVER_WIDTH / base.width });
	const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
	const context = canvas.getContext("2d");
	await page.render({
		// pdf.js 只用到 2D 上下文里标准的那部分 API，node-canvas 的实现够用
		canvasContext: context as unknown as CanvasRenderingContext2D,
		viewport,
	}).promise;
	writeFileSync(coverPath, canvas.toBuffer("image/png"));
}
