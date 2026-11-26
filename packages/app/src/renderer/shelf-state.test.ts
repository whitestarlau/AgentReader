import assert from "node:assert/strict";
import test from "node:test";
import { deriveShelfDocs } from "./shelf-state.ts";

const doc = (id: string, over: Record<string, unknown> = {}) => ({ id, title: id, ...over });

test("a book with only a cloud copy is marked cloud and not local", () => {
	const [entry] = deriveShelfDocs({
		docs: [doc("a")],
		remoteOnlyDocs: [],
		libraryState: [{ docId: "a", localOriginal: false, remoteOriginal: true, notesSynced: true }],
		pendingDocs: [],
	});
	assert.equal(entry.cloud, true);
	assert.equal(entry.remote, true);
	assert.equal(entry.pending, false);
});

test("a downloaded book counts as synced straight away (this used to show nothing)", () => {
	const [entry] = deriveShelfDocs({
		docs: [doc("a")],
		remoteOnlyDocs: [],
		libraryState: [{ docId: "a", localOriginal: true, remoteOriginal: true, notesSynced: false }],
		pendingDocs: [],
	});
	assert.equal(entry.cloud, false);
	assert.equal(entry.remote, true, "云端还有原书，就该显示已同步");
});

test("notes that were pushed once are enough to show synced, even without the original", () => {
	const [entry] = deriveShelfDocs({
		docs: [doc("a")],
		remoteOnlyDocs: [],
		libraryState: [{ docId: "a", localOriginal: true, remoteOriginal: false, notesSynced: true }],
		pendingDocs: [],
	});
	assert.equal(entry.remote, true);
});

test("pending wins as a separate flag so the UI can show 待同步", () => {
	const [entry] = deriveShelfDocs({
		docs: [doc("a")],
		remoteOnlyDocs: [],
		libraryState: [{ docId: "a", localOriginal: true, remoteOriginal: true, notesSynced: true }],
		pendingDocs: ["a"],
	});
	assert.equal(entry.pending, true);
	assert.equal(entry.remote, true);
});

test("a purely local book has no badges at all", () => {
	const [entry] = deriveShelfDocs({
		docs: [doc("a")],
		remoteOnlyDocs: [],
		libraryState: [{ docId: "a", localOriginal: true, remoteOriginal: false, notesSynced: false }],
		pendingDocs: [],
	});
	assert.equal(entry.remote, false);
	assert.equal(entry.cloud, false);
});

test("remote-only entries keep their cloud flag when no state is known yet", () => {
	const [entry] = deriveShelfDocs({
		docs: [],
		remoteOnlyDocs: [doc("b", { cloud: true })],
		libraryState: [],
		pendingDocs: [],
	});
	assert.equal(entry.cloud, true);
	assert.equal(entry.remote, false, "还没有状态时不能凭猜测说已同步");
});
