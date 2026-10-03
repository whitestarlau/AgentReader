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
