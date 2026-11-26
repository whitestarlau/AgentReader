import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SyncError } from "./backend.ts";
import { createLocalFolderBackend } from "./backends/local-folder.ts";
import { createBookSync } from "./books.ts";
import { deleteBook } from "./delete.ts";
import { createFileStorage } from "./storage.ts";

/**
 * 删除的两种范围。这组用例对应一个真实的用户投诉：
 * 「点删除后书还在云端、书架又冒出来」——因为当时只有「删本地」这一条路。
 */

function world(t: { after: (fn: () => void) => void }) {
	const root = mkdtempSync(join(tmpdir(), "ar-del-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const cloud = join(root, "cloud");
	const local = join(root, "library");
	const syncDir = join(root, "sync");
	mkdirSync(join(cloud, "books"), { recursive: true });
	mkdirSync(join(cloud, "state"), { recursive: true });
	mkdirSync(join(local, "doc1"), { recursive: true });
	mkdirSync(join(local, "doc2"), { recursive: true });
	mkdirSync(syncDir, { recursive: true });

	const docId = "0123456789abcdef";
	const data = Buffer.from("book-bytes");
	// 云端：原书 + 笔记状态
	writeFileSync(join(cloud, "books", `一本书 [${docId}].epub`), data);
	writeFileSync(join(cloud, "state", `${docId}.json`), JSON.stringify({ schema: 1, docId }));
	// 本地：目录 + 基线 + 索引
	writeFileSync(
		join(local, "doc1", "doc.json"),
		JSON.stringify({ id: docId, title: "一本书", ext: "epub" }),
	);
	mkdirSync(join(syncDir, "base"), { recursive: true });
	writeFileSync(
		join(syncDir, "base", `${docId}.json`),
		JSON.stringify({ schema: 1, docId, values: {} }),
	);

	const backend = createLocalFolderBackend({ root: cloud });
	const books = createBookSync({ backend, pathOf: () => join(local, "doc1", "original.epub") });
	const storage = createFileStorage({
		baseFile: join(syncDir, "base", "settings.json"),
		indexFile: join(syncDir, "index.json"),
		docBaseFile: (id) => join(syncDir, "base", `${id}.json`),
	});
	storage.writeIndex({ settingsRev: 0, docs: { [docId]: { rev: 1 } } });

	let removedLocal = false;
	return {
		docId,
		cloud,
		local,
		storage,
		backend,
		books,
		removeLocal: () => {
			removedLocal = true;
			rmSync(join(local, "doc1"), { recursive: true, force: true });
			return true;
		},
		wasRemoved: () => removedLocal,
	};
}

test("deleting everywhere removes the cloud original, the cloud state and the local copy", async (t) => {
	const w = world(t);
	const result = await deleteBook({
		docId: w.docId,
		scope: "everywhere",
		backend: w.backend,
		books: w.books,
		storage: w.storage,
		removeLocal: w.removeLocal,
	});

	assert.equal(result.removedLocal, true);
	assert.ok(result.removedRemote.some((path) => path.includes("books/")));
	assert.equal(await w.backend.get(`books/一本书 [${w.docId}].epub`), null, "云端原书必须删掉");
	assert.equal(await w.backend.get(`state/${w.docId}.json`), null, "云端笔记状态也要删");
	// 基线不能留：留着它，下次重新导入同一本书会拿过期基线去合并
	assert.equal(existsSync(join(w.local, "..", "sync", "base", `${w.docId}.json`)), false);
	const index = w.storage.readIndex();
	assert.equal(index.docs[w.docId], undefined, "索引条目要清掉");
});

test("deleting only locally keeps the cloud copy and still drops the local baseline", async (t) => {
	const w = world(t);
	await deleteBook({
		docId: w.docId,
		scope: "local",
		backend: w.backend,
		books: w.books,
		storage: w.storage,
		removeLocal: w.removeLocal,
	});

	assert.ok(await w.backend.get(`books/一本书 [${w.docId}].epub`), "仅删本地时云端必须保留");
	assert.equal(existsSync(join(w.local, "..", "sync", "base", `${w.docId}.json`)), false);
});

test("deleting everywhere without a configured backend fails loudly instead of half-deleting", async (t) => {
	const w = world(t);
	await assert.rejects(
		() =>
			deleteBook({
				docId: w.docId,
				scope: "everywhere",
				backend: null,
				books: null,
				storage: w.storage,
				removeLocal: w.removeLocal,
			}),
		(error: unknown) => error instanceof SyncError && /尚未配置同步/.test(error.message),
	);
	assert.ok(await w.backend.get(`books/一本书 [${w.docId}].epub`), "失败时不能动云端");
});
