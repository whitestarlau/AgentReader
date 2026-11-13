/**
 * Long-text orchestration on top of a single engine.
 *
 * Engines cap how much text one request may carry (OpenAI-compatible servers
 * stop at a few thousand characters; local ONNX models are happy with a page).
 * The player does not want to care: it hands over a page or a chapter and gets
 * one buffer plus boundaries that still point at the original string.
 */

import { splitSentences } from "./segment.ts";
import {
	concatBytes,
	type TtsAudio,
	type TtsBoundary,
	type TtsEngine,
	TtsError,
	type TtsRequest,
	type TtsResult,
} from "./types.ts";

/** Rough Chinese/English reading pace used only when an engine reports nothing. */
const MS_PER_CHAR = 260;

/**
 * Best-effort duration for a result. Engines that stream report it; otherwise
 * the last boundary is authoritative; PCM can be computed exactly from samples.
 */
export function estimateDurationMs(result: TtsResult): number {
	if (typeof result.durationMs === "number" && result.durationMs > 0) return result.durationMs;
	const last = result.boundaries[result.boundaries.length - 1];
	if (last) return last.audioStartMs + last.audioDurationMs;
	const { format, sampleRate, data } = result.audio;
	if (format === "pcm16" && sampleRate > 0) return (data.length / 2 / sampleRate) * 1000;
	return 0;
}

/** Duration of an audio buffer when nothing better is known. */
export function estimateTextDurationMs(text: string): number {
	return Math.max(300, text.length * MS_PER_CHAR);
}

/**
 * Synthesize any amount of text with one engine.
 *
 * Text under the engine's per-request cap goes through untouched. Longer text is
 * split at sentence boundaries and the pieces are concatenated; boundaries are
 * shifted so they remain offsets into `req.text`.
 */
export async function synthesizeText(engine: TtsEngine, req: TtsRequest): Promise<TtsResult> {
	const cap = Math.max(40, engine.capabilities().maxCharsPerRequest || 400);
	if (req.text.length <= cap) return engine.synthesize(req);

	// Leave headroom: the splitter may merge nothing, but tokenizers differ.
	const segments = splitSentences(req.text, { maxChars: Math.floor(cap * 0.85) });
	if (segments.length <= 1) return engine.synthesize(req);

	const chunks: Uint8Array[] = [];
	const boundaries: TtsBoundary[] = [];
	let audio: TtsAudio | undefined;
	let offsetMs = 0;
	let firstAudioMs: number | undefined;

	for (const seg of segments) {
		if (req.signal?.aborted)
			throw new TtsError("aborted", "synthesis aborted", { engineId: engine.id });
		const part = await engine.synthesize({ ...req, text: seg.text });
		if (!audio) {
			audio = { ...part.audio, data: new Uint8Array(0) };
			firstAudioMs = part.firstAudioMs;
		} else if (part.audio.format !== audio.format) {
			throw new TtsError("unsupported", `engine changed format mid-text (${part.audio.format})`, {
				engineId: engine.id,
			});
		}
		chunks.push(part.audio.data);
		for (const b of part.boundaries) {
			boundaries.push({
				...b,
				textStart: b.textStart + seg.start,
				audioStartMs: b.audioStartMs + offsetMs,
			});
		}
		offsetMs += estimateDurationMs(part) || estimateTextDurationMs(seg.text);
	}

	if (!audio) throw new TtsError("internal", "no audio produced", { engineId: engine.id });
	return {
		audio: { ...audio, data: concatBytes(chunks) },
		boundaries,
		durationMs: offsetMs,
		firstAudioMs,
	};
}
