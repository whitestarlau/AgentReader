import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { app, ipcMain } from "electron";
import {
	normalizeTtsEngineMode,
	type TtsEngineMode,
	type TtsInfo,
	type TtsModelProgress,
	type TtsModelsPayload,
	type TtsSynthesizeReply,
	type TtsSynthesizeRequest,
	type TtsVoiceGroup,
} from "../../shared/tts.ts";
import { getProviderKey } from "../ai-auth.ts";
import { readSettings, updateSettings } from "../settings.ts";
import { TtsCache } from "./cache.ts";
import { getModel, PREFERRED_MODEL_ID, TTS_MODELS } from "./catalog.ts";
import { buildChain, emptyChainMessage } from "./chain.ts";
import { cacheKey } from "./keys.ts";
import {
	cancelDownload,
	downloadModel,
	installedBytes,
	installedModels,
	isDownloading,
	isInstalled,
	modelDir,
	removeModel,
} from "./models.ts";
import { EdgeTts } from "./providers/edge.ts";
import { MockTts } from "./providers/mock.ts";
import { OpenAiCompatibleTts } from "./providers/openai-compatible.ts";
import { type SherpaModelKind, SherpaTts } from "./providers/sherpa.ts";
import { TtsRegistry } from "./registry.ts";
import { toTtsError } from "./types.ts";
import { resolveVoiceId } from "./voices.ts";

/**
 * Electron wiring for read-aloud: builds the engine registry from settings and
 * exposes one narrow IPC surface to the renderer.
 *
 * Engines are rebuilt per call (settings are a small JSON file) so switching
 * endpoint/voice in settings takes effect without an app restart. The audio
 * cache is process-wide and shared across documents.
 */

/** Can the native addon be resolved here? (It is a runtime dependency, not bundled.) */
function sherpaAvailable(): boolean {
	try {
		createRequire(import.meta.url).resolve("sherpa-onnx-node");
		return true;
	} catch {
		return false;
	}
}

/** Where downloaded models live. */
function modelsRoot(): string {
	return join(app.getPath("userData"), "tts-models");
}

let cache: TtsCache | null = null;

/**
 * Engine that last produced audio in this app run.
 *
 * `auto` mode starts there: after the free online tier fails once, every later
 * sentence should go straight to the local model instead of paying the connect
 * timeout again (the circuit breaker only covers a minute). In memory on
 * purpose — one run's luck should not decide the next launch.
 */
let lastGoodEngine: string | null = null;

function ttsCache(): TtsCache {
	if (!cache) {
		const maxMb = Number(readSettings().ttsCacheMb) || 500;
		cache = new TtsCache(join(app.getPath("userData"), "tts-cache"), maxMb * 1024 * 1024);
	}
	return cache;
}

function buildRegistry(): TtsRegistry {
	const settings = readSettings();
	const registry = new TtsRegistry();

	// Free tier first: best voices for nothing, with the local engine as fallback
	// when Microsoft's endpoint is unavailable (the registry circuit-breaks it).
	registry.register(new EdgeTts());

	const endpoint = settings.ttsEndpoint?.trim();
	if (endpoint) {
		registry.register(
			new OpenAiCompatibleTts({
				id: "openai-compatible",
				label: "OpenAI 兼容 TTS",
				baseUrl: endpoint,
				apiKey: getProviderKey("tts"),
				model: settings.ttsModel?.trim() || "kokoro",
				defaultVoice: settings.ttsVoice?.trim() || "zf_xiaobei",
				voices: parseList(settings.ttsVoices),
				lang: settings.ttsLang?.trim() || "zh-CN",
				maxCharsPerRequest: Number(settings.ttsMaxChars) || 4000,
			}),
		);
	}
	const sherpa = resolveSherpa();
	if (sherpa) {
		registry.register(
			new SherpaTts({
				modelDir: sherpa.modelDir,
				kind: sherpa.kind,
				vocoder: sherpa.vocoder,
				numThreads: Number(settings.ttsSherpaThreads) || undefined,
				lang: settings.ttsLang?.trim() || undefined,
			}),
		);
	}
	if (settings.ttsEnableMock === "1") registry.register(new MockTts());
	return registry;
}

type ResolvedSherpa = {
	modelDir: string;
	vocoder?: string;
	kind: SherpaModelKind;
	catalogId?: string;
};

/**
 * Where the local engine gets its model.
 *
 * Precedence: an explicit directory from settings (advanced users), then the
 * catalog model the user activated, then the preferred installed one. This is
 * what makes "download in the UI → it just works" true without extra setup.
 */
function resolveSherpa(): ResolvedSherpa | null {
	const settings = readSettings();
	const explicit = settings.ttsSherpaModelDir?.trim();
	if (explicit && existsSync(explicit)) {
		return {
			modelDir: explicit,
			vocoder: settings.ttsSherpaVocoder?.trim() || undefined,
			kind: (settings.ttsSherpaKind as SherpaModelKind | undefined) ?? "auto",
		};
	}

	const installed = installedModels(modelsRoot());
	if (installed.length === 0) return null;
	const chosen =
		installed.find((m) => m.id === settings.ttsModelPreset) ??
		installed.find((m) => m.id === PREFERRED_MODEL_ID) ??
		installed[0];
	if (!chosen) return null;
	return {
		modelDir: modelDir(chosen.id, modelsRoot()),
		vocoder: chosen.vocoderName
			? join(modelDir(chosen.id, modelsRoot()), chosen.vocoderName)
			: undefined,
		kind: chosen.family,
		catalogId: chosen.id,
	};
}

function activeCatalogId(): string | null {
	const settings = readSettings();
	if (settings.ttsSherpaModelDir?.trim()) return null;
	const resolved = resolveSherpa();
	return resolved?.catalogId ?? null;
}

function parseList(raw: string | undefined): string[] | undefined {
	const list = raw
		?.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	return list && list.length > 0 ? list : undefined;
}

/**
 * The effective policy: mode from settings, the pinned engine (advanced
 * `ttsEngine` key), the last engine that actually worked, and the request's
 * optional one-off engine.
 */
function resolveChain(
	registry: TtsRegistry,
	requested?: string,
): { mode: TtsEngineMode; chain: string[] } {
	const settings = readSettings();
	const mode = normalizeTtsEngineMode(settings.ttsEngineMode);
	// The silent development engine is reachable by naming it, never by a mode —
	// otherwise `local-only` would happily read a book in silence.
	if (requested === "mock" && registry.get("mock")) return { mode, chain: ["mock"] };
	const chain = buildChain({
		// The ttsEnableMock engine is for development; it must never be chosen
		// implicitly, only by naming it in a request.
		available: registry.ids().filter((id) => id !== "mock"),
		isLocal: (id) => registry.get(id)?.capabilities().offline ?? false,
		mode,
		requested,
		pinned: settings.ttsEngine?.trim() || undefined,
		lastGood: lastGoodEngine,
	});
	return { mode, chain };
}

/** Cache fingerprint of an engine; empty for engines that do not define one. */
function engineTag(registry: TtsRegistry, engineId: string): string {
	return registry.get(engineId)?.cacheTag?.() ?? "";
}

function currentRate(override?: number): number {
	const raw = override ?? Number(readSettings().ttsRate ?? "1");
	if (!Number.isFinite(raw)) return 1;
	return Math.min(2, Math.max(0.5, raw));
}

type SynthesizePayload = TtsSynthesizeRequest & {
	/** Preview ignores the cache so a voice change is actually audible. */
	preview?: boolean;
};

async function synthesize(payload: SynthesizePayload): Promise<TtsSynthesizeReply> {
	const text = payload.text?.trim();
	if (!text) return { ok: false, kind: "unsupported", message: "没有可朗读的文本" };

	const registry = buildRegistry();
	const { mode, chain } = resolveChain(registry, payload.engineId);
	if (chain.length === 0) {
		return { ok: false, kind: "not-configured", message: emptyChainMessage(mode) };
	}

	const settings = readSettings();
	const rate = currentRate(payload.rate);
	// Voice ids are engine scoped, so the id is resolved per engine — otherwise a
	// fallback would hand Edge's neural voice name to the local model (or `0` to
	// Edge) and fail for no good reason.
	const voiceFor = (engineId: string) => resolveVoiceId(engineId, payload.voiceId, settings);
	const labelFor = (engineId: string) => registry.get(engineId)?.label ?? engineId;

	// Cache first: a re-read page or a replayed sentence must not hit the network.
	//
	// Only the engine that is about to speak is consulted. Looking through the
	// whole chain would replay audio from the *other* class — a page cached with
	// Edge would come back as online audio in "本地优先", or worse, in "仅本地".
	const head = registry.preferred(chain);
	if (!payload.preview && head) {
		const key = cacheKey({
			engineId: head,
			tag: engineTag(registry, head),
			voiceId: voiceFor(head),
			rate,
			text,
		});
		const hit = ttsCache().read(key);
		if (hit) {
			return {
				ok: true,
				engineId: head,
				engineLabel: labelFor(head),
				cached: true,
				format: hit.audio.format,
				sampleRate: hit.audio.sampleRate,
				durationMs: hit.durationMs,
				boundaries: hit.boundaries,
				data: hit.audio.data,
			};
		}
	}

	try {
		const outcome = await registry.synthesize(chain, (engineId) => ({
			text,
			voiceId: voiceFor(engineId),
			rate,
		}));
		const engineId = outcome.engineId;
		const result = outcome.result;

		if (!payload.preview) {
			// Remember what actually worked so `auto` can start there next time.
			lastGoodEngine = engineId;
			ttsCache().put(
				cacheKey({
					engineId,
					tag: engineTag(registry, engineId),
					voiceId: voiceFor(engineId),
					rate,
					text,
				}),
				result,
			);
		}
		return {
			ok: true,
			engineId,
			engineLabel: labelFor(engineId),
			cached: false,
			format: result.audio.format,
			sampleRate: result.audio.sampleRate,
			durationMs: result.durationMs,
			boundaries: result.boundaries,
			data: result.audio.data,
		};
	} catch (e) {
		const err = toTtsError(e);
		return { ok: false, kind: err.kind, message: err.message };
	}
}

export function registerTtsIpc() {
	ipcMain.handle("tts:info", (): TtsInfo => {
		const registry = buildRegistry();
		const settings = readSettings();
		const { mode, chain } = resolveChain(registry);
		// Show what a synthesis would really try: an engine that just failed is
		// cooling down, so claiming "现在会用 Edge" would be a lie.
		const order = registry.resolveOrder(chain);
		const head = order[0] ?? null;
		return {
			engines: registry.list(),
			mode,
			chain: order,
			engineId: head,
			voiceId: head ? resolveVoiceId(head, undefined, settings) : null,
			rate: currentRate(),
			cacheBytes: ttsCache().size(),
			endpointConfigured: Boolean(settings.ttsEndpoint),
			diagnostics: {
				appVersion: app.getVersion(),
				platform: process.platform,
				modelsRoot: modelsRoot(),
				sherpaAvailable: sherpaAvailable(),
			},
		};
	});

	ipcMain.handle("tts:voices", async (): Promise<{ groups: TtsVoiceGroup[] }> => {
		const registry = buildRegistry();
		const groups = await registry.allVoices();
		return { groups };
	});

	ipcMain.handle("tts:synthesize", (_e, payload: SynthesizePayload) => synthesize(payload ?? {}));

	ipcMain.handle("tts:speak", (_e, payload: SynthesizePayload) =>
		synthesize({ ...payload, preview: true }),
	);

	ipcMain.handle("tts:models:list", (): TtsModelsPayload => {
		const active = activeCatalogId();
		return {
			modelDir: modelsRoot(),
			models: TTS_MODELS.map((m) => ({
				id: m.id,
				name: m.name,
				desc: m.desc,
				family: m.family,
				license: m.license,
				commercial: m.commercial,
				sizeLabel: m.sizeLabel,
				installed: isInstalled(m, modelsRoot()),
				downloading: isDownloading(m.id),
				active: m.id === active,
				bytesOnDisk: isInstalled(m, modelsRoot()) ? installedBytes(m, modelsRoot()) : 0,
			})),
		};
	});

	ipcMain.handle("tts:models:download", (event, id: string) => {
		const entry = getModel(id);
		if (!entry) return { ok: false, message: "未知模型" };
		if (isDownloading(id)) return { ok: false, message: "该模型正在下载" };
		const send = (p: TtsModelProgress) => {
			if (!event.sender.isDestroyed()) event.sender.send("tts:model:progress", p);
		};
		// Fire and forget: progress and completion arrive as events.
		void downloadModel(entry, send, modelsRoot()).catch((e: unknown) => {
			console.error("[tts] model download failed:", e instanceof Error ? e.message : e);
		});
		return { ok: true };
	});

	ipcMain.handle("tts:models:cancel", (_e, id: string) => cancelDownload(id));

	ipcMain.handle("tts:models:remove", (_e, id: string) => {
		const entry = getModel(id);
		if (!entry) return false;
		removeModel(entry, modelsRoot());
		return true;
	});

	ipcMain.handle("tts:models:activate", (_e, id: string) => {
		const entry = getModel(id);
		if (!entry || !isInstalled(entry, modelsRoot())) return false;
		updateSettings({ ttsModelPreset: id });
		return true;
	});

	ipcMain.handle("tts:cache:clear", () => {
		const before = ttsCache().size();
		ttsCache().clear();
		return { freedBytes: before };
	});

	ipcMain.handle("tts:cache:size", () => ttsCache().size());
}
