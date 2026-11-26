import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTombstoneStore, localIsNewerThan } from "./tombstones.ts";

function tempFile(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), "ar-tomb-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "tombstones.json");
}

test("tombstones round-trip and drop malformed entries", (t) => {
	const store = createTombstoneStore(tempFile(t));
	assert.deepEqual(store.read(), {});
	store.add("doc1", { at: 10, dev: "A" });
	store.add("doc2", { at: 20, dev: "B" });
	assert.deepEqual(store.read(), {
		doc1: { at: 10, dev: "A" },
		doc2: { at: 20, dev: "B" },
	});
	store.remove("doc1");
	assert.deepEqual(Object.keys(store.read()), ["doc2"]);
});

test("local edits after the deletion win (book is kept and resurrected)", () => {
	const tombstone = { at: 100, dev: "A" };
	assert.equal(localIsNewerThan([50, 90], tombstone), false, "都比墓碑旧 → 跟着删");
	assert.equal(localIsNewerThan([50, 120], tombstone), true, "有更新的标注/位置 → 保留");
	assert.equal(localIsNewerThan([], tombstone), false);
});
