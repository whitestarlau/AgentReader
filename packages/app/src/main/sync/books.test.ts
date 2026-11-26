import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SyncError } from "./backend.ts";
import { createLocalFolderBackend } from "./backends/local-folder.ts";
import { cloudBookName, createBookSync, docIdFromBookName, docIdOf } from "./books.ts";

/**
 * 原书同步：用本地目录后端当「云端」，把上传/下载与完整性校验跑通。
 *
 * 这里刻意不测「真实网盘」，因为要验证的是我们自己的语义（体积预检、hash 校验、
 * 截断检测），而不是某个服务方的心情。
 */

function setup(t: { after: (fn: () => void) => void }) {
	const cloud = mkdtempSync(join(tmpdir(), "ar-books-cloud-"));
	t.after(() => rmSync(cloud, { recursive: true, force: true }));
	const files = new Map<string, Buffer>();
	const paths = new Map<string, string>();
	const backend = createLocalFolderBackend({ root: cloud });
	const titles = new Map<string, string>();
	const sync = createBookSync({
		backend,
		pathOf: (docId) => paths.get(docId) ?? null,
		titleOf: (docId) => titles.get(docId),
		readFile: (path) => {
			const data = files.get(path);
			if (!data) throw new Error(`没有这个文件：${path}`);
			return data;
		},
	});
	return { cloud, files, paths, titles, backend, sync };
}

const book = (content: string) => Buffer.from(content, "utf-8");

test("upload puts the original file under books/{docId}.{ext}", async (t) => {
	const { files, paths, titles, sync, backend } = setup(t);
	const data = book("PDF-BYTES");
	const docId = docIdOf(data);
	files.set("/local/a.pdf", data);
	paths.set(docId, "/local/a.pdf");
	titles.set(docId, "深入理解计算机系统");

	const result = await sync.upload(docId);
	assert.equal(result.bytes, data.length);

	// 云端文件名可读，但 docId 仍留在名字里（换设备靠它认书）
	const expected = `books/深入理解计算机系统 [${docId}].pdf`;
	const stored = await backend.get(expected);
	assert.ok(stored, `应当存在 ${expected}`);
	assert.equal(stored.toString(), "PDF-BYTES");

	const remote = await sync.remoteBooks();
	assert.deepEqual(
		remote.map((entry) => [entry.docId, entry.ext, entry.size, entry.title]),
		[[docId, "pdf", data.length, "深入理解计算机系统"]],
	);
});

test("a book that is not on this machine cannot be uploaded", async (t) => {
	const { sync } = setup(t);
	await assert.rejects(
		() => sync.upload("aaaaaaaaaaaaaaaa"),
		(error: unknown) => error instanceof SyncError && error.code === "not-found",
	);
});

test("files larger than the backend limit are refused before any transfer", async (t) => {
	const cloud = mkdtempSync(join(tmpdir(), "ar-books-limit-"));
	t.after(() => rmSync(cloud, { recursive: true, force: true }));
	const backend = createLocalFolderBackend({ root: cloud });
	backend.caps.maxObjectSize = 4; // 故意调小
	const data = book("way too large");
	const docId = docIdOf(data);
	const sync = createBookSync({
		backend,
		pathOf: () => "/local/big.pdf",
		readFile: () => data,
	});

	await assert.rejects(
		() => sync.upload(docId),
		(error: unknown) => error instanceof SyncError && error.code === "quota",
	);
	// 预检发生在动手之前：云端不应出现任何文件
	assert.deepEqual(await sync.remoteBooks(), []);
});

test("download verifies the content hash and hands the bytes to the caller", async (t) => {
	const { files, paths, titles, sync } = setup(t);
	const data = book("EPUB-CONTENT");
	const docId = docIdOf(data);
	files.set("/local/a.epub", data);
	paths.set(docId, "/local/a.epub");
	titles.set(docId, "三体");
	await sync.upload(docId);

	const box: { data?: Buffer; ext: string } = { ext: "" };
	const result = await sync.download(docId, (bytes, ext) => {
		box.data = bytes;
		box.ext = ext;
	});
	assert.equal(result.bytes, data.length);
	assert.equal(box.ext, "epub");
	assert.equal(box.data?.toString(), "EPUB-CONTENT");
});

test("a tampered remote file is rejected instead of being written to disk", async (t) => {
	const { sync, backend } = setup(t);
	const data = book("ORIGINAL");
	const docId = docIdOf(data);
	// 直接往云端塞一个「文件名对、内容不对」的文件
	await backend.put(`books/伪造 [${docId}].pdf`, book("TAMPERED"));

	let written = false;
	await assert.rejects(
		() =>
			sync.download(docId, () => {
				written = true;
			}),
		(error: unknown) => error instanceof SyncError && /不匹配/.test(error.message),
	);
	assert.equal(written, false, "校验失败时不能落盘");
});

test("downloading a book that the cloud does not have is a not-found, not a crash", async (t) => {
	const { sync } = setup(t);
	await assert.rejects(
		() => sync.download("bbbbbbbbbbbbbbbb", () => {}),
		(error: unknown) => error instanceof SyncError && error.code === "not-found",
	);
});

test("cloud names are readable but sanitized for Windows and length", () => {
	const docId = "0123456789abcdef";
	assert.equal(
		cloudBookName("深入理解计算机系统", docId, "pdf"),
		`深入理解计算机系统 [${docId}].pdf`,
	);
	// 路径分隔符与 Windows 非法字符被替换，不能逃出 books/
	assert.equal(cloudBookName('a/b:c*?"<>|d', docId, "pdf"), `a b c d [${docId}].pdf`);
	// 首尾的点和空格要去掉（Windows 不允许以点结尾，也不能变成隐藏文件）
	assert.equal(cloudBookName("  ..书名..  ", docId, "epub"), `书名 [${docId}].epub`);
	// 超长标题被截断
	const long = cloudBookName("长".repeat(200), docId, "pdf");
	assert.ok(long.length < 120);
	// 没标题就退回 docId
	assert.equal(cloudBookName(undefined, docId, "pdf"), `${docId}.pdf`);
	assert.equal(cloudBookName("   ", docId, "pdf"), `${docId}.pdf`);
});

test("docId is parsed from both the readable and the legacy file names", () => {
	assert.deepEqual(docIdFromBookName("三体 [0123456789abcdef].epub"), {
		docId: "0123456789abcdef",
		title: "三体",
	});
	// 旧版本存下的纯 hash 文件名继续可用
	assert.deepEqual(docIdFromBookName("0123456789abcdef.pdf"), { docId: "0123456789abcdef" });
	assert.equal(docIdFromBookName("随便一个文件.pdf"), null);
	assert.equal(docIdFromBookName("没有扩展名"), null);
});

test("re-uploading with a new title renames the cloud file instead of leaving a copy", async (t) => {
	const { files, paths, titles, sync, backend } = setup(t);
	const data = book("SAME-BYTES");
	const docId = docIdOf(data);
	files.set("/local/a.pdf", data);
	paths.set(docId, "/local/a.pdf");

	titles.set(docId, "旧书名");
	await sync.upload(docId);
	titles.set(docId, "新书名");
	await sync.upload(docId);

	const remote = await sync.remoteBooks();
	assert.equal(remote.length, 1, "同名书只应有一个云端文件");
	assert.equal(remote[0].title, "新书名");
	assert.equal(await backend.get(`books/旧书名 [${docId}].pdf`), null);
});

test("a book uploaded by the previous version (bare hash) is still found and migrated", async (t) => {
	const { files, paths, titles, sync, backend } = setup(t);
	const data = book("LEGACY");
	const docId = docIdOf(data);
	// 模拟旧版本留下的文件
	await backend.put(`books/${docId}.pdf`, data);
	assert.equal((await sync.remoteBooks())[0].docId, docId);

	let downloaded = "";
	await sync.download(docId, (bytes) => {
		downloaded = bytes.toString();
	});
	assert.equal(downloaded, "LEGACY");

	// 再次上传时会被整理成可读名字，旧文件删除
	files.set("/local/a.pdf", data);
	paths.set(docId, "/local/a.pdf");
	titles.set(docId, "整理后的书名");
	await sync.upload(docId);
	assert.equal(await backend.get(`books/${docId}.pdf`), null);
	assert.ok(await backend.get(`books/整理后的书名 [${docId}].pdf`));
});

test("two cloud files for the same book collapse into one entry (readable name wins)", async (t) => {
	const { sync, backend } = setup(t);
	const data = book("SAME");
	const docId = docIdOf(data);
	// 旧版本留下的纯 hash 文件 + 改名后的可读文件，都指向同一本书
	await backend.put(`books/${docId}.epub`, data);
	await backend.put(`books/一本书 [${docId}].epub`, data);

	const remote = await sync.remoteBooks();
	assert.equal(remote.length, 1, "同一 docId 只应出现一次，否则书架会画出两本一样的书");
	assert.equal(remote[0].title, "一本书");
});

test("download reports the book title from the cloud file name", async (t) => {
	const { files, paths, titles, sync } = setup(t);
	const data = book("TITLED");
	const docId = docIdOf(data);
	files.set("/local/x.epub", data);
	paths.set(docId, "/local/x.epub");
	titles.set(docId, "三体");
	await sync.upload(docId);

	const result = await sync.download(docId, () => {});
	assert.equal(result.title, "三体", "下载方拿得到书名，才能写出可读的 doc.json");
});
