import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { secMsGec } from "../edge-token.ts";
import {
	type TtsBoundary,
	type TtsCapabilities,
	type TtsEngine,
	TtsError,
	type TtsRequest,
	type TtsResult,
	type TtsVoice,
} from "../types.ts";

/**
 * Microsoft's free "Read aloud" endpoint, the one Edge's read-aloud feature uses.
 *
 * Free, no key, surprisingly good Chinese voices, and it reports word boundaries
 * — but it is an **unofficial** endpoint: the token scheme has changed twice,
 * there is no SLA, and Microsoft's terms do not bless third-party use. Treat it
 * as a free tier that can disappear: the registry falls back to the local engine
 * when it fails, and the circuit breaker stops retrying it for a while.
 */

const TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
/** Bumped with Edge releases; part of the token contract, not cosmetic. */
const SEC_MS_GEC_VERSION = "2-143.0.3650.96";
const WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const VOICES_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_TOKEN}`;
const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
const ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";

const HEADER_DELIM = "\r\n\r\n";
const AUDIO_DELIM = "Path:audio\r\n";
const CONNECT_TIMEOUT_MS = 6_000;
const SYNTHESIS_TIMEOUT_MS = 60_000;
const VOICE_CACHE_MS = 10 * 60_000;

/** Clock skew, learned once from a 403 response's `Date` header. */
let clockOffsetMs = 0;

type EdgeVoice = {
	ShortName: string;
	Gender?: string;
	Locale?: string;
	FriendlyName?: string;
	VoiceTag?: { VoicePersonalities?: string[] };
};

type MetadataItem = {
	Type?: string;
	Data?: {
		Offset?: number;
		Duration?: number;
		text?: { Text?: string; Length?: number };
	};
};

let voiceCache: { at: number; voices: TtsVoice[] } | null = null;

export type EdgeTtsOptions = {
	id?: string;
	label?: string;
	/** Used when a request carries no voice id. */
	defaultVoice?: string;
};

export class EdgeTts implements TtsEngine {
	readonly id: string;
	readonly label: string;
	private readonly defaultVoice: string;

	constructor(opts: EdgeTtsOptions = {}) {
		this.id = opts.id ?? "edge";
		this.label = opts.label ?? "Edge 朗读（免费）";
		this.defaultVoice = opts.defaultVoice ?? "zh-CN-XiaoxiaoNeural";
	}

	cacheTag(): string {
		// A server-side voice change should invalidate cached audio.
		return `${this.id}|${SEC_MS_GEC_VERSION}`;
	}

	capabilities(): TtsCapabilities {
		return {
			streaming: false,
			boundaries: "word",
			formats: ["mp3"],
			maxCharsPerRequest: 2000,
			offline: false,
			requiresConfig: false,
			rate: true,
			pitch: false,
		};
	}

	async listVoices(): Promise<TtsVoice[]> {
		if (voiceCache && Date.now() - voiceCache.at < VOICE_CACHE_MS) return voiceCache.voices;
		let res: Response;
		try {
			res = await fetch(VOICES_URL, { headers: { "User-Agent": USER_AGENT, Origin: ORIGIN } });
		} catch (e) {
			throw new TtsError("network", `无法获取 Edge 音色：${messageOf(e)}`, {
				engineId: this.id,
				cause: e,
			});
		}
		if (!res.ok) {
			throw new TtsError("network", `获取 Edge 音色失败：HTTP ${res.status}`, {
				engineId: this.id,
				status: res.status,
			});
		}
		const data = (await res.json()) as EdgeVoice[];
		const voices = data
			.filter((v) => v.ShortName)
			.map((v) => ({
				id: v.ShortName,
				name: v.FriendlyName?.replace(/^Microsoft\s+/, "") ?? v.ShortName,
				lang: v.Locale ?? "",
				gender: genderOf(v.Gender),
				styles: v.VoiceTag?.VoicePersonalities,
				offline: false,
			}))
			.sort((a, b) => rank(a.lang) - rank(b.lang));
		voiceCache = { at: Date.now(), voices };
		return voices;
	}

	async synthesize(req: TtsRequest): Promise<TtsResult> {
		if (!req.text.trim()) {
			throw new TtsError("unsupported", "没有可朗读的文本", { engineId: this.id });
		}
		if (req.signal?.aborted) throw new TtsError("aborted", "已取消", { engineId: this.id });
		const voice = req.voiceId || this.defaultVoice;

		try {
			return await this.requestOnce(req, voice);
		} catch (e) {
			// A 403 usually means the local clock drifted out of the 5-minute
			// window; the response carries the server time, so retry once with it.
			const skew = e as { status?: number; serverDate?: string };
			const serverMs = skew.serverDate ? Date.parse(skew.serverDate) : Number.NaN;
			if (skew.status === 403 && Number.isFinite(serverMs)) {
				clockOffsetMs = serverMs - Date.now();
				return this.requestOnce(req, voice).catch((retry) => {
					throw toTtsError(retry, this.id);
				});
			}
			throw toTtsError(e, this.id);
		}
	}

	private requestOnce(req: TtsRequest, voice: string): Promise<TtsResult> {
		const url = `${WSS_URL}?TrustedClientToken=${TRUSTED_TOKEN}&Sec-MS-GEC=${secMsGec(TRUSTED_TOKEN, clockOffsetMs)}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${randomUUID().replace(/-/g, "")}`;

		return new Promise<TtsResult>((resolve, reject) => {
			const ws = new WebSocket(url, { headers: { "User-Agent": USER_AGENT, Origin: ORIGIN } });
			const audio: Buffer[] = [];
			const metadata: MetadataItem[] = [];
			let settled = false;

			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				req.signal?.removeEventListener("abort", onAbort);
				try {
					ws.close();
				} catch {
					// already closed
				}
				fn();
			};

			const timer = setTimeout(() => {
				finish(() => reject(new TtsError("network", "Edge 朗读超时", { engineId: "edge" })));
			}, SYNTHESIS_TIMEOUT_MS);

			const onAbort = () => {
				finish(() => reject(new TtsError("aborted", "已取消", { engineId: "edge" })));
			};
			req.signal?.addEventListener("abort", onAbort, { once: true });

			ws.on(
				"unexpected-response",
				(
					_request: unknown,
					response: { statusCode?: number; headers: { date?: string }; destroy: () => void },
				) => {
					const error = new TtsError(
						"network",
						`Edge 朗读握手失败：HTTP ${response.statusCode ?? "?"}`,
						{
							engineId: "edge",
							status: response.statusCode,
						},
					);
					Object.assign(error, { serverDate: response.headers.date });
					finish(() => reject(error));
					response.destroy();
				},
			);

			ws.on("error", (e: Error) => {
				finish(() =>
					reject(
						new TtsError("network", `Edge 朗读连接错误：${e.message}`, {
							engineId: "edge",
							cause: e,
						}),
					),
				);
			});

			ws.on("open", () => {
				const config = {
					context: {
						synthesis: {
							audio: {
								metadataoptions: { sentenceBoundaryEnabled: "true", wordBoundaryEnabled: "true" },
								outputFormat: "audio-24khz-48kbitrate-mono-mp3",
							},
						},
					},
				};
				ws.send(
					`X-Timestamp:${new Date().toString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config${HEADER_DELIM}${JSON.stringify(config)}`,
				);
				ws.send(
					`X-RequestId:${randomUUID().replace(/-/g, "")}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toString()}\r\nPath:ssml${HEADER_DELIM}${buildSsml(req, voice)}`,
				);
			});

			ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
				if (!isBinary) {
					const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
					if (text.includes("Path:audio.metadata")) {
						const at = text.indexOf(HEADER_DELIM);
						if (at >= 0) {
							try {
								const parsed = JSON.parse(text.slice(at + HEADER_DELIM.length)) as {
									Metadata?: MetadataItem[];
								};
								if (parsed.Metadata) metadata.push(...parsed.Metadata);
							} catch {
								// ignore malformed metadata
							}
						}
					} else if (text.includes("Path:turn.end")) {
						finish(() =>
							resolve({
								audio: { format: "mp3", sampleRate: 24_000, data: Buffer.concat(audio) },
								boundaries: toBoundaries(metadata, req.text),
								firstAudioMs: undefined,
							}),
						);
					}
					return;
				}
				const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
				const at = buf.indexOf(AUDIO_DELIM);
				if (at >= 0) audio.push(buf.subarray(at + AUDIO_DELIM.length));
			});

			ws.on("close", () => {
				finish(() => reject(new TtsError("network", "Edge 朗读连接被关闭", { engineId: "edge" })));
			});

			// Guard the handshake: a black-holed connection would otherwise sit here.
			setTimeout(() => {
				if (ws.readyState === WebSocket.CONNECTING) {
					finish(() => reject(new TtsError("network", "Edge 朗读连接超时", { engineId: "edge" })));
				}
			}, CONNECT_TIMEOUT_MS);
		});
	}
}

function buildSsml(req: TtsRequest, voice: string): string {
	const lang = req.lang ?? (/^zh/i.test(voice) ? "zh-CN" : "en-US");
	const rate = Math.min(2, Math.max(0.5, req.rate ?? 1));
	const ratePct = `${rate >= 1 ? "+" : ""}${Math.round((rate - 1) * 100)}%`;
	return [
		`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>`,
		`<voice name='${escapeXml(voice)}'><prosody rate='${ratePct}'>${escapeXml(req.text)}</prosody></voice>`,
		"</speak>",
	].join("");
}

/** Edge reports word/sentence boundaries; map them back onto the request text. */
function toBoundaries(metadata: MetadataItem[], text: string): TtsBoundary[] {
	const out: TtsBoundary[] = [];
	let cursor = 0;
	for (const item of metadata) {
		const label = item.Data?.text?.Text ?? "";
		const offset = item.Data?.Offset ?? 0;
		const duration = item.Data?.Duration ?? 0;
		if (!label) continue;
		const at = text.indexOf(label, Math.max(0, cursor - 4));
		const start = at >= 0 ? at : cursor;
		if (at >= 0) cursor = at + label.length;
		out.push({
			kind: item.Type === "SentenceBoundary" ? "sentence" : "word",
			textStart: start,
			textLength: label.length,
			// 100-nanosecond units.
			audioStartMs: offset / 10_000,
			audioDurationMs: duration / 10_000,
		});
	}
	return out.sort((a, b) => a.audioStartMs - b.audioStartMs);
}

function rank(lang: string): number {
	if (lang === "zh-CN") return 0;
	if (lang.startsWith("zh")) return 1;
	if (lang.startsWith("en")) return 2;
	return 3;
}

function genderOf(gender: string | undefined): "female" | "male" | "neutral" | undefined {
	if (gender === "Female") return "female";
	if (gender === "Male") return "male";
	return undefined;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function toTtsError(e: unknown, engineId: string): TtsError {
	if (e instanceof TtsError) return e;
	return new TtsError("network", messageOf(e), { engineId, cause: e });
}

function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
