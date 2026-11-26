import assert from "node:assert/strict";
import test from "node:test";
import {
	clearPending,
	markDocDirty,
	markSettingsDirty,
	onDirty,
	resetDirtyState,
	takePending,
} from "./dirty.ts";

test("marking settings notifies listeners and shows up in the pending snapshot", (t) => {
	t.after(resetDirtyState);
	let calls = 0;
	const off = onDirty(() => {
		calls += 1;
	});
	markSettingsDirty();
	assert.equal(calls, 1);
	assert.equal(takePending().settings, true);
	assert.deepEqual(takePending().docs, []);
	off();
	markSettingsDirty();
	assert.equal(calls, 1, "取消订阅后不应再收到通知");
});

test("doc dirt is de-duplicated", (t) => {
	t.after(resetDirtyState);
	markDocDirty("a");
	markDocDirty("a");
	markDocDirty("b");
	markDocDirty(""); // 空 id 忽略
	assert.deepEqual(takePending().docs.sort(), ["a", "b"]);
});

test("clearing a snapshot only clears what was processed", (t) => {
	t.after(resetDirtyState);
	markSettingsDirty();
	markDocDirty("a");
	const snapshot = takePending();

	// 处理过程中用户又改了一次设置、又动了另一本书
	markSettingsDirty();
	markDocDirty("b");

	clearPending(snapshot);
	const left = takePending();
	assert.equal(left.settings, true, "处理期间的新改动不能被一起清掉");
	assert.deepEqual(left.docs, ["b"]);
});

test("an unsubscribed listener is not called after removal even if others remain", (t) => {
	t.after(resetDirtyState);
	const seen: string[] = [];
	const offFirst = onDirty(() => seen.push("first"));
	onDirty(() => seen.push("second"));
	markSettingsDirty();
	offFirst();
	markSettingsDirty();
	assert.deepEqual(seen, ["first", "second", "second"]);
});
