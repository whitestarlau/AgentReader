import type { ApiType } from "../types.ts";
import { OPENCODE_GO_MODEL_IDS, OPENCODE_MODEL_IDS } from "./catalog-opencode.ts";

export type BuiltinModel = {
	id: string;
	label?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	api?: ApiType;
};

export type BuiltinProvider = {
	id: string;
	name: string;
	baseUrl: string;
	api: ApiType;
	envVars: string[];
	models: BuiltinModel[];
};

/** IDs from a provider /models list become display-only catalog entries. */
function fromIds(ids: readonly string[], contextWindow = 128000): BuiltinModel[] {
	return ids.map((id) => ({ id, label: id, contextWindow }));
}

export const BUILTIN_PROVIDERS: BuiltinProvider[] = [
	{
		id: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		api: "openai-completions",
		envVars: ["OPENAI_API_KEY"],
		models: [
			{ id: "gpt-5.1", contextWindow: 400000, maxTokens: 128000, reasoning: true },
			{ id: "gpt-5", contextWindow: 400000, maxTokens: 128000, reasoning: true },
			{ id: "gpt-5-mini", contextWindow: 400000, maxTokens: 128000, reasoning: true },
			{ id: "gpt-5-nano", contextWindow: 400000, maxTokens: 128000, reasoning: true },
			{ id: "gpt-4.1", contextWindow: 1000000, maxTokens: 32768 },
			{ id: "gpt-4.1-mini", contextWindow: 1000000, maxTokens: 32768 },
			{ id: "gpt-4o", contextWindow: 128000, maxTokens: 16384 },
			{ id: "gpt-4o-mini", contextWindow: 128000, maxTokens: 16384 },
			{ id: "o4-mini", contextWindow: 200000, maxTokens: 100000, reasoning: true },
			{ id: "o3", contextWindow: 200000, maxTokens: 100000, reasoning: true },
			{ id: "o3-mini", contextWindow: 200000, maxTokens: 100000, reasoning: true },
		],
	},
	{
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com/v1",
		api: "anthropic-messages",
		envVars: ["ANTHROPIC_API_KEY"],
		models: [
			{ id: "claude-opus-4-7", contextWindow: 200000, maxTokens: 32000, reasoning: true },
			{ id: "claude-opus-4-6", contextWindow: 200000, maxTokens: 32000, reasoning: true },
			{ id: "claude-sonnet-4-6", contextWindow: 200000, maxTokens: 64000, reasoning: true },
			{ id: "claude-sonnet-4-5", contextWindow: 200000, maxTokens: 64000, reasoning: true },
			{ id: "claude-haiku-4-5", contextWindow: 200000, maxTokens: 32000, reasoning: true },
			{ id: "claude-3-7-sonnet", contextWindow: 200000, maxTokens: 64000, reasoning: true },
			{ id: "claude-3-5-sonnet", contextWindow: 200000, maxTokens: 8192 },
			{ id: "claude-3-5-haiku", contextWindow: 200000, maxTokens: 8192 },
		],
	},
	{
		id: "deepseek",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com/v1",
		api: "openai-completions",
		envVars: ["DEEPSEEK_API_KEY"],
		models: [
			{ id: "deepseek-chat", contextWindow: 128000, maxTokens: 8192 },
			{ id: "deepseek-reasoner", contextWindow: 128000, maxTokens: 8192, reasoning: true },
		],
	},
	{
		id: "opencode-go",
		name: "OpenCode Go",
		baseUrl: "https://opencode.ai/zen/go/v1",
		api: "openai-completions",
		envVars: ["OPENCODE_API_KEY"],
		models: fromIds(OPENCODE_GO_MODEL_IDS),
	},
	{
		id: "opencode",
		name: "OpenCode Zen",
		baseUrl: "https://opencode.ai/zen/v1",
		api: "openai-completions",
		envVars: ["OPENCODE_API_KEY"],
		models: fromIds(OPENCODE_MODEL_IDS),
	},
];

const BUILTIN_BY_ID = new Map(BUILTIN_PROVIDERS.map((p) => [p.id, p]));

export function getBuiltinProvider(id: string): BuiltinProvider | undefined {
	return BUILTIN_BY_ID.get(id);
}
