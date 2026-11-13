import assert from "node:assert/strict";
import test from "node:test";
import { encodeWav, floatToPcm16 } from "./wav.ts";

const ascii = (bytes: Uint8Array, at: number, len: number) =>
	String.fromCharCode(...Array.from(bytes.subarray(at, at + len)));

test("encodes a 16-bit mono PCM WAV header", () => {
	const wav = encodeWav(new Float32Array([0, 0.5, -0.5]), 22_050);
	const view = new DataView(wav.buffer);

	assert.equal(ascii(wav, 0, 4), "RIFF");
	assert.equal(view.getUint32(4, true), 36 + 6);
	assert.equal(ascii(wav, 8, 4), "WAVE");
	assert.equal(ascii(wav, 12, 4), "fmt ");
	assert.equal(view.getUint16(20, true), 1); // PCM
	assert.equal(view.getUint16(22, true), 1); // mono
	assert.equal(view.getUint32(24, true), 22_050);
	assert.equal(view.getUint32(28, true), 22_050 * 2); // byte rate
	assert.equal(view.getUint16(32, true), 2); // block align
	assert.equal(view.getUint16(34, true), 16);
	assert.equal(ascii(wav, 36, 4), "data");
	assert.equal(view.getUint32(40, true), 6);
	assert.equal(wav.length, 44 + 6);
});

test("floatToPcm16 clamps out-of-range samples instead of wrapping", () => {
	const pcm = floatToPcm16([1.7, -1.7, 0]);
	const view = new DataView(pcm.buffer);
	assert.equal(view.getInt16(0, true), 32767);
	assert.equal(view.getInt16(2, true), -32767);
	assert.equal(view.getInt16(4, true), 0);
});
