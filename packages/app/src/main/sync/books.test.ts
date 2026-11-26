import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SyncError } from "./backend.ts";
import { createLocalFolderBackend } from "./backends/local-folder.ts";
import { createBookSync, docIdOf } from "./books.ts";

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
	const sync = createBookSync({
		backend,
		pathOf: (docId) => paths.get(docId) ?? null,
		readFile: (path) => {
			const data = files.get(path);
			if (!data) throw new Error(`没有这个文件：${path}`);
			return data;
		},
	});
	return { cloud, files, paths, backend, sync };
}

const book = (content: string) => Buffer.from(content, "utf-8");

test("upload puts the original file under books/{docId}.{ext}", async (t) => {
	const { files, paths, sync, backend } = setup(t);
	const data = book("PDF-BYTES");
	const docId = docIdOf(data);
	files.set("/local/a.pdf", data);
	paths.set(docId, "/local/a.pdf");

	const result = await sync.upload(docId);
	assert.equal(result.bytes, data.length);

	const stored = await backend.get(`books/${docId}.pdf`);
	assert.ok(stored);
	assert.equal(stored.toString(), "PDF-BYTES");

	const remote = await sync.remoteBooks();
	assert.deepEqual(
		remote.map((entry) => [entry.docId, entry.ext, entry.size]),
		[[docId, "pdf", data.length]],
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
	const { files, paths, sync } = setup(t);
	const data = book("EPUB-CONTENT");
	const docId = docIdOf(data);
	files.set("/local/a.epub", data);
	paths.set(docId, "/local/a.epub");
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
	await backend.put(`books/${docId}.pdf`, book("TAMPERED"));

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
