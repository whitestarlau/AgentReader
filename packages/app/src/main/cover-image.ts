import { createCanvas, loadImage } from "@napi-rs/canvas";
import { findEpubCoverHref } from "./epub-cover.ts";

/**
 * EPUB → 封面 PNG。
 *
 * 只依赖 jszip 与 canvas，不碰 electron，所以能在单测里用「现场造一本迷你 EPUB」验证
 * 完整链路：解 container.xml → 找 OPF → 定位封面图 → 居中裁成 2:3 → 编码 PNG。
 */

export const COVER_WIDTH = 400;
export const COVER_HEIGHT = Math.round(COVER_WIDTH * 1.5);

/** 把任意比例的图片裁成 2:3 封面（居中，超出部分裁掉）。 */
export async function toCoverPng(imageBytes: Buffer): Promise<Buffer> {
	const image = await loadImage(imageBytes);
	const scale = Math.max(COVER_WIDTH / image.width, COVER_HEIGHT / image.height);
	const drawWidth = image.width * scale;
	const drawHeight = image.height * scale;
	const canvas = createCanvas(COVER_WIDTH, COVER_HEIGHT);
	const context = canvas.getContext("2d");
	context.fillStyle = "#1b1b1b";
	context.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
	context.drawImage(
		image,
		(COVER_WIDTH - drawWidth) / 2,
		(COVER_HEIGHT - drawHeight) / 2,
		drawWidth,
		drawHeight,
	);
	return canvas.toBuffer("image/png");
}

/** EPUB 字节 → 封面 PNG；没有封面时返回 null（书架用占位样式兜底）。 */
export async function epubCoverPng(zipBytes: Buffer): Promise<Buffer | null> {
	const JSZip = (await import("jszip")).default;
	const zip = await JSZip.loadAsync(zipBytes);
	const containerXml = await zip.file("META-INF/container.xml")?.async("string");
	const opfPath = containerXml?.match(/full-path="([^"]+)"/)?.[1] ?? "OEBPS/content.opf";
	const opfText = (await zip.file(opfPath)?.async("string")) ?? "";
	const href = findEpubCoverHref(opfText);
	if (!href) return null;

	const baseDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
	const candidates = [baseDir + href, href, baseDir + decodeURIComponent(href)];
	for (const candidate of candidates) {
		const file = zip.file(candidate);
		if (!file) continue;
		return toCoverPng(Buffer.from(await file.async("nodebuffer")));
	}
	return null;
}
