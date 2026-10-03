import { anthropicMessagesStream } from "./api/anthropic-messages.ts";
import { openAICompletionsStream } from "./api/openai-completions.ts";
import { BUILTIN_PROVIDERS, type BuiltinModel, getBuiltinProvider } from "./config/builtin.ts";
import type { ModelOverride, ModelsFile, UserProviderConfig } from "./config/schema.ts";
import type { ApiType, AssistantMessageEvent, Model, StreamFn } from "./types.ts";

export type ResolvedProvider = {
	id: string;
	name: string;
	baseUrl: string;
	api: ApiType;
	envVars: string[];
	/** Inline key from models.json, if any. */
	apiKey?: string;
	headers?: Record<string, string>;
	isBuiltin: boolean;
	models: Model[];
};

export type ModelRuntime = {
	providers: ResolvedProvider[];
	models: Model[];
	/** Schema/parse errors from models.json (empty when valid). */
	errors: string[];
	getProvider(id: string): ResolvedProvider | undefined;
	/** Resolve `"<provider>/<model>"`, or a bare model id when unambiguous. */
	getModel(ref: string | undefined | null): Model | undefined;
	/** Inline key → injected store/env resolver → declared apiKeyEnv. */
	resolveApiKey(providerId: string): string | undefined;
	stream: StreamFn;
};

export type CreateModelRuntimeOptions = {
	file: ModelsFile;
	configErrors?: string[];
	/** App-provided secret lookup (encrypted auth store + environment). */
	resolveSecret?: (providerId: string, provider: ResolvedProvider) => string | undefined;
	/** Model ids fetched from a provider's /models endpoint, keyed by provider id. */
	modelCache?: Record<string, readonly string[]>;
};

type ModelSeed = {
	id: string;
	label?: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	api?: ApiType;
	hidden?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" && v ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
	return typeof v === "boolean" ? v : undefined;
}

function asApi(v: unknown): ApiType | undefined {
	return v === "openai-completions" || v === "anthropic-messages" ? v : undefined;
}

function sanitizeOverride(v: unknown): ModelOverride | undefined {
	if (!isRecord(v)) return undefined;
	const out: ModelOverride = {};
	const name = asString(v.name);
	if (name !== undefined) out.name = name;
	const contextWindow = asNumber(v.contextWindow);
	if (contextWindow !== undefined) out.contextWindow = contextWindow;
	const maxTokens = asNumber(v.maxTokens);
	if (maxTokens !== undefined) out.maxTokens = maxTokens;
	const reasoning = asBool(v.reasoning);
	if (reasoning !== undefined) out.reasoning = reasoning;
	const api = asApi(v.api);
	if (api !== undefined) out.api = api;
	const hidden = asBool(v.hidden);
	if (hidden !== undefined) out.hidden = hidden;
	return out;
}

function sanitizeModelSeed(v: unknown): ModelSeed | undefined {
	if (!isRecord(v)) return undefined;
	const id = asString(v.id);
	if (!id) return undefined;
	const out: ModelSeed = { id };
	const label = asString(v.name) ?? asString(v.label);
	if (label) out.label = label;
	const contextWindow = asNumber(v.contextWindow);
	if (contextWindow !== undefined) out.contextWindow = contextWindow;
	const maxTokens = asNumber(v.maxTokens);
	if (maxTokens !== undefined) out.maxTokens = maxTokens;
	const reasoning = asBool(v.reasoning);
	if (reasoning !== undefined) out.reasoning = reasoning;
	const api = asApi(v.api);
	if (api !== undefined) out.api = api;
	const hidden = asBool(v.hidden);
	if (hidden !== undefined) out.hidden = hidden;
	return out;
}

function sanitizeHeaders(v: unknown): Record<string, string> | undefined {
	if (!isRecord(v)) return undefined;
	const out: Record<string, string> = {};
	for (const [k, val] of Object.entries(v)) {
		if (typeof val === "string") out[k] = val;
	}
	return Object.keys(out).length ? out : undefined;
}

/** Coerce a possibly malformed provider config into a safe shape so bad input cannot crash the runtime. */
function sanitizeProvider(v: unknown): UserProviderConfig {
	if (!isRecord(v)) return {};
	const out: UserProviderConfig = {};
	const name = asString(v.name);
	if (name !== undefined) out.name = name;
	const baseUrl = asString(v.baseUrl);
	if (baseUrl !== undefined) out.baseUrl = baseUrl;
	const api = asApi(v.api);
	if (api !== undefined) out.api = api;
	const apiKey = asString(v.apiKey);
	if (apiKey !== undefined) out.apiKey = apiKey;
	const apiKeyEnv = asString(v.apiKeyEnv);
	if (apiKeyEnv !== undefined) out.apiKeyEnv = apiKeyEnv;
	const headers = sanitizeHeaders(v.headers);
	if (headers) out.headers = headers;
	if (Array.isArray(v.models)) {
		const models = v.models.map(sanitizeModelSeed).filter((m): m is ModelSeed => Boolean(m));
		if (models.length) out.models = models;
	}
	if (isRecord(v.modelOverrides)) {
		const overrides: Record<string, ModelOverride> = {};
		for (const [k, ov] of Object.entries(v.modelOverrides)) {
			const parsed = sanitizeOverride(ov);
			if (parsed) overrides[k] = parsed;
		}
		if (Object.keys(overrides).length) out.modelOverrides = overrides;
	}
	if (Array.isArray(v.disabledModels)) {
		out.disabledModels = v.disabledModels.filter((x): x is string => typeof x === "string");
	}
	return out;
}

function asModel(
	provider: ResolvedProvider,
	def: ModelSeed,
	override?: ModelOverride,
): Model | null {
	if (override?.hidden || def.hidden) return null;
	return {
		id: def.id,
		provider: provider.id,
		label: override?.name ?? def.label ?? def.name ?? def.id,
		contextWindow: override?.contextWindow ?? def.contextWindow ?? 128000,
		api: override?.api ?? def.api ?? provider.api,
		maxTokens: override?.maxTokens ?? def.maxTokens,
		reasoning: override?.reasoning ?? def.reasoning,
		headers: provider.headers,
	};
}

function buildModels(
	providerId: string,
	providerApi: ApiType,
	providerHeaders: Record<string, string> | undefined,
	builtin: readonly BuiltinModel[],
	user: UserProviderConfig,
	cache: readonly string[],
): Model[] {
	const overrides = user.modelOverrides ?? {};
	const disabled = new Set(user.disabledModels ?? []);
	const base: ResolvedProvider = {
		id: providerId,
		name: "",
		baseUrl: "",
		api: providerApi,
		envVars: [],
		headers: providerHeaders,
		isBuiltin: false,
		models: [],
	};

	const byId = new Map<string, Model>();
	const order: string[] = [];
	const add = (def: ModelSeed) => {
		const model = asModel(base, def, overrides[def.id]);
		if (!model) return;
		if (!byId.has(model.id)) order.push(model.id);
		byId.set(model.id, model);
	};

	for (const def of builtin) add(def);
	for (const def of user.models ?? []) add(def);
	for (const id of cache) add({ id });

	const models: Model[] = [];
	for (const id of order) {
		if (disabled.has(id)) continue;
		const model = byId.get(id);
		if (model) models.push(model);
	}
	return models;
}

export function createModelRuntime(options: CreateModelRuntimeOptions): ModelRuntime {
	const file = options.file ?? {};
	const userProviders = isRecord(file.providers)
		? (file.providers as Record<string, UserProviderConfig>)
		: {};
	const cache = options.modelCache ?? {};
	const errors = [...(options.configErrors ?? [])];
	const providers: ResolvedProvider[] = [];

	const ids = new Set<string>([
		...BUILTIN_PROVIDERS.map((p) => p.id),
		...Object.keys(userProviders),
	]);

	for (const id of ids) {
		const builtin = getBuiltinProvider(id);
		const user = sanitizeProvider(userProviders[id]);
		const baseUrl = user.baseUrl ?? builtin?.baseUrl ?? "";
		if (!builtin && !user.baseUrl) {
			errors.push(`providers.${id}.baseUrl: 自定义提供商必须提供 baseUrl`);
		}
		const api = user.api ?? builtin?.api ?? "openai-completions";
		const headers = user.headers ?? {};
		const cached = Array.isArray(cache[id]) ? cache[id] : [];
		providers.push({
			id,
			name: user.name ?? builtin?.name ?? id,
			baseUrl,
			api,
			envVars: user.apiKeyEnv ? [user.apiKeyEnv] : (builtin?.envVars ?? []),
			apiKey: user.apiKey,
			headers: Object.keys(headers).length ? headers : undefined,
			isBuiltin: Boolean(builtin),
			models: buildModels(
				id,
				api,
				Object.keys(headers).length ? headers : undefined,
				builtin?.models ?? [],
				user,
				cached,
			),
		});
	}

	const byId = new Map(providers.map((p) => [p.id, p]));
	const models = providers.flatMap((p) => p.models);

	const getModel = (ref: string | undefined | null): Model | undefined => {
		if (!ref) return undefined;
		const slash = ref.indexOf("/");
		if (slash > 0) {
			const provider = byId.get(ref.slice(0, slash));
			const id = ref.slice(slash + 1);
			return provider?.models.find((m) => m.id === id);
		}
		return models.find((m) => m.id === ref);
	};

	const resolveApiKey = (providerId: string): string | undefined => {
		const provider = byId.get(providerId);
		if (!provider) return undefined;
		if (provider.apiKey) return provider.apiKey;
		const injected = options.resolveSecret?.(providerId, provider);
		if (injected) return injected;
		for (const env of provider.envVars) {
			if (typeof process !== "undefined" && process.env?.[env]) return process.env[env];
		}
		return undefined;
	};

	const stream: StreamFn = async function* (
		model,
		context,
		streamOptions,
	): AsyncGenerator<AssistantMessageEvent> {
		const provider = byId.get(model.provider);
		if (!provider) {
			yield { type: "done", stopReason: "error", error: `未知提供商: ${model.provider}` };
			return;
		}
		const api = model.api ?? provider.api;
		const opts = {
			...streamOptions,
			apiKey: streamOptions.apiKey ?? resolveApiKey(provider.id),
			baseUrl: streamOptions.baseUrl ?? model.baseUrl ?? provider.baseUrl,
			headers: { ...provider.headers, ...model.headers, ...streamOptions.headers },
		};
		if (api === "anthropic-messages") yield* anthropicMessagesStream(model, context, opts);
		else yield* openAICompletionsStream(model, context, opts);
	};

	return {
		providers,
		models,
		errors,
		getProvider: (id) => byId.get(id),
		getModel,
		resolveApiKey,
		stream,
	};
}
