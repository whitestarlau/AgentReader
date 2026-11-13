import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { app, ipcMain } from "electron";
import type {
	TtsInfo,
	TtsModelProgress,
	TtsModelsPayload,
	TtsSynthesizeReply,
	TtsSynthesizeRequest,
	TtsVoiceGroup,
} from "../../shared/tts.ts";
import { getProviderKey } from "../ai-auth.ts";
import { readSettings, updateSettings } from "../settings.ts";
import { TtsCache } from "./cache.ts";
import { getModel, PREFERRED_MODEL_ID, TTS_MODELS } from "./catalog.ts";
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
import { MockTts } from "./providers/mock.ts";
import { OpenAiCompatibleTts } from "./providers/openai-compatible.ts";
import { type SherpaModelKind, SherpaTts } from "./providers/sherpa.ts";
import { TtsRegistry } from "./registry.ts";
import { toTtsError } from "./types.ts";

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

/** Preferred engine first, then every other configured one (mock is opt-in only). */
function chainFor(registry: TtsRegistry, requested?: string): string[] {
	const available = registry.ids().filter((id) => id !== "mock");
	const settings = readSettings();
	const preferred = [requested, settings.ttsEngine].filter((s): s is string => Boolean(s?.trim()));
	const ordered: string[] = [];
	for (const id of preferred) {
		if (registry.get(id) && !ordered.includes(id)) ordered.push(id);
	}
	for (const id of available) {
		if (!ordered.includes(id)) ordered.push(id);
	}
	return ordered;
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

function defaultVoice(engineId: string, requested?: string): string {
	const voice = requested ?? readSettings().ttsVoice;
	if (voice) return voice;
	if (engineId === "mock") return "mock-zh";
	if (engineId === "sherpa") return "0";
	return "zf_xiaobei";
}

type SynthesizePayload = TtsSynthesizeRequest & {
	/** Preview ignores the cache so a voice change is actually audible. */
	preview?: boolean;
};

async function synthesize(payload: SynthesizePayload): Promise<TtsSynthesizeReply> {
	const text = payload.text?.trim();
	if (!text) return { ok: false, kind: "unsupported", message: "没有可朗读的文本" };

	const registry = buildRegistry();
	const chain = chainFor(registry, payload.engineId);
	if (payload.engineId === "mock") chain.unshift("mock");
	if (chain.length === 0) {
		return { ok: false, kind: "not-configured", message: "还没有配置朗读引擎（设置 → 朗读）" };
	}

	const rate = currentRate(payload.rate);
	const voiceId = payload.voiceId ?? defaultVoice(chain[0] ?? "", payload.voiceId);

	// Cache first: a re-read page or a replayed sentence must not hit the network.
	if (!payload.preview) {
		for (const engineId of chain) {
			const key = cacheKey({ engineId, tag: engineTag(registry, engineId), voiceId, rate, text });
			const hit = ttsCache().read(key);
			if (hit) {
				return {
					ok: true,
					engineId,
					cached: true,
					format: hit.audio.format,
					sampleRate: hit.audio.sampleRate,
					durationMs: hit.durationMs,
					boundaries: hit.boundaries,
					data: hit.audio.data,
				};
			}
		}
	}

	try {
		const outcome = await registry.synthesize(chain, { text, voiceId, rate });
		const engineId = outcome.engineId;
		const result = outcome.result;

		if (!payload.preview) {
			ttsCache().put(
				cacheKey({ engineId, tag: engineTag(registry, engineId), voiceId, rate, text }),
				result,
			);
		}
		return {
			ok: true,
			engineId,
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
		const chain = chainFor(registry);
		return {
			engines: registry.list(),
			engineId: chain[0] ?? null,
			voiceId: settings.ttsVoice ?? null,
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
