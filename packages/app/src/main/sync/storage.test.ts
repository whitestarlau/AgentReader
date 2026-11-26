import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileStorage } from "./storage.ts";

function tempStorage(t: { after: (fn: () => void) => void }) {
	const dir = mkdtempSync(join(tmpdir(), "ar-sync-storage-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const storage = createFileStorage({
		baseFile: join(dir, "base", "settings.json"),
		indexFile: join(dir, "index.json"),
	});
	return { dir, storage };
}

test("an empty sync directory has no baseline and a zeroed index", (t) => {
	const { storage } = tempStorage(t);
	assert.equal(storage.readBase(), undefined);
	assert.deepEqual(storage.readIndex(), { settingsRev: 0, docs: {} });
});

test("baseline round-trips", (t) => {
	const { storage } = tempStorage(t);
	storage.writeBase({
		schema: 1,
		values: { ocrLang: "jpn" },
		mtimes: { ocrLang: { at: 5, dev: "A" } },
		tombstones: {},
	});
	const base = storage.readBase();
	assert.equal(base?.values.ocrLang, "jpn");
	assert.equal(base?.mtimes.ocrLang.dev, "A");
});

test("index round-trips and tolerates a partial file", (t) => {
	const { dir, storage } = tempStorage(t);
	storage.writeIndex({ settingsRev: 4, docs: { abc: { rev: 2 } } });
	assert.deepEqual(storage.readIndex(), { settingsRev: 4, docs: { abc: { rev: 2 } } });

	writeFileSync(join(dir, "index.json"), JSON.stringify({ docs: {} }));
	assert.deepEqual(storage.readIndex(), { settingsRev: 0, docs: {} });
});

test("a corrupt baseline is treated as missing instead of crashing the engine", (t) => {
	const { dir, storage } = tempStorage(t);
	mkdirSync(join(dir, "base"), { recursive: true });
	writeFileSync(join(dir, "base", "settings.json"), "{ broken");
	assert.equal(storage.readBase(), undefined);
});

test("writes are atomic (no partial file left behind for readers)", (t) => {
	const { dir, storage } = tempStorage(t);
	storage.writeBase({ schema: 1, values: { a: "1" }, mtimes: {}, tombstones: {} });
	storage.writeBase({ schema: 1, values: { a: "2" }, mtimes: {}, tombstones: {} });
	const raw = readFileSync(join(dir, "base", "settings.json"), "utf-8");
	assert.equal(JSON.parse(raw).values.a, "2");
});
