/**
 * Wire types shared by the main process and the renderer for read-aloud.
 *
 * The engine contract itself lives in `main/tts/types.ts`; this file only holds
 * what crosses IPC, so the renderer never imports main-process code.
 */

/** Wire formats an engine can hand back. PCM is raw little-endian 16-bit. */
export type AudioFormat = "mp3" | "opus" | "wav" | "pcm16";

/**
 * How the player chooses between online engines and the local model.
 *
 * The registry has always walked a fallback chain, but the *order* used to be an
 * implementation detail: the free online tier came first and the local model was
 * only a safety net. Users could not say "read this book with the model on my
 * disk" or "never touch the network". These five modes make that explicit.
 */
export type TtsEngineMode = "auto" | "online-first" | "local-first" | "local-only" | "online-only";

export type TtsEngineModeInfo = {
	id: TtsEngineMode;
	label: string;
	/** One sentence shown in the settings page and as the control's tooltip. */
	desc: string;
};

/**
 * The single source of truth for the picker: the settings page, the reading
 * bar and the main process all read this list, so labels never drift apart.
 */
export const TTS_ENGINE_MODES: TtsEngineModeInfo[] = [
	{
		id: "auto",
		label: "自动",
		desc: "优先沿用上次成功的引擎；没有记录时先在线，失败自动换下一个。",
	},
	{
		id: "online-first",
		label: "在线优先",
		desc: "先用在线引擎（免费 Edge → 自建端点），失败才用本地模型。",
	},
	{
		id: "local-first",
		label: "本地优先",
		desc: "先用本地模型，失败才联网。已下载模型时最省心。",
	},
	{
		id: "local-only",
		label: "仅本地",
		desc: "只用本地模型，绝不联网；没有可用模型时直接报错。",
	},
	{
		id: "online-only",
		label: "仅在线",
		desc: "只联网合成，不加载本地模型；在线不可用时直接报错。",
	},
];

export const DEFAULT_TTS_ENGINE_MODE: TtsEngineMode = "auto";

/** Unknown or stale values (older settings.json, hand-edited files) fall back to `auto`. */
export function normalizeTtsEngineMode(raw: string | null | undefined): TtsEngineMode {
	const value = raw?.trim();
	return (TTS_ENGINE_MODES.find((m) => m.id === value)?.id ??
		DEFAULT_TTS_ENGINE_MODE) as TtsEngineMode;
}

export function ttsEngineModeDesc(mode: TtsEngineMode): string {
	return TTS_ENGINE_MODES.find((m) => m.id === mode)?.desc ?? "";
}

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

export type TtsDiagnostics = {
	appVersion: string;
	platform: string;
	modelsRoot: string;
	/** Whether the native sherpa addon can actually be resolved on this machine. */
	sherpaAvailable: boolean;
};

export type TtsInfo = {
	engines: TtsEngineInfo[];
	/** Engine-selection policy currently in effect. */
	mode: TtsEngineMode;
	/** Engine ids the player would try right now, in order (cooldown applied). */
	chain: string[];
	/** Engine that would be used right now, or null when none is available. */
	engineId: string | null;
	voiceId: string | null;
	rate: number;
	cacheBytes: number;
	endpointConfigured: boolean;
	diagnostics: TtsDiagnostics;
};

export type TtsSynthesizeRequest = {
	text: string;
	/**
	 * Ask for one specific engine (voice preview). Its voice ids are engine
	 * scoped, so the main process makes this a one-engine chain instead of
	 * falling back — otherwise a preview could play another engine's voice.
	 */
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
			/** Human label of the engine that produced this audio (surfaced in the bar). */
			engineLabel?: string;
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
