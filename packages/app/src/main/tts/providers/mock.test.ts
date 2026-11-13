import assert from "node:assert/strict";
import test from "node:test";
import { MockTts, silentWav } from "./mock.ts";

const ascii = (bytes: Uint8Array, at: number, len: number) =>
	String.fromCharCode(...Array.from(bytes.subarray(at, at + len)));

test("silentWav produces a valid 16-bit mono PCM container", () => {
	const wav = silentWav(2);
	assert.equal(ascii(wav, 0, 4), "RIFF");
	assert.equal(ascii(wav, 8, 4), "WAVE");
	assert.equal(ascii(wav, 36, 4), "data");
	const view = new DataView(wav.buffer);
	assert.equal(view.getUint32(24, true), 24_000); // sample rate
	assert.equal(view.getUint16(22, true), 1); // mono
	assert.equal(view.getUint16(34, true), 16); // bits per sample
	assert.equal(view.getUint32(40, true), 24_000 * 2 * 2); // 2 s of i16
});

test("mock engine reports sentence boundaries that address the original text", async () => {
	const engine = new MockTts();
	const text = "第一句。第二句。";
	const result = await engine.synthesize({ text, voiceId: "mock-zh" });

	assert.equal(result.audio.format, "wav");
	assert.equal(result.audio.sampleRate, 24_000);
	assert.equal(ascii(result.audio.data, 0, 4), "RIFF");
	assert.equal(result.boundaries.length, 2);
	for (const b of result.boundaries) {
		assert.equal(text.slice(b.textStart, b.textStart + b.textLength).endsWith("。"), true);
	}
	assert.ok((result.durationMs ?? 0) > 0);
});
