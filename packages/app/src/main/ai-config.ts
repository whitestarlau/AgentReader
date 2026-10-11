import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODELS_TEMPLATE, type ModelsFile, parseModelsFile } from "@agentreader/ai";
import { app } from "electron";

export function configPath(): string {
	return join(app.getPath("userData"), "models.json");
}

function modelCachePath(): string {
	return join(app.getPath("userData"), "models-cache.json");
}

export type ReadConfig = {
	path: string;
	text: string;
	file: ModelsFile;
	errors: string[];
	/** False on first run, when the starter template has not been written yet. */
	existed: boolean;
};

export function readConfig(): ReadConfig {
	const p = configPath();
	const existed = existsSync(p);
	const text = existed ? readFileSync(p, "utf-8") : DEFAULT_MODELS_TEMPLATE;
	const parsed = parseModelsFile(text);
	return { path: p, text, file: parsed.file, errors: parsed.errors, existed };
}

/** Validate then write the raw text (preserving user comments when valid). */
export function writeConfigText(text: string): { ok: boolean; errors: string[] } {
	const parsed = parseModelsFile(text);
	if (parsed.errors.length) return { ok: false, errors: parsed.errors };
	writeFileSync(configPath(), text);
	return { ok: true, errors: [] };
}

/** Create models.json on first run, migrating the legacy single-provider settings if present. */
export function ensureConfig(legacy?: { baseUrl?: string; model?: string }): boolean {
	const p = configPath();
	if (existsSync(p)) return false;
	writeFileSync(p, buildInitialConfig(legacy));
	return true;
}

function buildInitialConfig(legacy?: { baseUrl?: string; model?: string }): string {
	if (!legacy || (!legacy.model && !legacy.baseUrl)) return DEFAULT_MODELS_TEMPLATE;
	const baseUrl = (legacy.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
	const model = legacy.model ?? "gpt-4o-mini";
	return `{
  // AgentReader 模型配置。允许 // 注释与尾逗号（JSONC）。
  // 本文件由旧版 settings.json 自动迁移生成，可放心修改。
  // 密钥不要写在这里；请用 apiKeyEnv 引用环境变量，或在「设置」中填写（加密保存）。
  "version": 1,
  "defaultModel": "legacy/${model}",
  "providers": {
    "legacy": {
      "name": "旧版配置",
      "baseUrl": "${baseUrl}",
      "api": "openai-completions",
      "models": [{ "id": "${model}" }]
    }
  }
}
`;
}

export function readModelCache(): Record<string, string[]> {
	const p = modelCachePath();
	if (!existsSync(p)) return {};
	try {
		const parsed = JSON.parse(readFileSync(p, "utf-8"));
		if (parsed && typeof parsed === "object") {
			const out: Record<string, string[]> = {};
			for (const [id, ids] of Object.entries(parsed)) {
				if (Array.isArray(ids)) out[id] = ids.filter((x): x is string => typeof x === "string");
			}
			return out;
		}
	} catch {}
	return {};
}

export function writeModelCache(cache: Record<string, string[]>): void {
	writeFileSync(modelCachePath(), JSON.stringify(cache, null, 2));
}

/** A provider added through the Settings UI, kept out of the AI-editable models.json. */
export type CustomProvider = {
	name?: string;
	baseUrl: string;
	api: "openai-completions";
	models: { id: string }[];
};

function customProvidersPath(): string {
	return join(app.getPath("userData"), "custom-providers.json");
}

export function readCustomProviders(): Record<string, CustomProvider> {
	const p = customProvidersPath();
	if (!existsSync(p)) return {};
	try {
		const parsed = JSON.parse(readFileSync(p, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, CustomProvider> = {};
		for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (!value || typeof value !== "object") continue;
			const v = value as Record<string, unknown>;
			if (typeof v.baseUrl !== "string" || !v.baseUrl) continue;
			const models = Array.isArray(v.models)
				? v.models
						.filter(
							(m): m is { id: string } =>
								Boolean(m) && typeof (m as { id?: unknown }).id === "string",
						)
						.map((m) => ({ id: m.id }))
				: [];
			if (models.length === 0) continue;
			out[id] = {
				name: typeof v.name === "string" ? v.name : undefined,
				baseUrl: v.baseUrl,
				api: "openai-completions",
				models,
			};
		}
		return out;
	} catch {}
	return {};
}

export function writeCustomProviders(data: Record<string, CustomProvider>): void {
	writeFileSync(customProvidersPath(), JSON.stringify(data, null, 2));
}

/** GUI-set per-model overrides (context window / max output), keyed provider → model. */
export type ModelOverrideEntry = { contextWindow?: number; maxTokens?: number };

function modelOverridesPath(): string {
	return join(app.getPath("userData"), "model-overrides.json");
}

function sanitizeOverrideEntry(value: unknown): ModelOverrideEntry | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	const out: ModelOverrideEntry = {};
	if (
		typeof v.contextWindow === "number" &&
		Number.isFinite(v.contextWindow) &&
		v.contextWindow > 0
	) {
		out.contextWindow = Math.floor(v.contextWindow);
	}
	if (typeof v.maxTokens === "number" && Number.isFinite(v.maxTokens) && v.maxTokens > 0) {
		out.maxTokens = Math.floor(v.maxTokens);
	}
	return Object.keys(out).length ? out : null;
}

export function readModelOverrides(): Record<string, Record<string, ModelOverrideEntry>> {
	const p = modelOverridesPath();
	if (!existsSync(p)) return {};
	try {
		const parsed = JSON.parse(readFileSync(p, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, Record<string, ModelOverrideEntry>> = {};
		for (const [providerId, byModel] of Object.entries(parsed as Record<string, unknown>)) {
			if (!byModel || typeof byModel !== "object" || Array.isArray(byModel)) continue;
			const models: Record<string, ModelOverrideEntry> = {};
			for (const [modelId, entry] of Object.entries(byModel as Record<string, unknown>)) {
				const clean = sanitizeOverrideEntry(entry);
				if (clean) models[modelId] = clean;
			}
			if (Object.keys(models).length) out[providerId] = models;
		}
		return out;
	} catch {}
	return {};
}

export function writeModelOverrides(
	data: Record<string, Record<string, ModelOverrideEntry>>,
): void {
	writeFileSync(modelOverridesPath(), JSON.stringify(data, null, 2));
}

/**
 * Replace a model's GUI override. An empty/invalid entry removes it so the
 * model falls back to its catalog/default values.
 */
export function setModelOverride(
	providerId: string,
	modelId: string,
	patch: ModelOverrideEntry,
): void {
	const data = readModelOverrides();
	const clean = sanitizeOverrideEntry(patch);
	if (!data[providerId]) data[providerId] = {};
	if (clean) data[providerId][modelId] = clean;
	else delete data[providerId][modelId];
	if (Object.keys(data[providerId]).length === 0) delete data[providerId];
	writeModelOverrides(data);
}

export function clearModelOverride(providerId: string, modelId: string): void {
	const data = readModelOverrides();
	if (!data[providerId]) return;
	delete data[providerId][modelId];
	if (Object.keys(data[providerId]).length === 0) delete data[providerId];
	writeModelOverrides(data);
}

/** Compact per-model limits sourced from models.dev (see `ai:metadata:sync`). */
export type ModelMetadataEntry = { context?: number; output?: number; reasoning?: boolean };
export type ModelMetadataFile = {
	updatedAt?: number;
	providers: Record<string, Record<string, ModelMetadataEntry>>;
};

function modelMetadataPath(): string {
	return join(app.getPath("userData"), "model-metadata.json");
}

export function readModelMetadata(): ModelMetadataFile {
	const p = modelMetadataPath();
	if (!existsSync(p)) return { providers: {} };
	try {
		const parsed = JSON.parse(readFileSync(p, "utf-8"));
		if (!parsed || typeof parsed !== "object") return { providers: {} };
		const v = parsed as Record<string, unknown>;
		const providers: Record<string, Record<string, ModelMetadataEntry>> = {};
		if (v.providers && typeof v.providers === "object" && !Array.isArray(v.providers)) {
			for (const [providerId, models] of Object.entries(v.providers as Record<string, unknown>)) {
				if (!models || typeof models !== "object" || Array.isArray(models)) continue;
				const map: Record<string, ModelMetadataEntry> = {};
				for (const [modelId, entry] of Object.entries(models as Record<string, unknown>)) {
					if (!entry || typeof entry !== "object") continue;
					const e = entry as Record<string, unknown>;
					const out: ModelMetadataEntry = {};
					if (typeof e.context === "number" && e.context > 0) out.context = Math.floor(e.context);
					if (typeof e.output === "number" && e.output > 0) out.output = Math.floor(e.output);
					if (typeof e.reasoning === "boolean") out.reasoning = e.reasoning;
					if (Object.keys(out).length) map[modelId] = out;
				}
				if (Object.keys(map).length) providers[providerId] = map;
			}
		}
		return {
			updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : undefined,
			providers,
		};
	} catch {}
	return { providers: {} };
}

export function writeModelMetadata(data: ModelMetadataFile): void {
	writeFileSync(modelMetadataPath(), JSON.stringify(data));
}
