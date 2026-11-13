import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";
import {
	type TtsCapabilities,
	type TtsEngine,
	TtsError,
	type TtsRequest,
	type TtsResult,
	type TtsVoice,
} from "../types.ts";
import { encodeWav } from "../wav.ts";

/**
 * On-device synthesis through `sherpa-onnx`.
 *
 * The model bundle is the unit of configuration: point `modelDir` at an unpacked
 * sherpa model and the family is detected from the filenames. Loading is cached
 * per bundle (a load costs ~1–3 s), and generation is awaited asynchronously so
 * the Electron main process keeps handling IPC while a sentence is synthesized.
 *
 * Shipping note: the adapter is model-agnostic on purpose. MeloTTS (MIT) is the
 * recommended default; several popular Chinese bundles (e.g. matcha Baker, Piper
 * voices) are built on non-commercial data, so the licence has to be checked per
 * bundle before bundling one with the app.
 */

/** The subset of `sherpa-onnx-node` this adapter uses. */
type GeneratedAudio = { samples: Float32Array; sampleRate: number };
type SherpaHandle = {
	numSpeakers: number;
	sampleRate: number;
	lang?: string;
	generateAsync(req: {
		text: string;
		sid?: number;
		speed?: number;
		generationConfig?: unknown;
		/** When true the addon hands back an external ArrayBuffer. Electron forbids those. */
		enableExternalBuffer?: boolean;
		onProgress?: (info: {
			samples: Float32Array;
			progress: number;
		}) => number | boolean | undefined;
	}): Promise<GeneratedAudio>;
};
type SherpaModule = {
	OfflineTts: {
		new (config: unknown): SherpaHandle;
		createAsync?: (config: unknown) => Promise<SherpaHandle>;
	};
	/** Newer addon API: sid/speed travel in a config object. */
	GenerationConfig?: new (opts: {
		sid?: number;
		speed?: number;
		silenceScale?: number;
	}) => unknown;
};

export type SherpaModelKind = "auto" | "vits" | "matcha" | "kokoro";

export type SherpaTtsConfig = {
	id?: string;
	label?: string;
	/** Unpacked model bundle directory. */
	modelDir: string;
	/** Model family; detected from filenames when omitted. */
	kind?: SherpaModelKind;
	/** Vocoder file for matcha models (required by that family). */
	vocoder?: string;
	/** Overrides auto-detected rule fsts (date/number/phone normalisation). */
	ruleFsts?: string;
	numThreads?: number;
	/** Default speaker when a request does not name one. */
	sid?: number;
	lang?: string;
};

/**
 * Shared runtime knobs. They must live inside `model`, not at the top level:
 * a top-level `numThreads` is silently ignored and synthesis ends up
 * single-threaded (~3x slower on the same model).
 */
const MODEL_RUNTIME = { provider: "cpu", debug: false } as const;

const MODEL_CACHE_LIMIT = 2;
const handles = new Map<string, Promise<SherpaHandle>>();

/**
 * One generation at a time per model handle.
 *
 * Not because overlapping calls are broken (they are not), but because each call
 * already uses `numThreads` threads: the player prefetches the next sentences, and
 * parallel generations would fight over the same P-cores. Serializing keeps
 * throughput steady and makes cancellation ordering deterministic.
 */
const gates = new WeakMap<SherpaHandle, Promise<void>>();

async function withGate<T>(handle: SherpaHandle, fn: () => Promise<T>): Promise<T> {
	const previous = gates.get(handle) ?? Promise.resolve();
	let release: () => void = () => {};
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	gates.set(
		handle,
		previous.then(() => current),
	);
	await previous;
	try {
		return await fn();
	} finally {
		release();
	}
}

/** A cheap, readable identity for a bundle + its load options. */
function signatureOf(cfg: SherpaTtsConfig): string {
	return [
		cfg.modelDir,
		cfg.kind ?? "auto",
		cfg.vocoder ?? "",
		cfg.ruleFsts ?? "",
		cfg.numThreads ?? "",
	].join("|");
}

/** Detect the model family from the file names in an unpacked bundle. */
export function detectModelKind(files: string[]): "vits" | "matcha" | "kokoro" | "unknown" {
	if (files.some((f) => /^(acoustic.*|model-steps-.*)\.onnx$/.test(f))) return "matcha";
	if (files.includes("voices.bin") || files.some((f) => f.startsWith("kokoro"))) return "kokoro";
	if (files.some((f) => /^model(-int8|-fp16)?\.onnx$/.test(f) || /^model\.onnx$/.test(f)))
		return "vits";
	// MeloTTS/piper bundles name the graph `model.onnx`; anything else with a
	// single onnx file is most likely a VITS conversion.
	if (files.some((f) => f.endsWith(".onnx"))) return "vits";
	return "unknown";
}

/**
 * Pick the acoustic model file.
 *
 * Some bundles ship `model.int8.onnx` as a 133-byte Git-LFS pointer instead of
 * real weights, so size is part of the decision and not just the name.
 */
export function pickModelFile(files: { name: string; size: number }[]): string | null {
	// Anything under ~1 MB named `.onnx` is a Git-LFS pointer, not weights.
	const big = files.filter((f) => f.name.endsWith(".onnx") && f.size > 1_000_000);
	const named = (name: string) => big.find((f) => f.name === name)?.name;
	return (
		named("model.onnx") ??
		named("model.int8.onnx") ??
		big.find((f) => f.name.startsWith("model"))?.name ??
		big[0]?.name ??
		null
	);
}

export class SherpaTts implements TtsEngine {
	readonly id: string;
	readonly label: string;
	private readonly cfg: SherpaTtsConfig;

	constructor(cfg: SherpaTtsConfig) {
		this.cfg = cfg;
		this.id = cfg.id ?? "sherpa";
		this.label = cfg.label ?? "sherpa-onnx（本地）";
	}

	capabilities(): TtsCapabilities {
		return {
			streaming: false,
			boundaries: "sentence",
			formats: ["wav"],
			maxCharsPerRequest: 600,
			offline: true,
			requiresConfig: true,
			rate: true,
			pitch: false,
		};
	}

	/** Model bundle identity: a different model must not reuse cached audio. */
	cacheTag(): string {
		return [this.id, this.cfg.modelDir, this.cfg.vocoder ?? "", this.cfg.kind ?? "auto"].join("|");
	}

	async listVoices(): Promise<TtsVoice[]> {
		const handle = await this.load();
		// Model metadata is unreliable for language (the Chinese matcha bundle
		// reports "en-us"), so the setting wins and Chinese is the safe default.
		const lang = this.cfg.lang ?? "zh-CN";
		const name = basename(this.cfg.modelDir) || "本地模型";
		const count = Math.max(1, handle.numSpeakers);
		if (count === 1) return [{ id: "0", name, lang, offline: true }];
		// A 100+ entry picker is more usable with short names; the model name is
		// already visible in the engine group.
		return Array.from({ length: count }, (_, i) => ({
			id: String(i),
			name: `音色 ${i + 1}`,
			lang,
			offline: true,
		}));
	}

	async synthesize(req: TtsRequest): Promise<TtsResult> {
		if (!req.text.trim()) {
			throw new TtsError("unsupported", "没有可朗读的文本", { engineId: this.id });
		}
		if (req.signal?.aborted) throw new TtsError("aborted", "已取消", { engineId: this.id });

		const handle = await this.load();
		const started = Date.now();
		const sid = resolveSid(req.voiceId, this.cfg.sid ?? 0, handle.numSpeakers);
		const speed = Math.min(2, Math.max(0.5, req.rate ?? 1));

		let aborted = false;
		let audio: GeneratedAudio;
		const mod = loadModule();
		const generationConfig = mod.GenerationConfig
			? new mod.GenerationConfig({ sid, speed })
			: undefined;
		try {
			// Queue behind any in-flight generation (one call already uses every
			// configured thread) and give up early if the request was cancelled.
			await waitForTurn(req.signal);
			audio = await withGate(handle, () =>
				handle.generateAsync({
					text: req.text,
					// Electron (V8 embedder) rejects external ArrayBuffers, so the
					// addon must copy the samples: without this it fails with the
					// opaque "TTS settlement failed" (async) / "External buffers are
					// not allowed" (sync). Plain Node accepts them, which is why
					// unit tests pass while the app does not.
					enableExternalBuffer: false,
					// Legacy path keeps working when the addon has no GenerationConfig.
					...(generationConfig ? { generationConfig } : { sid, speed }),
					// Returning 0 stops the C++ generator early; we use it as the
					// cancellation hook because the addon has no AbortSignal support.
					onProgress: () => {
						if (req.signal?.aborted) {
							aborted = true;
							return 0;
						}
						return 1;
					},
				}),
			);
		} catch (e) {
			if (req.signal?.aborted || aborted) {
				throw new TtsError("aborted", "已取消", { engineId: this.id });
			}
			throw new TtsError("internal", `本地合成失败：${messageOf(e)}`, {
				engineId: this.id,
				cause: e,
			});
		}
		if (aborted || req.signal?.aborted) {
			throw new TtsError("aborted", "已取消", { engineId: this.id });
		}
		if (!audio.samples?.length) {
			throw new TtsError("internal", "本地模型没有产生音频", { engineId: this.id });
		}

		const durationMs = (audio.samples.length / audio.sampleRate) * 1000;
		return {
			audio: {
				format: "wav",
				sampleRate: audio.sampleRate,
				data: encodeWav(audio.samples, audio.sampleRate),
			},
			// Exact by construction: we synthesize exactly this request's text.
			boundaries: [
				{
					kind: "sentence",
					textStart: 0,
					textLength: req.text.length,
					audioStartMs: 0,
					audioDurationMs: durationMs,
				},
			],
			durationMs,
			firstAudioMs: Date.now() - started,
		};
	}

	/** Load (or reuse) the model handle for this bundle. */
	private async load(): Promise<SherpaHandle> {
		const sig = signatureOf(this.cfg);
		const cached = handles.get(sig);
		if (cached) return cached;

		const pending = (async () => {
			const config = buildConfig(this.cfg);
			const mod = loadModule();
			try {
				if (typeof mod.OfflineTts.createAsync === "function") {
					return await mod.OfflineTts.createAsync(config);
				}
				return new mod.OfflineTts(config);
			} catch (e) {
				throw new TtsError("not-configured", `加载本地模型失败：${messageOf(e)}`, {
					engineId: this.id,
					cause: e,
				});
			}
		})().catch((e) => {
			handles.delete(sig);
			throw e;
		});

		handles.set(sig, pending);
		// Keep memory bounded when the user switches between bundles.
		while (handles.size > MODEL_CACHE_LIMIT) {
			const oldest = handles.keys().next().value;
			if (oldest === undefined) break;
			handles.delete(oldest);
		}
		return pending;
	}
}

/** Give up while still queued, instead of waiting for a long generation. */
function waitForTurn(signal?: AbortSignal): Promise<void> {
	if (!signal) return Promise.resolve();
	if (signal.aborted) {
		return Promise.reject(new TtsError("aborted", "已取消", { engineId: "sherpa" }));
	}
	return new Promise<void>((resolve) => {
		const done = () => {
			signal.removeEventListener("abort", done);
			resolve();
		};
		signal.addEventListener("abort", done, { once: true });
	});
}

/** Build the `OfflineTts` config object for a bundle. */
export function buildConfig(cfg: SherpaTtsConfig): Record<string, unknown> {
	if (!cfg.modelDir || !existsSync(cfg.modelDir)) {
		throw new TtsError("not-configured", `本地模型目录不存在：${cfg.modelDir || "(空)"}`, {
			engineId: cfg.id ?? "sherpa",
		});
	}
	const files = listFiles(cfg.modelDir);
	const kind =
		cfg.kind && cfg.kind !== "auto" ? cfg.kind : detectModelKind(files.map((f) => f.name));
	if (kind === "unknown") {
		throw new TtsError("not-configured", `无法识别模型类型：${cfg.modelDir}`, {
			engineId: "sherpa",
		});
	}
	if (kind === "kokoro") {
		throw new TtsError("unsupported", "Kokoro 模型暂未接入（先支持 VITS / Matcha）", {
			engineId: "sherpa",
		});
	}

	const tokens = join(cfg.modelDir, "tokens.txt");
	const lexicon = join(cfg.modelDir, "lexicon.txt");
	const ruleFsts = cfg.ruleFsts ?? detectRuleFsts(cfg.modelDir);
	const numThreads = clampThreads(cfg.numThreads);

	if (kind === "matcha") {
		const acoustic = pickModelFile(files);
		const vocoder = cfg.vocoder ?? detectVocoder(cfg.modelDir);
		if (!acoustic) {
			throw new TtsError("not-configured", "找不到 matcha 声学模型（*.onnx）", {
				engineId: "sherpa",
			});
		}
		if (!vocoder) {
			throw new TtsError("not-configured", "matcha 模型需要 vocoder（如 vocos-22khz-univ.onnx）", {
				engineId: "sherpa",
			});
		}
		return {
			model: {
				matcha: {
					acousticModel: join(cfg.modelDir, acoustic),
					vocoder,
					lexicon: existsSync(lexicon) ? lexicon : undefined,
					tokens,
				},
				...MODEL_RUNTIME,
				numThreads,
			},
			maxNumSentences: 1,
			...(ruleFsts ? { ruleFsts } : {}),
		};
	}

	const model = pickModelFile(files);
	if (!model) {
		throw new TtsError("not-configured", "找不到模型文件（model.onnx）", { engineId: "sherpa" });
	}
	return {
		model: {
			vits: {
				model: join(cfg.modelDir, model),
				lexicon: existsSync(lexicon) ? lexicon : undefined,
				tokens,
			},
			...MODEL_RUNTIME,
			numThreads,
		},
		maxNumSentences: 1,
		...(ruleFsts ? { ruleFsts } : {}),
	};
}

function loadModule(): SherpaModule {
	const req = createRequire(import.meta.url);
	let mod: unknown;
	try {
		mod = req("sherpa-onnx-node");
	} catch (e) {
		throw new TtsError("not-configured", `未安装 sherpa-onnx-node：${messageOf(e)}`, { cause: e });
	}
	const candidate = mod as SherpaModule & { default?: SherpaModule };
	const withTts = candidate.OfflineTts ? candidate : candidate.default;
	if (!withTts?.OfflineTts) {
		throw new TtsError("not-configured", "sherpa-onnx-node 缺少 OfflineTts 导出");
	}
	return withTts;
}

function listFiles(dir: string): { name: string; size: number }[] {
	try {
		return readdirSync(dir)
			.filter((name) => !name.startsWith("."))
			.map((name) => {
				try {
					return { name, size: statSync(join(dir, name)).size };
				} catch {
					return { name, size: 0 };
				}
			});
	} catch {
		return [];
	}
}

function detectRuleFsts(dir: string): string {
	const wanted = ["date.fst", "number.fst", "phone.fst"].filter((f) => existsSync(join(dir, f)));
	return wanted.map((f) => join(dir, f)).join(",");
}

function detectVocoder(dir: string): string | undefined {
	for (const name of ["vocoder.onnx", "vocos-22khz-univ.onnx"]) {
		if (existsSync(join(dir, name))) return join(dir, name);
	}
	// The docs tell users to drop the vocoder next to the model directory.
	const parent = join(dir, "..");
	for (const name of ["vocos-22khz-univ.onnx", "vocoder.onnx"]) {
		if (existsSync(join(parent, name))) return join(parent, name);
	}
	return undefined;
}

function clampThreads(n?: number): number {
	const ceiling = Math.max(1, Math.min(4, availableParallelism?.() ?? 4));
	if (!n || !Number.isFinite(n)) return ceiling;
	return Math.min(ceiling, Math.max(1, Math.floor(n)));
}

function resolveSid(voiceId: string | undefined, fallback: number, numSpeakers: number): number {
	const parsed = voiceId !== undefined && voiceId !== "" ? Number(voiceId) : Number.NaN;
	const sid = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
	if (sid < 0 || sid >= Math.max(1, numSpeakers)) return 0;
	return sid;
}

function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
