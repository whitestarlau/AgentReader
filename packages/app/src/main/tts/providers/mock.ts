import { estimateTextDurationMs } from "../pipeline.ts";
import { splitSentences } from "../segment.ts";
import type {
	TtsBoundary,
	TtsCapabilities,
	TtsEngine,
	TtsRequest,
	TtsResult,
	TtsVoice,
} from "../types.ts";

/**
 * Silent engine, for tests and for building the player UI without a network.
 *
 * It returns a valid WAV of silence whose length tracks the text, plus
 * sentence boundaries — i.e. everything the player consumes, with no vendor.
 */

const SAMPLE_RATE = 24_000;
const MAX_SECONDS = 120;

export class MockTts implements TtsEngine {
	readonly id = "mock";
	readonly label = "静音（开发用）";

	capabilities(): TtsCapabilities {
		return {
			streaming: false,
			boundaries: "sentence",
			formats: ["wav"],
			maxCharsPerRequest: 100_000,
			offline: true,
			requiresConfig: false,
			rate: false,
			pitch: false,
		};
	}

	cacheTag(): string {
		return "mock";
	}

	async listVoices(): Promise<TtsVoice[]> {
		return [{ id: "mock-zh", name: "静音音色", lang: "zh-CN", gender: "neutral", offline: true }];
	}

	async synthesize(req: TtsRequest): Promise<TtsResult> {
		const segments = splitSentences(req.text, { maxChars: 200 });
		const spans =
			segments.length > 0 ? segments : [{ text: req.text, start: 0, end: req.text.length }];
		const totalMs = Math.min(MAX_SECONDS * 1000, estimateTextDurationMs(req.text));

		// Give each sentence a share of the timeline proportional to its length.
		const weights = spans.map((s) => Math.max(1, s.text.length));
		const weightSum = weights.reduce((a, b) => a + b, 0);
		const boundaries: TtsBoundary[] = [];
		let at = 0;
		for (const [i, span] of spans.entries()) {
			const dur = Math.max(120, Math.round((totalMs * weights[i]) / weightSum));
			boundaries.push({
				kind: "sentence",
				textStart: span.start,
				textLength: span.text.length,
				audioStartMs: at,
				audioDurationMs: dur,
			});
			at += dur;
		}

		const data = silentWav(Math.ceil(at / 1000));
		return {
			audio: { format: "wav", sampleRate: SAMPLE_RATE, data },
			boundaries,
			durationMs: at,
			firstAudioMs: 0,
		};
	}
}

/** Minimal 16-bit mono WAV header followed by `seconds` of silence. */
export function silentWav(seconds: number): Uint8Array {
	const frames = Math.max(1, Math.round(seconds * SAMPLE_RATE));
	const dataSize = frames * 2;
	const out = new Uint8Array(44 + dataSize);
	const view = new DataView(out.buffer);
	const ascii = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, SAMPLE_RATE, true);
	view.setUint32(28, SAMPLE_RATE * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii(36, "data");
	view.setUint32(40, dataSize, true);
	return out;
}
