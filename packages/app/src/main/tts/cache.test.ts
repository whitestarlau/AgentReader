import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TtsCache } from "./cache.ts";
import { cacheKey } from "./keys.ts";

const key = (over: Partial<Parameters<typeof cacheKey>[0]> = {}) =>
	cacheKey({ engineId: "e", voiceId: "v", text: "你好。", ...over });

function tempDir(t: { after: (fn: () => void) => void }) {
	const dir = mkdtempSync(join(tmpdir(), "tts-cache-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("cache key is stable and sensitive to every audio-affecting input", () => {
	assert.equal(key(), key());
	assert.notEqual(key(), key({ voiceId: "v2" }));
	assert.notEqual(key(), key({ engineId: "e2" }));
	assert.notEqual(key(), key({ rate: 1.5 }));
	assert.notEqual(key(), key({ text: "你好！" }));
});

test("round-trips audio and boundaries", (t) => {
	const cache = new TtsCache(tempDir(t));
	const k = key();
	assert.equal(cache.read(k), null);

	cache.put(k, {
		audio: { format: "mp3", sampleRate: 24_000, data: new Uint8Array([7, 8, 9]) },
		boundaries: [
			{ kind: "sentence", textStart: 0, textLength: 3, audioStartMs: 0, audioDurationMs: 500 },
		],
		durationMs: 500,
	});

	const hit = cache.read(k);
	assert.ok(hit);
	assert.deepEqual([...hit.audio.data], [7, 8, 9]);
	assert.equal(hit.audio.format, "mp3");
	assert.equal(hit.boundaries.length, 1);
	assert.equal(hit.durationMs, 500);
});

test("a corrupt entry is treated as a miss instead of throwing", (t) => {
	const dir = tempDir(t);
	const cache = new TtsCache(dir);
	const k = key();
	cache.put(k, {
		audio: { format: "mp3", sampleRate: 24_000, data: new Uint8Array([1]) },
		boundaries: [],
	});
	rmSync(join(dir, `${k}.mp3`));
	assert.equal(cache.read(k), null);
});

test("prune drops the oldest files until the budget fits", (t) => {
	const dir = tempDir(t);
	const cache = new TtsCache(dir, 25);
	const texts = ["一。", "二。", "三。"];
	for (const [i, text] of texts.entries()) {
		const k = key({ text });
		cache.put(k, {
			audio: { format: "mp3", sampleRate: 24_000, data: new Uint8Array(10) },
			boundaries: [],
		});
		// Distinct mtimes so the LRU order is deterministic.
		const at = new Date(Date.now() - (texts.length - i) * 10_000);
		utimesSync(join(dir, `${k}.mp3`), at, at);
	}
	assert.equal(cache.size(), 30);

	cache.prune();
	assert.equal(cache.size(), 20);
	// The oldest clip (first written) is the one that went.
	assert.equal(cache.read(key({ text: texts[0] })), null);
	assert.ok(cache.read(key({ text: texts[2] })));
});
