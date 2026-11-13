import {
	type AudioFormat,
	type TtsCapabilities,
	type TtsEngine,
	TtsError,
	type TtsRequest,
	type TtsResult,
	type TtsVoice,
} from "../types.ts";

/**
 * Any server that speaks the OpenAI `/v1/audio/speech` shape.
 *
 * One adapter covers a surprising amount of the landscape: OpenAI-compatible
 * cloud endpoints, Kokoro-FastAPI and Speaches running on localhost, and most
 * self-hosted TTS wrappers. Those servers report no timestamps, which is fine —
 * the player synthesizes per sentence, so the queue position is the sync.
 */

export type OpenAiTtsConfig = {
	/** Engine id; defaults to "openai-compatible". */
	id?: string;
	label?: string;
	/** Base URL including the version segment, e.g. `http://127.0.0.1:8880/v1`. */
	baseUrl: string;
	apiKey?: string;
	/** Model name the server expects, e.g. `kokoro` or `tts-1`. */
	model: string;
	/** Voice used when a request does not name one. */
	defaultVoice: string;
	/** Voices offered in the picker when the server cannot enumerate them. */
	voices?: string[];
	lang?: string;
	format?: AudioFormat;
	/** Per-request ceiling the server accepts. */
	maxCharsPerRequest?: number;
	timeoutMs?: number;
};

const DEFAULT_TIMEOUT = 60_000;

export class OpenAiCompatibleTts implements TtsEngine {
	readonly id: string;
	readonly label: string;
	private readonly cfg: OpenAiTtsConfig;

	constructor(cfg: OpenAiTtsConfig) {
		this.cfg = cfg;
		this.id = cfg.id ?? "openai-compatible";
		this.label = cfg.label ?? "OpenAI 兼容 TTS";
	}

	capabilities(): TtsCapabilities {
		return {
			streaming: false,
			boundaries: "none",
			formats: ["mp3", "wav", "pcm16"],
			maxCharsPerRequest: this.cfg.maxCharsPerRequest ?? 4000,
			offline: isLoopback(this.cfg.baseUrl),
			requiresConfig: true,
			rate: true,
			pitch: false,
		};
	}

	/** Endpoint + model identity: switching either must invalidate the cache. */
	cacheTag(): string {
		return [this.id, this.cfg.baseUrl, this.cfg.model].join("|");
	}

	async listVoices(): Promise<TtsVoice[]> {
		if (!this.cfg.baseUrl) {
			throw new TtsError("not-configured", "未配置 TTS 端点", { engineId: this.id });
		}
		const ids = this.cfg.voices?.length ? this.cfg.voices : [this.cfg.defaultVoice];
		return ids.map((id) => ({ id, name: id, lang: this.cfg.lang ?? "zh-CN" }));
	}

	async synthesize(req: TtsRequest): Promise<TtsResult> {
		const base = this.cfg.baseUrl?.replace(/\/+$/, "");
		if (!base) throw new TtsError("not-configured", "未配置 TTS 端点", { engineId: this.id });
		if (!this.cfg.model) {
			throw new TtsError("not-configured", "未配置 TTS 模型名", { engineId: this.id });
		}

		const format = req.format ?? this.cfg.format ?? "mp3";
		const body = {
			model: this.cfg.model,
			input: req.text,
			voice: req.voiceId || this.cfg.defaultVoice,
			response_format: format,
			...(req.rate && req.rate !== 1 ? { speed: req.rate } : {}),
		};
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;

		const timeout = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT;
		const signal = combineSignals(req.signal, AbortSignal.timeout(timeout));

		const started = Date.now();
		let res: Response;
		try {
			res = await fetch(`${base}/audio/speech`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal,
			});
		} catch (e) {
			if (req.signal?.aborted) throw new TtsError("aborted", "已取消", { engineId: this.id });
			throw new TtsError("network", `无法连接 TTS 端点：${errorMessage(e)}`, {
				engineId: this.id,
				cause: e,
			});
		}

		if (!res.ok) {
			const detail = await safeText(res);
			throw new TtsError(
				statusKind(res.status),
				`TTS 端点返回 ${res.status}${detail ? `：${detail}` : ""}`,
				{
					engineId: this.id,
					status: res.status,
				},
			);
		}

		const data = new Uint8Array(await res.arrayBuffer());
		if (data.length === 0) {
			throw new TtsError("internal", "TTS 端点返回了空音频", { engineId: this.id });
		}
		// Trust the bytes over the request: local servers often ignore format hints.
		const actual = sniffFormat(data) ?? format;
		return {
			audio: { format: actual, sampleRate: sampleRateOf(data, actual), data },
			boundaries: [],
			firstAudioMs: Date.now() - started,
		};
	}
}

function isLoopback(url: string): boolean {
	return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url);
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
	if (!a) return b;
	return typeof AbortSignal.any === "function" ? AbortSignal.any([a, b]) : a;
}

function statusKind(status: number): "not-configured" | "rate-limited" | "network" {
	if (status === 401 || status === 403 || status === 404) return "not-configured";
	if (status === 429) return "rate-limited";
	return "network";
}

/** Best-effort format detection so a wrong `response_format` does not corrupt playback. */
function sniffFormat(data: Uint8Array): AudioFormat | null {
	if (data.length < 12) return null;
	const ascii = (at: number, len: number) =>
		String.fromCharCode(...Array.from(data.subarray(at, at + len)));
	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "wav";
	if (ascii(0, 4) === "OggS") return "opus";
	if (ascii(0, 3) === "ID3") return "mp3";
	// MPEG frame sync: 11 set bits.
	if (data[0] === 0xff && ((data[1] ?? 0) & 0xe0) === 0xe0) return "mp3";
	return null;
}

function sampleRateOf(data: Uint8Array, format: AudioFormat): number {
	if (format === "wav" && data.length >= 28) {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		return view.getUint32(24, true);
	}
	// MP3/Opus: the container's rate is not in a fixed header; 24 kHz is the
	// common TTS default and only affects duration estimates before decode.
	return 24_000;
}

async function safeText(res: Response): Promise<string> {
	try {
		const text = await res.text();
		return text.slice(0, 200).replace(/\s+/g, " ").trim();
	} catch {
		return "";
	}
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
