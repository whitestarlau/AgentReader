import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { conflictId, createConflictStore, settingsLabel, toStoredConflicts } from "./conflicts.ts";

function tempFile(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), "ar-conflicts-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "conflicts.json");
}

test("settings conflicts become labelled entries with stable ids", () => {
	const list = toStoredConflicts({
		settings: [
			{ key: "ocrLang", reason: "both-changed", local: "eng", remote: "jpn", winner: "remote" },
		],
		docs: [],
		titleOf: () => "",
		now: 100,
	});
	assert.equal(list.length, 1);
	assert.equal(list[0].id, "settings:ocrLang");
	assert.equal(list[0].label, "OCR 语言");
	assert.equal(list[0].local, "eng");
	assert.equal(list[0].at, 100);
});

test("doc conflicts carry the doc id, kind and a readable label", () => {
	const list = toStoredConflicts({
		settings: [],
		docs: [
			{
				docId: "doc1",
				kind: "annotation",
				key: "an1",
				local: '{"text":"A"}',
				remote: '{"text":"B"}',
			},
			{ docId: "doc1", kind: "chat", key: "m1", convId: "c1", local: "x", remote: "y" },
		],
		titleOf: (docId) => (docId === "doc1" ? "《一本书》" : docId),
		now: 1,
	});
	assert.equal(list[0].label, "《一本书》 · 标注");
	assert.equal(list[1].label, "《一本书》 · 对话消息");
	// 同一条消息在不同对话里不能撞 id
	assert.notEqual(
		list[1].id,
		conflictId({
			scope: "doc",
			kind: "chat",
			docId: "doc1",
			key: "m1",
			convId: "c2",
			label: "",
			at: 0,
		}),
	);
	assert.ok(list[1].id.includes("c1"));
});

test("the store round-trips and drops malformed entries", (t) => {
	const file = tempFile(t);
	const store = createConflictStore(file);
	assert.deepEqual(store.read(), []);

	store.write([
		{
			id: "settings:ttsRate",
			scope: "settings",
			kind: "settings",
			key: "ttsRate",
			label: "朗读语速",
			local: "1",
			remote: "1.2",
			at: 1,
		},
	]);
	assert.equal(store.read().length, 1);
});

test("a corrupt store file is treated as empty instead of crashing sync", (t) => {
	const file = tempFile(t);
	const store = createConflictStore(file);
	store.write([]);
	writeFileSync(file, "{ not json");
	assert.deepEqual(store.read(), []);
});

test("unknown keys still get a readable label", () => {
	assert.equal(settingsLabel("someNewKey"), "someNewKey");
	assert.equal(settingsLabel("ttsVoice:edge"), "朗读音色（edge）");
});
