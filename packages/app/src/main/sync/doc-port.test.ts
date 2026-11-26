import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDocPort } from "./doc-port.ts";

/**
 * 「书库目录 ↔ 同步状态」的翻译层。这里验证的是**保真度**：
 * 读出必须完整、写回必须保留机器相关字段、不存在 doc.json 的目录不能被当成书。
 */

function library(t: { after: (fn: () => void) => void }) {
	const root = mkdtempSync(join(tmpdir(), "ar-lib-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const port = createDocPort({
		dirOf: (docId) => join(root, docId),
		listDocIds: () => readdirSync(root).filter((name) => !name.startsWith(".")),
	});
	return { root, port };
}

test("read() assembles the five files into one doc state", (t) => {
	const { root, port } = library(t);
	const dir = join(root, "doc1");
	mkdirSync(join(dir, "chats"), { recursive: true });
	writeFileSync(
		join(dir, "doc.json"),
		JSON.stringify({
			id: "doc1",
			title: "深入理解计算机系统.pdf",
			ext: "pdf",
			hash: "abc",
			importedAt: 100,
			originalPath: "/tmp/x.pdf",
			lastPage: 42,
			lastLocation: null,
			positionUpdatedAt: 900,
			positionDevice: "dev-a",
		}),
	);
	writeFileSync(
		join(dir, "annotations.json"),
		JSON.stringify([{ id: "an1", page: 42, text: "重点" }]),
	);
	writeFileSync(
		join(dir, "reader-chapter.json"),
		JSON.stringify({ chapter: 7, at: 950, dev: "dev-a" }),
	);
	writeFileSync(join(dir, "conversations.json"), JSON.stringify([{ id: "c1", title: "默认对话" }]));
	writeFileSync(
		join(dir, "chats", "c1.jsonl"),
		`${JSON.stringify({ id: "m1", role: "user", content: "你好", timestamp: 1 })}\n`,
	);

	const state = port.read("doc1");
	assert.ok(state);
	assert.equal(state.title, "深入理解计算机系统.pdf");
	assert.equal(state.position.page, 42);
	assert.equal(state.position.at, 900);
	assert.equal(state.position.dev, "dev-a");
	assert.equal(state.chapter.value, 7);
	assert.deepEqual(
		state.annotations.map((row) => row.id),
		["an1"],
	);
	assert.deepEqual(
		state.conversations.map((row) => row.id),
		["c1"],
	);
	assert.deepEqual(
		(state.chats.c1 ?? []).map((row) => row.id),
		["m1"],
	);
});

test("write() overwrites sync fields but keeps machine-local ones", (t) => {
	const { root, port } = library(t);
	const dir = join(root, "doc1");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "doc.json"),
		JSON.stringify({
			id: "doc1",
			title: "旧标题",
			ext: "pdf",
			hash: "abc",
			importedAt: 100,
			originalPath: "/tmp/x.pdf",
		}),
	);

	const state = port.read("doc1");
	assert.ok(state);
	port.write("doc1", {
		...state,
		title: "新标题",
		position: { page: 88, location: null, at: 1234, dev: "dev-b" },
		annotations: [{ id: "an2", page: 88, text: "来自另一台机器" }],
	});

	const meta = JSON.parse(readFileSync(join(dir, "doc.json"), "utf-8"));
	assert.equal(meta.title, "新标题");
	assert.equal(meta.lastPage, 88);
	assert.equal(meta.positionDevice, "dev-b");
	// 机器相关字段必须原样保留，否则换机/重新导入会丢信息
	assert.equal(meta.hash, "abc");
	assert.equal(meta.importedAt, 100);
	assert.equal(meta.originalPath, "/tmp/x.pdf");

	const annotations = JSON.parse(readFileSync(join(dir, "annotations.json"), "utf-8"));
	assert.deepEqual(
		annotations.map((row: { id: string }) => row.id),
		["an2"],
	);
});

test("a directory without doc.json is not a book", (t) => {
	const { root, port } = library(t);
	mkdirSync(join(root, "junk"), { recursive: true });
	writeFileSync(join(root, "junk", "annotations.json"), "[]");
	mkdirSync(join(root, "doc1"), { recursive: true });
	writeFileSync(
		join(root, "doc1", "doc.json"),
		JSON.stringify({ id: "doc1", title: "t", ext: "pdf" }),
	);

	assert.deepEqual(port.list(), ["doc1"]);
	assert.equal(port.read("junk"), null);
});

test("chat files survive a round trip, including empty conversations", (t) => {
	const { root, port } = library(t);
	const dir = join(root, "doc1");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "doc.json"), JSON.stringify({ id: "doc1", title: "t", ext: "pdf" }));

	const state = port.read("doc1");
	assert.ok(state);
	port.write("doc1", {
		...state,
		conversations: [{ id: "c1", title: "一" }],
		chats: { c1: [{ id: "m1", role: "user", content: "hi", timestamp: 5 }] },
	});

	const again = port.read("doc1");
	assert.ok(again);
	assert.deepEqual(
		(again.chats.c1 ?? []).map((row) => row.id),
		["m1"],
	);
});
