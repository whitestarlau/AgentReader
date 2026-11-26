import assert from "node:assert/strict";
import test from "node:test";
import { canonicalDocState, type DocState, emptyDocState, mergeDocState } from "./merge-records.ts";

const doc = (over: Partial<DocState> = {}): DocState => ({
	...emptyDocState("doc1", "一本书", "pdf"),
	...over,
});

const annotation = (id: string, text: string, updatedAt = 1, deviceId = "A") => ({
	id,
	page: 1,
	text,
	updatedAt,
	deviceId,
});

const row = (id: string, content: string, timestamp = 1) => ({
	id,
	role: "user",
	content,
	timestamp,
});

test("annotations added on either side both survive", () => {
	const base = doc();
	const local = doc({ annotations: [annotation("a1", "本机高亮")] });
	const remote = doc({ annotations: [annotation("b1", "另一台高亮")] });
	const { state, conflicts } = mergeDocState(base, local, remote);
	assert.deepEqual(state.annotations.map((entry) => entry.id).sort(), ["a1", "b1"]);
	assert.deepEqual(conflicts, []);
});

test("an annotation edited on one side is taken from that side", () => {
	const base = doc({ annotations: [annotation("a1", "原文")] });
	const local = doc({ annotations: [annotation("a1", "本机改过")] });
	const remote = doc({ annotations: [annotation("a1", "原文")] });
	const { state, conflicts } = mergeDocState(base, local, remote);
	assert.equal(state.annotations[0].text, "本机改过");
	assert.deepEqual(conflicts, []);
});

test("the same annotation edited on both sides reports a conflict and picks one deterministically", () => {
	const base = doc({ annotations: [annotation("a1", "原文")] });
	const local = doc({ annotations: [annotation("a1", "本机版", 5, "A")] });
	const remote = doc({ annotations: [annotation("a1", "远端版", 9, "B")] });

	const forward = mergeDocState(base, local, remote);
	const backward = mergeDocState(base, remote, local);
	assert.equal(forward.state.annotations[0].text, "远端版", "戳更晚的一方胜出");
	assert.equal(backward.state.annotations[0].text, "远端版", "结果与拉取方向无关");
	assert.equal(forward.conflicts.length, 1);
	assert.equal(forward.conflicts[0].kind, "annotation");
	assert.ok(forward.conflicts[0].local?.includes("本机版"), "输掉的值要留在冲突记录里");
});

test("deleting an annotation locally removes it, unless the other side edited it", () => {
	const base = doc({ annotations: [annotation("a1", "原文"), annotation("a2", "另一条")] });
	const local = doc({ annotations: [annotation("a2", "另一条")] });

	// 另一侧没动 a1 → 删除
	const untouched = mergeDocState(
		base,
		local,
		doc({ annotations: [annotation("a1", "原文"), annotation("a2", "另一条")] }),
	);
	assert.deepEqual(
		untouched.state.annotations.map((entry) => entry.id),
		["a2"],
	);

	// 另一侧改过 a1 → 保留并报冲突
	const edited = mergeDocState(
		base,
		local,
		doc({ annotations: [annotation("a1", "远端改过", 7), annotation("a2", "另一条")] }),
	);
	assert.deepEqual(edited.state.annotations.map((entry) => entry.id).sort(), ["a1", "a2"]);
	assert.equal(edited.conflicts.length, 1);
});

test("chat rows appended on both machines are unioned, not overwritten", () => {
	const base = doc({
		conversations: [{ id: "c1", title: "默认对话" }],
		chats: { c1: [row("m1", "你好")] },
	});
	const local = doc({
		conversations: [{ id: "c1", title: "默认对话" }],
		chats: { c1: [row("m1", "你好"), row("m2", "本机追问")] },
	});
	const remote = doc({
		conversations: [{ id: "c1", title: "默认对话" }],
		chats: { c1: [row("m1", "你好"), row("m3", "远端追问")] },
	});

	const { state, conflicts } = mergeDocState(base, local, remote);
	assert.deepEqual(
		(state.chats.c1 ?? []).map((entry) => entry.id),
		["m1", "m2", "m3"],
	);
	assert.deepEqual(conflicts, []);
});

test("a deleted conversation stays deleted when the other side did not touch it", () => {
	const base = doc({
		conversations: [
			{ id: "c1", title: "一" },
			{ id: "c2", title: "二" },
		],
		chats: { c1: [row("m1", "x")], c2: [row("m2", "y")] },
	});
	const local = doc({
		conversations: [{ id: "c1", title: "一" }],
		chats: { c1: [row("m1", "x")] },
	});
	const { state } = mergeDocState(base, local, base);
	assert.deepEqual(
		state.conversations.map((entry) => entry.id),
		["c1"],
	);
	assert.deepEqual(Object.keys(state.chats), ["c1"]);
});

test("reading position: the later stamp wins, and a genuine collision is reported", () => {
	const base = doc({ position: { page: 10, location: null, at: 1, dev: "A" } });
	const local = doc({ position: { page: 20, location: null, at: 5, dev: "A" } });
	const remote = doc({ position: { page: 30, location: null, at: 9, dev: "B" } });

	const forward = mergeDocState(base, local, remote);
	assert.equal(forward.state.position.page, 30);
	assert.equal(forward.conflicts.filter((c) => c.kind === "position").length, 1);

	// 只有一侧变了：静默采纳，不打扰用户
	const quiet = mergeDocState(base, local, base);
	assert.equal(quiet.state.position.page, 20);
	assert.deepEqual(quiet.conflicts, []);
});

test("the first sync of a book unions annotations and takes the later position", () => {
	const local = doc({
		annotations: [annotation("local1", "本机")],
		position: { page: 5, location: null, at: 3, dev: "A" },
	});
	const remote = doc({
		annotations: [annotation("remote1", "远端")],
		position: { page: 8, location: null, at: 4, dev: "B" },
	});

	const { state, conflicts } = mergeDocState(undefined, local, remote);
	assert.deepEqual(state.annotations.map((entry) => entry.id).sort(), ["local1", "remote1"]);
	assert.equal(state.position.page, 8);
	assert.deepEqual(conflicts, []);
});

test("merge is direction-independent (fuzz over annotations, chats and position)", () => {
	let seed = 20261126;
	const random = () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
	const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];

	for (let round = 0; round < 400; round++) {
		const ids = ["a1", "a2", "a3", "a4"];
		const build = (tag: string): DocState =>
			doc({
				annotations: ids
					.filter(() => random() < 0.6)
					.map((id) => annotation(id, `${tag}-${pick(["x", "y"])}`, Math.floor(random() * 5), tag)),
				conversations: [{ id: "c1", title: "t" }],
				chats: {
					c1: ["m1", "m2", "m3"]
						.filter(() => random() < 0.6)
						.map((id) => row(id, `${tag}-${id}`, Math.floor(random() * 5))),
				},
				position: {
					page: Math.floor(random() * 50),
					location: null,
					at: Math.floor(random() * 5),
					dev: tag,
				},
			});

		const base = build("base");
		const local = build("A");
		const remote = build("B");
		const forward = mergeDocState(base, local, remote);
		const backward = mergeDocState(base, remote, local);
		assert.equal(
			canonicalDocState(forward.state),
			canonicalDocState(backward.state),
			`第 ${round} 轮方向相关`,
		);
	}
});
