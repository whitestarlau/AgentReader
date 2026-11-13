/**
 * Provider-agnostic text-to-speech contract.
 *
 * Everything the player needs is expressed here. Concrete engines (cloud REST,
 * cloud WebSocket, on-device ONNX, a local OpenAI-compatible server) live in
 * `providers/` and are registered by id — adding one must never touch the
 * player, the cache, or the IPC layer.
 */

import type { AudioFormat, TtsBoundary, TtsCapabilities, TtsVoice } from "../../shared/tts.ts";

// Wire-level shapes are shared with the renderer; re-exported so providers only
// ever import from this module.
export type { AudioFormat, TtsBoundary, TtsCapabilities, TtsVoice };

/** Where a piece of text lands inside the returned audio (UTF-16 offsets). */
export type BoundaryKind = TtsBoundary["kind"];

export type TtsRequest = {
	text: string;
	voiceId: string;
	/** 1 = normal. Engines that cannot change rate ignore it. */
	rate?: number;
	pitch?: number;
	lang?: string;
	/** Preferred output format; engines fall back to their native one. */
	format?: AudioFormat;
	/** Abort long-running synthesis (stop button, seek, document switch). */
	signal?: AbortSignal;
};

export type TtsAudio = {
	format: AudioFormat;
	sampleRate: number;
	data: Uint8Array;
};

export type TtsResult = {
	audio: TtsAudio;
	/** Sorted by `audioStartMs`; empty when the engine reports no boundaries. */
	boundaries: TtsBoundary[];
	/** Wall-clock time to the first audio byte, when the engine can observe it. */
	firstAudioMs?: number;
	/** Total audio length when the engine knows it (streaming engines usually do). */
	durationMs?: number;
};

/** Incremental output for engines that can stream. Optional in v1. */
export type TtsEvent =
	| { type: "audio"; data: Uint8Array }
	| { type: "boundary"; boundary: TtsBoundary }
	| { type: "done"; audio: TtsAudio; boundaries: TtsBoundary[] };

export interface TtsEngine {
	readonly id: string;
	/** Human label for the settings picker. */
	readonly label: string;
	capabilities(): TtsCapabilities;
	/** Rejects with a `not-configured` TtsError when the engine is unusable. */
	listVoices(): Promise<TtsVoice[]>;
	synthesize(req: TtsRequest): Promise<TtsResult>;
	/** Optional: engines that stream override this; see `collectStream()`. */
	synthesizeStream?(req: TtsRequest): AsyncIterable<TtsEvent>;
	/**
	 * Extra cache-key material for everything engine-side that changes the audio
	 * (model directory, endpoint, model name...). Without it, switching models
	 * keeps replaying the previous model's cached audio, because `id` and the
	 * voice id stay the same.
	 */
	cacheTag?(): string;
}

export type TtsErrorKind =
	/** Missing endpoint, key, or model — the engine cannot run at all. */
	| "not-configured"
	/** The engine cannot express this request (format, length, rate, ...). */
	| "unsupported"
	/** The caller aborted; never fall through to another engine. */
	| "aborted"
	| "rate-limited"
	| "network"
	| "internal";

export class TtsError extends Error {
	readonly kind: TtsErrorKind;
	readonly engineId?: string;
	readonly status?: number;

	constructor(
		kind: TtsErrorKind,
		message: string,
		opts: { engineId?: string; status?: number; cause?: unknown } = {},
	) {
		super(message, { cause: opts.cause });
		this.name = "TtsError";
		this.kind = kind;
		this.engineId = opts.engineId;
		this.status = opts.status;
	}

	/** Whether the registry should try the next engine in the chain. */
	get retryable(): boolean {
		return this.kind === "network" || this.kind === "rate-limited" || this.kind === "internal";
	}
}

export function isTtsError(e: unknown): e is TtsError {
	return e instanceof TtsError;
}

/** Normalize anything thrown by an engine into a `TtsError`. */
export function toTtsError(e: unknown, engineId?: string): TtsError {
	if (isTtsError(e)) return e;
	if (e instanceof Error) {
		if (e.name === "AbortError") return new TtsError("aborted", "synthesis aborted", { engineId });
		return new TtsError("internal", e.message, { engineId, cause: e });
	}
	return new TtsError("internal", String(e), { engineId });
}

/** Drain a streaming engine into the buffered shape. */
export async function collectStream(events: AsyncIterable<TtsEvent>): Promise<TtsResult> {
	const chunks: Uint8Array[] = [];
	const boundaries: TtsBoundary[] = [];
	let audio: TtsAudio | undefined;
	for await (const ev of events) {
		if (ev.type === "audio") chunks.push(ev.data);
		else if (ev.type === "boundary") boundaries.push(ev.boundary);
		else {
			audio = ev.audio;
			boundaries.push(...ev.boundaries);
		}
	}
	if (audio && chunks.length === 0) return { audio, boundaries };
	if (!audio) throw new TtsError("internal", "stream ended without a done event");
	return { audio: { ...audio, data: concatBytes(chunks) }, boundaries };
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const c of chunks) total += c.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}
