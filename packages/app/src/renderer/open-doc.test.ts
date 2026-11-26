import assert from "node:assert/strict";
import test from "node:test";
import { decideOpen } from "./open-doc.ts";

const doc = (id: string) => ({ id, title: id });

test("a book that exists locally opens locally even if it is also in the cloud", () => {
	// 这正是无限下载循环的触发条件：两处都有这本书
	assert.equal(decideOpen({ docId: "a", localDocs: [doc("a")], cloudDocs: [doc("a")] }), "local");
});

test("a book only in the cloud is downloaded once, then opens locally", () => {
	const before = decideOpen({ docId: "a", localDocs: [], cloudDocs: [doc("a")] });
	assert.equal(before, "download");
	// 下载完成后本地有了它：第二次点击必须走本地，否则会再下一遍整本书
	const after = decideOpen({ docId: "a", localDocs: [doc("a")], cloudDocs: [doc("a")] });
	assert.equal(after, "local");
});

test("an unknown id falls back to local (让上层去报错，而不是反复下载)", () => {
	assert.equal(decideOpen({ docId: "zzz", localDocs: [], cloudDocs: [] }), "local");
});
