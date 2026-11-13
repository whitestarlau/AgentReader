/**
 * Wire types shared by the main process and the renderer for read-aloud.
 *
 * The engine contract itself lives in `main/tts/types.ts`; this file only holds
 * what crosses IPC, so the renderer never imports main-process code.
 */

/** Wire formats an engine can hand back. PCM is raw little-endian 16-bit. */
export type AudioFormat = "mp3" | "opus" | "wav" | "pcm16";

export type TtsVoice = {
	/** Engine-scoped id, opaque to the UI. */
	id: string;
	name: string;
	/** BCP-47-ish tag, e.g. "zh-CN". */
	lang: string;
	gender?: "female" | "male" | "neutral";
	styles?: string[];
	offline?: boolean;
};

export type TtsBoundary = {
	kind: "sentence" | "word";
	/** UTF-16 offsets into the synthesized text. */
	textStart: number;
	textLength: number;
	/** Milliseconds from the start of the returned audio. */
	audioStartMs: number;
	audioDurationMs: number;
};

export type TtsCapabilities = {
	streaming: boolean;
	boundaries: "none" | "sentence" | "word";
	formats: AudioFormat[];
	/** Upper bound for one engine call, in UTF-16 code units. */
	maxCharsPerRequest: number;
	/** True when synthesis needs no network at all. */
	offline: boolean;
	/** True when the engine needs an endpoint and/or credentials. */
	requiresConfig: boolean;
	rate: boolean;
	pitch: boolean;
};

export type TtsEngineInfo = {
	id: string;
	label: string;
	capabilities: TtsCapabilities;
};

export type TtsVoiceGroup = {
	engineId: string;
	label: string;
	voices: TtsVoice[];
};

export type TtsInfo = {
	engines: TtsEngineInfo[];
	/** Engine that would be used right now, or null when none is configured. */
	engineId: string | null;
	voiceId: string | null;
	rate: number;
	cacheBytes: number;
	endpointConfigured: boolean;
};

export type TtsSynthesizeRequest = {
	text: string;
	engineId?: string;
	voiceId?: string;
	/** 1 = normal; clamped to 0.5–2 by the main process. */
	rate?: number;
};

/**
 * `data` is transferred as a typed array (structured clone), so the renderer can
 * feed it straight into a Blob/`<audio>` without base64.
 */
export type TtsSynthesizeReply =
	| {
			ok: true;
			engineId: string;
			cached: boolean;
			format: AudioFormat;
			sampleRate: number;
			durationMs?: number;
			boundaries: TtsBoundary[];
			data: Uint8Array;
	  }
	| {
			ok: false;
			/** Mirrors the main-process `TtsErrorKind`. */
			kind: string;
			message: string;
	  };

/** One row of the on-device model catalog. */
export type TtsModelInfo = {
	id: string;
	name: string;
	desc: string;
	family: string;
	license: string;
	commercial: boolean;
	sizeLabel: string;
	installed: boolean;
	downloading: boolean;
	/** The model the local engine currently uses. */
	active: boolean;
	bytesOnDisk: number;
};

export type TtsModelsPayload = {
	models: TtsModelInfo[];
	/** Directory the app manages; users can still point at their own bundle. */
	modelDir: string;
};

export type TtsModelProgress = {
	id: string;
	phase: "download" | "extract" | "done" | "error" | "cancel";
	received: number;
	total: number;
	message?: string;
};
