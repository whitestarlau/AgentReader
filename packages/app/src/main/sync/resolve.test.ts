import assert from "node:assert/strict";
import test from "node:test";
import type { StoredConflict } from "./conflicts.ts";
import type { DocPort } from "./engine.ts";
import { type DocState, emptyDocState } from "./merge-records.ts";
import { applyDocChoice, applySettingsChoice } from "./resolve.ts";

const STAMP = { at: 1_000, dev: "A" };

function port(state: DocState): { port: DocPort; current(): DocState } {
	let current = state;
	return {
		port: {
			list: () => [state.docId],
			read: () => current,
			write: (_docId, next) => {
				current = next;
			},
		},
		current: () => current,
	};
}

const conflict = (over: Partial<StoredConflict>): StoredConflict => ({
	id: "x",
	scope: "doc",
	kind: "annotation",
	docId: "doc1",
	key: "an1",
	label: "",
	at: 1,
	...over,
});

test("settings choices write or delete the key", () => {
	assert.deepEqual(applySettingsChoice({ a: "1", b: "2" }, "a", "9"), { a: "9", b: "2" });
	assert.deepEqual(applySettingsChoice({ a: "1", b: "2" }, "a", undefined), { b: "2" });
});

test("an annotation choice replaces the record and stamps it", () => {
	const base = emptyDocState("doc1");
	const { port: p, current } = port({
		...base,
		annotations: [{ id: "an1", text: "远端版本", updatedAt: 5 }],
	});
	const applied = applyDocChoice({
		port: p,
		conflict: conflict({ kind: "annotation", local: '{"id":"an1","text":"本机版本"}' }),
		value: '{"id":"an1","text":"本机版本"}',
		stamp: STAMP,
	});
	assert.equal(applied, true);
	const row = current().annotations[0];
	assert.equal(row.text, "本机版本");
	// 必须重新发戳：否则下一轮合并还会把它判成冲突
	assert.equal(row.updatedAt, STAMP.at);
	assert.equal(row.deviceId, STAMP.dev);
});

test("choosing the deleted side removes the record", () => {
	const base = emptyDocState("doc1");
	const { port: p, current } = port({ ...base, annotations: [{ id: "an1", text: "x" }] });
	applyDocChoice({
		port: p,
		conflict: conflict({ kind: "annotation" }),
		value: undefined,
		stamp: STAMP,
	});
	assert.deepEqual(current().annotations, []);
});

test("a chat row is written back into the conversation it belongs to", () => {
	const base = emptyDocState("doc1");
	const { port: p, current } = port({
		...base,
		chats: {
			c1: [{ id: "m1", content: "旧" }],
			c2: [{ id: "m2", content: "另一个对话" }],
		},
	});
	applyDocChoice({
		port: p,
		conflict: conflict({
			kind: "chat",
			key: "m1",
			convId: "c2",
			local: '{"id":"m1","content":"新"}',
		}),
		value: '{"id":"m1","content":"新"}',
		stamp: STAMP,
	});
	const state = current();
	assert.deepEqual(
		(state.chats.c1 ?? []).map((row) => row.content),
		["旧"],
	);
	assert.deepEqual(
		(state.chats.c2 ?? []).map((row) => row.content),
		["另一个对话", "新"],
	);
});

test("a chat conflict without a conversation id is refused rather than guessed", () => {
	const { port: p } = port(emptyDocState("doc1"));
	const applied = applyDocChoice({
		port: p,
		conflict: conflict({ kind: "chat", key: "m1" }),
		value: '{"id":"m1"}',
		stamp: STAMP,
	});
	assert.equal(applied, false);
});

test("position and chapter choices take the chosen value with a fresh stamp", () => {
	const { port: p, current } = port(emptyDocState("doc1"));
	applyDocChoice({
		port: p,
		conflict: conflict({ kind: "position", key: "position" }),
		value: '{"page":42,"location":null,"at":5,"dev":"B"}',
		stamp: STAMP,
	});
	assert.equal(current().position.page, 42);
	assert.equal(current().position.at, STAMP.at);

	applyDocChoice({
		port: p,
		conflict: conflict({ kind: "chapter", key: "chapter" }),
		value: '{"value":7,"at":5,"dev":"B"}',
		stamp: STAMP,
	});
	assert.equal(current().chapter.value, 7);
	assert.equal(current().chapter.dev, STAMP.dev);
});

test("choosing a book that no longer exists is a no-op instead of a crash", () => {
	const applied = applyDocChoice({
		port: { list: () => [], read: () => null, write: () => {} },
		conflict: conflict({}),
		value: "{}",
		stamp: STAMP,
	});
	assert.equal(applied, false);
});
