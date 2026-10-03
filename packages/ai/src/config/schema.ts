import type { ApiType } from "../types.ts";

/** A model added or overriding a built-in by id inside a user provider. */
export type UserModelDef = {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	api?: ApiType;
	hidden?: boolean;
};

/** Field-level patch applied on top of a built-in or user model. */
export type ModelOverride = {
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	api?: ApiType;
	hidden?: boolean;
};

export type UserProviderConfig = {
	name?: string;
	baseUrl?: string;
	api?: ApiType;
	/** Inline key. Prefer {@link apiKeyEnv} or the encrypted auth store. */
	apiKey?: string;
	apiKeyEnv?: string;
	headers?: Record<string, string>;
	models?: UserModelDef[];
	modelOverrides?: Record<string, ModelOverride>;
	disabledModels?: string[];
};

export type WebSearchBackend =
	| "auto"
	| "exa-mcp"
	| "parallel-mcp"
	| "brave"
	| "tavily"
	| "exa"
	| "duckduckgo"
	| "native";

export type WebSearchConfig = {
	enabled?: boolean;
	backend?: WebSearchBackend;
	apiKey?: string;
	apiKeyEnv?: string;
	maxResults?: number;
};

export type ModelsFile = {
	version?: number;
	defaultModel?: string;
	providers?: Record<string, UserProviderConfig>;
	tools?: { webSearch?: WebSearchConfig };
};

export type ParseResult = { file: ModelsFile; errors: string[] };

const API_TYPES: ReadonlySet<string> = new Set(["openai-completions", "anthropic-messages"]);

/** Strip `//` and block comments plus trailing commas, without touching string contents. */
export function stripJsonComments(input: string): string {
	let out = "";
	let inString = false;
	let quote = "";
	let escaped = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		const next = input[i + 1];
		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === quote) inString = false;
			continue;
		}
		if (ch === '"' || ch === "'") {
			inString = true;
			quote = ch;
			out += ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < input.length && input[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
			i++;
			continue;
		}
		out += ch;
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateModelDef(value: unknown, path: string, errors: string[]): void {
	if (!isRecord(value)) {
		errors.push(`${path}: 必须是对象`);
		return;
	}
	if (typeof value.id !== "string" || !value.id.trim())
		errors.push(`${path}.id: 必填且为非空字符串`);
	for (const key of ["name"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "string")
			errors.push(`${path}.${key}: 必须是字符串`);
	}
	for (const key of ["contextWindow", "maxTokens"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "number")
			errors.push(`${path}.${key}: 必须是数字`);
	}
	for (const key of ["reasoning", "hidden"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "boolean")
			errors.push(`${path}.${key}: 必须是布尔值`);
	}
	if (value.api !== undefined && !API_TYPES.has(String(value.api))) {
		errors.push(`${path}.api: 必须是 openai-completions 或 anthropic-messages`);
	}
}

function validateProvider(value: unknown, path: string, errors: string[]): void {
	if (!isRecord(value)) {
		errors.push(`${path}: 必须是对象`);
		return;
	}
	for (const key of ["name", "baseUrl", "apiKey", "apiKeyEnv"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "string")
			errors.push(`${path}.${key}: 必须是字符串`);
	}
	if (value.api !== undefined && !API_TYPES.has(String(value.api))) {
		errors.push(`${path}.api: 必须是 openai-completions 或 anthropic-messages`);
	}
	if (value.headers !== undefined) {
		if (!isRecord(value.headers)) errors.push(`${path}.headers: 必须是对象`);
		else {
			for (const [hk, hv] of Object.entries(value.headers)) {
				if (typeof hv !== "string") errors.push(`${path}.headers.${hk}: 必须是字符串`);
			}
		}
	}
	if (value.models !== undefined) {
		if (!Array.isArray(value.models)) errors.push(`${path}.models: 必须是数组`);
		else
			value.models.forEach((m, i) => {
				validateModelDef(m, `${path}.models[${i}]`, errors);
			});
	}
	if (value.modelOverrides !== undefined) {
		if (!isRecord(value.modelOverrides)) errors.push(`${path}.modelOverrides: 必须是对象`);
		else {
			for (const [mid, ov] of Object.entries(value.modelOverrides)) {
				validateModelDef(
					{ id: mid, ...(isRecord(ov) ? ov : {}) },
					`${path}.modelOverrides.${mid}`,
					errors,
				);
			}
		}
	}
	if (value.disabledModels !== undefined) {
		if (
			!Array.isArray(value.disabledModels) ||
			value.disabledModels.some((m) => typeof m !== "string")
		) {
			errors.push(`${path}.disabledModels: 必须是字符串数组`);
		}
	}
}

function validateWebSearch(value: unknown, path: string, errors: string[]): void {
	if (value === undefined) return;
	if (!isRecord(value)) {
		errors.push(`${path}: 必须是对象`);
		return;
	}
	const backends = new Set([
		"auto",
		"exa-mcp",
		"parallel-mcp",
		"brave",
		"tavily",
		"exa",
		"duckduckgo",
		"native",
	]);
	if (value.backend !== undefined && !backends.has(String(value.backend))) {
		errors.push(`${path}.backend: 取值无效`);
	}
	if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
		errors.push(`${path}.enabled: 必须是布尔值`);
	}
	if (value.maxResults !== undefined && typeof value.maxResults !== "number") {
		errors.push(`${path}.maxResults: 必须是数字`);
	}
	for (const key of ["apiKey", "apiKeyEnv"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "string")
			errors.push(`${path}.${key}: 必须是字符串`);
	}
}

/** Validate a parsed models file, returning human-readable error paths. */
export function validateModelsFile(value: unknown): string[] {
	const errors: string[] = [];
	if (!isRecord(value)) return ["根节点必须是对象"];
	if (value.version !== undefined && typeof value.version !== "number")
		errors.push("version: 必须是数字");
	if (value.defaultModel !== undefined && typeof value.defaultModel !== "string") {
		errors.push("defaultModel: 必须是字符串");
	} else if (
		typeof value.defaultModel === "string" &&
		value.defaultModel &&
		!value.defaultModel.includes("/")
	) {
		errors.push('defaultModel: 格式应为 "<providerId>/<modelId>"');
	}
	if (value.providers !== undefined) {
		if (!isRecord(value.providers)) errors.push("providers: 必须是对象");
		else {
			for (const [id, provider] of Object.entries(value.providers)) {
				validateProvider(provider, `providers.${id}`, errors);
			}
		}
	}
	if (value.tools !== undefined) {
		if (!isRecord(value.tools)) errors.push("tools: 必须是对象");
		else validateWebSearch(value.tools.webSearch, "tools.webSearch", errors);
	}
	return errors;
}

/** Parse models.json text (JSONC) and validate it. Safe to call on partial input. */
export function parseModelsFile(text: string): ParseResult {
	const trimmed = text.trim();
	if (!trimmed) return { file: {}, errors: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		try {
			parsed = JSON.parse(stripJsonComments(trimmed));
		} catch (e) {
			return { file: {}, errors: [`JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`] };
		}
	}
	const errors = validateModelsFile(parsed);
	return { file: isRecord(parsed) ? (parsed as ModelsFile) : {}, errors };
}

/** Default starter file written on first run; intentionally commented for AI editing. */
export const DEFAULT_MODELS_TEMPLATE = `{
  // AgentReader 模型配置。允许 // 注释与尾逗号（JSONC）。
  // 内置提供商（openai / anthropic / opencode / opencode-go / deepseek）无需重复声明，
  // 只需在此覆盖 baseUrl，或用 modelOverrides / disabledModels 调整模型。
  // 密钥不要写在这里；请用 apiKeyEnv 引用环境变量，或在「设置」中填写（加密保存）。
  "version": 1,
  "providers": {}
}
`;
