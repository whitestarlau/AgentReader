import {
	createModelRuntime,
	getBuiltinProvider,
	type Model,
	type ModelRuntime,
	type ModelsFile,
	type WebSearchBackend,
} from "@agentreader/ai";
import { ipcMain, shell } from "electron";
import { getProviderKey, hasStoredKey, setProviderKey } from "./ai-auth.ts";
import {
	type CustomProvider,
	configPath,
	ensureConfig,
	readConfig,
	readCustomProviders,
	readModelCache,
	writeConfigText,
	writeCustomProviders,
	writeModelCache,
} from "./ai-config.ts";
import { readSettings, updateSettings } from "./settings.ts";
import { BACKEND_ENV, searchWeb } from "./web-search.ts";

/** Provider/model runtime: config loading, current-model resolution, AI IPC. */

/** Merge GUI-managed custom providers under the models.json providers (file wins on id conflict). */
export function mergeCustomProviders(
	file: ModelsFile,
	custom: Record<string, CustomProvider>,
): ModelsFile {
	const declared =
		file.providers && typeof file.providers === "object" && !Array.isArray(file.providers)
			? file.providers
			: {};
	return { ...file, providers: { ...custom, ...declared } };
}

/** Build a model runtime from models.json + GUI providers + the encrypted auth store + env. */
export function buildRuntime(): {
	runtime: ModelRuntime;
	file: ModelsFile;
	custom: Record<string, CustomProvider>;
} {
	const cfg = readConfig();
	const custom = readCustomProviders();
	const file = mergeCustomProviders(cfg.file, custom);
	const runtime = createModelRuntime({
		file,
		configErrors: cfg.errors,
		modelCache: readModelCache(),
		resolveSecret: (providerId, provider) => {
			const stored = getProviderKey(providerId);
			if (stored) return stored;
			for (const env of provider.envVars) {
				const value = process.env[env];
				if (value) return value;
			}
			return undefined;
		},
	});
	return { runtime, file, custom };
}

/** Current model: app-selected ref → models.json defaultModel → first available. */
export function resolveCurrentModel(runtime: ModelRuntime, file: ModelsFile): Model | undefined {
	const settings = readSettings();
	return (
		runtime.getModel(settings.model) ?? runtime.getModel(file.defaultModel) ?? runtime.models[0]
	);
}

export function modelRef(model: Model): string {
	return `${model.provider}/${model.id}`;
}

/** Max tool-calling rounds per user turn (settings.json `agentMaxTurns`, default 8). */
export function getAgentMaxTurns(): number {
	const raw = Number(readSettings().agentMaxTurns);
	if (Number.isFinite(raw) && raw >= 1) return Math.min(20, Math.max(1, Math.floor(raw)));
	return 8;
}

export const WEB_SEARCH_BACKENDS: readonly WebSearchBackend[] = [
	"auto",
	"exa-mcp",
	"parallel-mcp",
	"brave",
	"tavily",
	"exa",
	"duckduckgo",
	"native",
];

export type WebSearchRuntime = {
	enabled: boolean;
	backend: WebSearchBackend;
	maxResults: number;
	key?: string;
	keySource: "config" | "env" | "stored" | null;
};

/**
 * Resolve web search config. GUI-managed values live in settings.json and take
 * precedence over models.json so the comment-preserving config is never rewritten.
 */
export function getWebSearchConfig(): WebSearchRuntime {
	const settings = readSettings();
	const fromFile = readConfig().file.tools?.webSearch ?? {};
	const enabled =
		settings.webSearchEnabled !== undefined
			? settings.webSearchEnabled === "1"
			: fromFile.enabled === true;
	const rawBackend = settings.webSearchBackend || fromFile.backend || "auto";
	const backend = (WEB_SEARCH_BACKENDS as readonly string[]).includes(rawBackend)
		? (rawBackend as WebSearchBackend)
		: "auto";
	const rawMax = Number(settings.webSearchMaxResults ?? fromFile.maxResults ?? 5);
	const maxResults = Number.isFinite(rawMax) ? Math.max(1, Math.min(10, rawMax)) : 5;

	let key: string | undefined;
	let keySource: WebSearchRuntime["keySource"] = null;
	if (typeof fromFile.apiKey === "string" && fromFile.apiKey) {
		key = fromFile.apiKey;
		keySource = "config";
	}
	const declaredEnv = typeof fromFile.apiKeyEnv === "string" ? fromFile.apiKeyEnv : undefined;
	const envVar = declaredEnv ?? BACKEND_ENV[backend];
	if (!key && envVar && process.env[envVar]) {
		key = process.env[envVar];
		keySource = "env";
	}
	const stored = getProviderKey(`websearch:${backend}`);
	if (!key && stored) {
		key = stored;
		keySource = "stored";
	}
	return { enabled, backend, maxResults, key, keySource };
}

/** Strip code fences, wrapping quotes, and trailing punctuation from a model reply. */
function cleanTitle(input: string): string {
	const lastLine = input
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.pop();
	const base = (lastLine ?? input).trim();
	return base
		.replace(/^```[\s\S]*?\n|```$/g, "")
		.replace(/^["“”'‘’《【\s]+|["“”'‘’》】\s]+$/g, "")
		.replace(/^(标题|title)\s*[:：]\s*/i, "")
		.replace(/[。.,，!！?？、；;：:\n\r]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Ask the model for a short title summarizing the conversation's first message.
 * Returns the cleaned title, or null if anything goes wrong (the caller then
 * keeps the placeholder title).
 */
export async function generateConversationTitle(
	runtime: ModelRuntime,
	model: Model,
	userPrompt: string,
): Promise<string | null> {
	if (!runtime.resolveApiKey(model.provider)) return null;
	let raw = "";
	let reasoning = "";
	try {
		for await (const evt of runtime.stream(
			model,
			{
				systemPrompt:
					"你是对话命名助手。请根据用户的第一条消息，用简短的中文（或与用户语言一致）为这次对话起一个标题。只输出标题本身，不要引号、不要标点、不要解释，最多 12 个字。",
				messages: [{ role: "user", content: userPrompt.slice(0, 400) }],
			},
			{ maxTokens: 512, temperature: 0.3 },
		)) {
			if (evt.type === "text_delta") raw += evt.delta;
			else if (evt.type === "reasoning_delta") reasoning += evt.delta;
			else if (evt.type === "done") break;
		}
	} catch {
		return null;
	}
	// Reasoning models may put the answer in content; if content is empty, the
	// last non-empty line of the reasoning often still carries the title.
	const source = raw.trim() || reasoning.trim();
	let title = cleanTitle(source);
	if (!title) return null;
	if (title.length > 24) title = title.slice(0, 24);
	return title || null;
}

type ProviderSummary = {
	id: string;
	name: string;
	baseUrl: string;
	api: string;
	isBuiltin: boolean;
	source: "builtin" | "file" | "gui";
	configured: boolean;
	keySource: "stored" | "env" | null;
	modelCount: number;
};

function buildConfigPayload() {
	const cfg = readConfig();
	const { runtime, file, custom } = buildRuntime();
	const declared =
		cfg.file.providers &&
		typeof cfg.file.providers === "object" &&
		!Array.isArray(cfg.file.providers)
			? cfg.file.providers
			: {};
	const providers: ProviderSummary[] = runtime.providers.map((p) => {
		const envVar = p.envVars.find((e) => process.env[e]);
		const stored = hasStoredKey(p.id);
		return {
			id: p.id,
			name: p.name,
			baseUrl: p.baseUrl,
			api: p.api,
			isBuiltin: p.isBuiltin,
			source: p.isBuiltin ? "builtin" : declared[p.id] ? "file" : custom[p.id] ? "gui" : "builtin",
			configured: Boolean(p.apiKey || stored || envVar),
			keySource: stored ? "stored" : envVar ? "env" : null,
			modelCount: p.models.length,
		};
	});
	const configuredById = new Map(providers.map((p) => [p.id, p.configured]));
	const current = resolveCurrentModel(runtime, file);
	const ws = getWebSearchConfig();
	return {
		path: cfg.path,
		text: cfg.text,
		errors: runtime.errors,
		defaultModel: current ? modelRef(current) : null,
		providers,
		webSearch: {
			enabled: ws.enabled,
			backend: ws.backend,
			maxResults: ws.maxResults,
			keySource: ws.keySource,
		},
		models: runtime.models.map((m) => ({
			ref: modelRef(m),
			id: m.id,
			provider: m.provider,
			label: m.label,
			contextWindow: m.contextWindow,
			configured: configuredById.get(m.provider) ?? false,
		})),
	};
}

export function registerAiIpc() {
	ipcMain.handle("settings:get", () => readSettings());

	ipcMain.handle("settings:save", (_e, settings: Record<string, string>) => {
		// Merge, not replace: callers pass only the fields they own (e.g. ocrLang).
		updateSettings(settings);
	});

	ipcMain.handle("ai:config", () => buildConfigPayload());

	ipcMain.handle("ai:config:save", (_e, text: string) => writeConfigText(text));

	ipcMain.handle("ai:config:open", async () => {
		const settings = readSettings();
		ensureConfig({ baseUrl: settings.baseUrl, model: settings.model });
		await shell.openPath(configPath());
		return configPath();
	});

	ipcMain.handle("ai:model:set", (_e, ref: string) => {
		updateSettings({ model: ref });
		return true;
	});

	ipcMain.handle("ai:key:set", (_e, providerId: string, key: string) => {
		setProviderKey(providerId, key);
		return true;
	});

	ipcMain.handle("ai:custom:list", () => readCustomProviders());

	ipcMain.handle(
		"ai:custom:save",
		(_e, input: { id: string; name?: string; baseUrl: string; models: string[] }) => {
			const id = String(input?.id ?? "")
				.trim()
				.toLowerCase();
			if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
				return { ok: false, error: "标识 ID 只能包含小写字母、数字和连字符" };
			}
			if (getBuiltinProvider(id))
				return { ok: false, error: `"${id}" 与内置提供商冲突，请换一个 ID` };
			const baseUrl = String(input?.baseUrl ?? "").trim();
			if (!baseUrl) return { ok: false, error: "请填写 Base URL" };
			const modelIds = (input?.models ?? [])
				.map((m) => String(m).trim())
				.filter(Boolean)
				.filter((m, i, arr) => arr.indexOf(m) === i);
			if (modelIds.length === 0) return { ok: false, error: "请至少填写一个模型 ID" };
			const data = readCustomProviders();
			data[id] = {
				name: String(input?.name ?? "").trim() || id,
				baseUrl,
				api: "openai-completions",
				models: modelIds.map((m) => ({ id: m })),
			};
			writeCustomProviders(data);
			return { ok: true, id };
		},
	);

	ipcMain.handle("ai:custom:remove", (_e, id: string) => {
		const data = readCustomProviders();
		delete data[id];
		writeCustomProviders(data);
		return true;
	});

	ipcMain.handle(
		"ai:websearch:set",
		(_e, patch: { enabled?: boolean; backend?: string; maxResults?: number }) => {
			const next: Record<string, string> = {};
			if (typeof patch?.enabled === "boolean") next.webSearchEnabled = patch.enabled ? "1" : "0";
			if (
				typeof patch?.backend === "string" &&
				(WEB_SEARCH_BACKENDS as readonly string[]).includes(patch.backend)
			) {
				next.webSearchBackend = patch.backend;
			}
			if (typeof patch?.maxResults === "number") {
				next.webSearchMaxResults = String(Math.max(1, Math.min(10, patch.maxResults)));
			}
			updateSettings(next);
			return true;
		},
	);

	ipcMain.handle("ai:websearch:test", async (_e, query?: string) => {
		const ws = getWebSearchConfig();
		const backend = ws.backend === "native" ? "auto" : ws.backend;
		try {
			const res = await searchWeb(backend, {
				query: String(query || "OpenAI"),
				count: Math.min(ws.maxResults, 5),
				apiKey: ws.key,
			});
			return { ok: true, backend: res.backend, results: res.results, text: res.text };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	});

	ipcMain.handle("ai:models:refresh", async (_e, providerId?: string) => {
		const { runtime } = buildRuntime();
		const cache = readModelCache();
		const results: { provider: string; added?: number; error?: string }[] = [];
		for (const p of runtime.providers) {
			if (providerId && p.id !== providerId) continue;
			if (p.api !== "openai-completions" || !p.baseUrl) continue;
			const key = runtime.resolveApiKey(p.id);
			try {
				const base = p.baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
				// Fetching /models is a public read for most OpenAI-compatible gateways.
				const res = await fetch(`${base}/models`, {
					headers: key ? { Authorization: `Bearer ${key}` } : {},
				});
				if (!res.ok) {
					results.push({ provider: p.id, error: `HTTP ${res.status}` });
					continue;
				}
				const json = (await res.json()) as { data?: { id?: unknown }[] };
				const ids = Array.isArray(json.data)
					? json.data.map((m) => m?.id).filter((x): x is string => typeof x === "string")
					: [];
				cache[p.id] = ids;
				results.push({ provider: p.id, added: ids.length });
			} catch (e) {
				results.push({ provider: p.id, error: e instanceof Error ? e.message : String(e) });
			}
		}
		writeModelCache(cache);
		return results;
	});
}
