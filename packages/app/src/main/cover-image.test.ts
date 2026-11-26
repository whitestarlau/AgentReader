import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import JSZip from "jszip";
import { COVER_HEIGHT, COVER_WIDTH, epubCoverPng, toCoverPng } from "./cover-image.ts";

/** 现场造一张指定尺寸的 JPEG/PNG，模拟真实封面图。 */
function makeImage(width: number, height: number): Buffer {
	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	context.fillStyle = "#335577";
	context.fillRect(0, 0, width, height);
	context.fillStyle = "#ffffff";
	context.fillRect(10, 10, width - 20, height - 20);
	return canvas.toBuffer("image/png");
}

/** 造一本只含「容器 + OPF + 封面图」的迷你 EPUB。 */
async function makeEpub(opts: { coverHref?: string; properties?: boolean } = {}): Promise<Buffer> {
	const zip = new JSZip();
	zip.file(
		"META-INF/container.xml",
		`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
	);
	const coverAttr = opts.properties ? ' properties="cover-image"' : "";
	zip.file(
		"OEBPS/content.opf",
		`<?xml version="1.0"?><package><metadata>
      <dc:title>测试书</dc:title>
      <meta name="cover" content="coverid"/>
    </metadata><manifest>
      <item id="coverid" href="${opts.coverHref ?? "images/cover.png"}" media-type="image/png"${coverAttr}/>
    </manifest></package>`,
	);
	if (opts.coverHref !== "missing.png") {
		zip.file(`OEBPS/${opts.coverHref ?? "images/cover.png"}`, makeImage(600, 900));
	}
	return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

test("an epub cover is cropped to a 2:3 png of the expected size", async () => {
	const png = await epubCoverPng(await makeEpub());
	assert.ok(png, "应当生成封面");
	// PNG 头里的 IHDR 宽高（大端 4 字节，偏移 16/20）
	assert.equal(png.readUInt32BE(16), COVER_WIDTH);
	assert.equal(png.readUInt32BE(20), COVER_HEIGHT);
});

test("EPUB3 properties=cover-image is honoured too", async () => {
	const png = await epubCoverPng(await makeEpub({ properties: true }));
	assert.ok(png);
});

test("an epub without a usable cover yields null instead of throwing", async () => {
	assert.equal(await epubCoverPng(await makeEpub({ coverHref: "missing.png" })), null);
});

test("wide images are centre-cropped rather than squashed", async () => {
	const png = await toCoverPng(makeImage(1600, 600));
	assert.equal(png.readUInt32BE(16), COVER_WIDTH);
	assert.equal(png.readUInt32BE(20), COVER_HEIGHT);
});

test("a non-image payload is reported as a failure, not a broken cover", async () => {
	await assert.rejects(() => toCoverPng(Buffer.from("not an image")));
});
