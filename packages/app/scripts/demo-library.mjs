/**
 * 生成一个演示书库（本地 + 「云端」目录），用于本地预览 / 截图。
 *
 * 只在开发时用：node scripts/demo-library.mjs [目标目录]
 * 产出：
 *   <目标>/userdata/    —— 传给 electron --user-data-dir
 *   <目标>/cloud/       —— 本地文件夹后端的「云端」，只放 books/
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import JSZip from "jszip";

const target = process.argv[2] ?? "/tmp/ar-shelf-demo";
rmSync(target, { recursive: true, force: true });

const BOOKS = [
	{ title: "深入理解计算机系统", author: "Randal E. Bryant", hue: 210, chapter: 7, total: 24, synced: true },
	{ title: "百年孤独", author: "加西亚·马尔克斯", hue: 28, chapter: 12, total: 20, synced: true },
	{ title: "设计数据密集型应用", author: "Martin Kleppmann", hue: 158, chapter: 3, total: 18, synced: true },
	{ title: "人类简史", author: "尤瓦尔·赫拉利", hue: 320, chapter: 0, total: 21, synced: false },
	{ title: "计算机程序的构造和解释", author: "SICP", hue: 262, chapter: 0, total: 26, synced: false },
	{ title: "三体", author: "刘慈欣", hue: 190, chapter: 5, total: 32, synced: true, cloudOnly: true },
];

/** 没有字体依赖的几何封面：渐变 + 色带，保证在任何机器上都能生成。 */
function coverBytes(hue) {
	const canvas = createCanvas(600, 900);
	const ctx = canvas.getContext("2d");
	const gradient = ctx.createLinearGradient(0, 0, 600, 900);
	gradient.addColorStop(0, `hsl(${hue} 55% 42%)`);
	gradient.addColorStop(1, `hsl(${(hue + 38) % 360} 50% 18%)`);
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, 600, 900);
	ctx.globalAlpha = 0.16;
	ctx.fillStyle = "#ffffff";
	for (let i = 0; i < 5; i++) ctx.fillRect(70, 150 + i * 96, 460 - i * 34, 26);
	ctx.globalAlpha = 0.5;
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(70, 690, 150, 6);
	return canvas.toBuffer("image/png");
}

async function buildEpub(book) {
	const zip = new JSZip();
	zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
	zip.file(
		"META-INF/container.xml",
		`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
	);
	zip.file(
		"OEBPS/content.opf",
		`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title>${book.title}</dc:title><dc:creator>${book.author}</dc:creator><dc:language>zh</dc:language>
    </metadata><manifest>
      <item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>
      <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    </manifest><spine><itemref idref="ch1"/></spine></package>`,
	);
	zip.file("OEBPS/cover.png", coverBytes(book.hue));
	zip.file(
		"OEBPS/ch1.xhtml",
		`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>${book.title}</h1><p>演示用章节。</p></body></html>`,
	);
	return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

const userdata = join(target, "userdata");
const cloud = join(target, "cloud");
mkdirSync(join(userdata, "library"), { recursive: true });
mkdirSync(join(cloud, "books"), { recursive: true });

const index = { settingsRev: 1, docs: {} };

for (const book of BOOKS) {
	const bytes = await buildEpub(book);
	const docId = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
	const dir = join(userdata, "library", docId);

	if (book.cloudOnly) {
		// 只在云端：不建本地目录，只放云端 books/
		writeFileSync(join(cloud, "books", `${book.title} [${docId}].epub`), bytes);
		index.docs[docId] = { rev: 1 };
		// 云端 state 里带书名，书架才能显示中文名而不是 hash
		mkdirSync(join(cloud, "state"), { recursive: true });
		writeFileSync(
			join(cloud, "state", `${docId}.json`),
			JSON.stringify({ schema: 1, rev: 1, docId, title: book.title, ext: "epub" }, null, 2),
		);
		continue;
	}

	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "original.epub"), bytes);
	writeFileSync(
		join(dir, "doc.json"),
		JSON.stringify(
			{
				id: docId,
				title: book.title,
				ext: "epub",
				hash: docId,
				importedAt: Date.now() - Math.round(Math.random() * 6e8),
				originalPath: `/Users/me/Books/${book.title}.epub`,
				...(book.chapter > 0
					? {
							positionUpdatedAt: Date.now() - Math.round(Math.random() * 3e7),
							positionDevice: "demo",
						}
					: {}),
				numPages: book.total,
				unit: "chapter",
			},
			null,
			2,
		),
	);
	writeFileSync(join(dir, "annotations.json"), "[]");
	// EPUB 的阅读位置在 reader-chapter.json（doc.json 的 lastPage 只服务 PDF）
	if (book.chapter > 0) {
		writeFileSync(join(dir, "reader-chapter.json"), JSON.stringify({ chapter: book.chapter, at: Date.now(), dev: "demo" }));
	}

	if (book.synced) {
		writeFileSync(join(cloud, "books", `${book.title} [${docId}].epub`), bytes);
		mkdirSync(join(cloud, "state"), { recursive: true });
		writeFileSync(
			join(cloud, "state", `${docId}.json`),
			JSON.stringify({ schema: 1, rev: 1, docId, title: book.title, ext: "epub" }, null, 2),
		);
		index.docs[docId] = { rev: 1 };
	}
}

// 同步配置：指向本地「云端」目录，于是书架会显示「已同步 / 云端」徽标
mkdirSync(join(userdata, "sync"), { recursive: true });
writeFileSync(
	join(userdata, "sync", "config.json"),
	JSON.stringify(
		{
			version: 1,
			enabled: true,
			deviceId: "demo-device",
			backend: {
				id: "local-folder",
				label: "本地文件夹",
				endpoint: cloud,
				account: "",
				rootName: "AgentReader",
			},
			scope: { settings: true, notes: true, books: true },
			lastSyncAt: Date.now() - 60_000,
		},
		null,
		2,
	),
);
writeFileSync(join(userdata, "sync", "index.json"), JSON.stringify(index, null, 2));

console.log(`演示书库已生成：${target}`);
