import assert from "node:assert/strict";
import test from "node:test";
import { estimateDurationMs, synthesizeText } from "./pipeline.ts";
import type { TtsCapabilities, TtsEngine, TtsRequest, TtsResult } from "./types.ts";

const SENTENCE = `${"甲".repeat(40)}。`;

/** Fake engine that returns 10 bytes and one 100 ms boundary per call. */
function fakeEngine(cap: number): TtsEngine & { calls: string[] } {
	const caps: TtsCapabilities = {
		streaming: false,
		boundaries: "sentence",
		formats: ["mp3"],
		maxCharsPerRequest: cap,
		offline: true,
		requiresConfig: false,
		rate: false,
		pitch: false,
	};
	const engine = {
		id: "fake",
		label: "fake",
		calls: [] as string[],
		capabilities: () => caps,
		listVoices: async () => [],
		async synthesize(req: TtsRequest): Promise<TtsResult> {
			engine.calls.push(req.text);
			return {
				audio: { format: "mp3", sampleRate: 24_000, data: new Uint8Array(10) },
				boundaries: [
					{
						kind: "sentence",
						textStart: 0,
						textLength: req.text.length,
						audioStartMs: 0,
						audioDurationMs: 100,
					},
				],
			};
		},
	};
	return engine;
}

test("short text is a single engine call", async () => {
	const engine = fakeEngine(1000);
	const result = await synthesizeText(engine, { text: "你好。", voiceId: "v" });
	assert.equal(engine.calls.length, 1);
	assert.equal(result.audio.data.length, 10);
});

test("long text is split by sentence and re-joined", async () => {
	const engine = fakeEngine(50);
	const text = SENTENCE.repeat(3); // 123 chars, three sentences of 41
	const result = await synthesizeText(engine, { text, voiceId: "v" });

	assert.equal(engine.calls.length, 3);
	assert.equal(result.audio.data.length, 30);
	assert.equal(result.durationMs, 300);
	assert.deepEqual(
		result.boundaries.map((b) => b.textStart),
		[0, 41, 82],
	);
	assert.deepEqual(
		result.boundaries.map((b) => b.audioStartMs),
		[0, 100, 200],
	);
	// Offsets still address the original string.
	for (const b of result.boundaries) {
		assert.equal(text.slice(b.textStart, b.textStart + b.textLength), SENTENCE);
	}
});

test("rejects when the engine changes format mid-text", async () => {
	const base = fakeEngine(50);
	let n = 0;
	const flaky: TtsEngine = {
		...base,
		synthesize: async (req) => {
			const out = await base.synthesize(req);
			n++;
			return { ...out, audio: { ...out.audio, format: n === 1 ? "mp3" : "wav" } };
		},
	};
	await assert.rejects(
		() => synthesizeText(flaky, { text: SENTENCE.repeat(3), voiceId: "v" }),
		/format/,
	);
});

test("estimateDurationMs prefers explicit length, then boundaries, then PCM math", () => {
	assert.equal(
		estimateDurationMs({
			audio: { format: "mp3", sampleRate: 24_000, data: new Uint8Array(1) },
			boundaries: [],
			durationMs: 1234,
		}),
		1234,
	);
	assert.equal(
		estimateDurationMs({
			audio: { format: "mp3", sampleRate: 24_000, data: new Uint8Array(1) },
			boundaries: [
				{ kind: "word", textStart: 0, textLength: 1, audioStartMs: 500, audioDurationMs: 250 },
			],
		}),
		750,
	);
	// 24000 Hz mono i16: 24000 samples = 1 second.
	assert.equal(
		estimateDurationMs({
			audio: { format: "pcm16", sampleRate: 24_000, data: new Uint8Array(48_000) },
			boundaries: [],
		}),
		1000,
	);
});
