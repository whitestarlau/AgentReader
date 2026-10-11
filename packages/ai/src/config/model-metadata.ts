/**
 * Built-in model metadata reference.
 *
 * A pattern-based knowledge base of context windows / output limits for the
 * major model families, so models discovered from a provider's `/models`
 * endpoint or custom OpenAI-compatible services get sensible limits without any
 * manual configuration. Values reflect public model cards (OpenAI, Anthropic,
 * Google, DeepSeek, Alibaba, Zhipu, Moonshot, MiniMax, xAI, Meta, Mistral, …)
 * and the models.dev catalog. Users can still override any model in Settings or
 * models.json; those always win.
 */

export type InferredModelMeta = {
	contextWindow?: number;
	maxTokens?: number;
};

type Rule = { test: RegExp } & InferredModelMeta;

// Ordered most-specific → least-specific; the first match wins.
const RULES: Rule[] = [
	// OpenAI
	{ test: /^gpt-4\.1/, contextWindow: 1_000_000, maxTokens: 32768 },
	{ test: /^gpt-4o/, contextWindow: 128_000, maxTokens: 16384 },
	{ test: /^gpt-4-turbo/, contextWindow: 128_000, maxTokens: 4096 },
	{ test: /^gpt-4-32k/, contextWindow: 32768, maxTokens: 4096 },
	{ test: /^gpt-4/, contextWindow: 8192, maxTokens: 4096 },
	{ test: /^gpt-3\.5/, contextWindow: 16385, maxTokens: 4096 },
	{ test: /^gpt-oss/, contextWindow: 131_072, maxTokens: 32768 },
	{ test: /^gpt-5|^gpt-6/, contextWindow: 400_000, maxTokens: 128_000 },
	{ test: /^o[134]/, contextWindow: 200_000, maxTokens: 100_000 },
	{ test: /^chatgpt/, contextWindow: 128_000, maxTokens: 16384 },

	// Anthropic
	{ test: /claude/, contextWindow: 200_000, maxTokens: 64000 },

	// Google
	{ test: /gemini-1\.5/, contextWindow: 1_000_000, maxTokens: 8192 },
	{ test: /gemini/, contextWindow: 1_000_000, maxTokens: 65536 },
	{ test: /gemma/, contextWindow: 8192, maxTokens: 4096 },

	// DeepSeek
	{ test: /deepseek-reasoner|deepseek-r1/, contextWindow: 128_000, maxTokens: 65536 },
	{ test: /deepseek/, contextWindow: 128_000, maxTokens: 8192 },

	// Alibaba Qwen
	{ test: /qwen/, contextWindow: 131_072, maxTokens: 32768 },

	// Zhipu GLM
	{ test: /glm/, contextWindow: 128_000, maxTokens: 16384 },

	// Moonshot Kimi
	{ test: /kimi|moonshot/, contextWindow: 262_144, maxTokens: 16384 },

	// MiniMax
	{ test: /minimax|abab/, contextWindow: 204_800, maxTokens: 16384 },

	// xAI
	{ test: /grok/, contextWindow: 131_072, maxTokens: 16384 },

	// Meta Llama
	{ test: /llama-?4/, contextWindow: 1_000_000, maxTokens: 16384 },
	{ test: /llama-?3/, contextWindow: 128_000, maxTokens: 8192 },
	{ test: /llama/, contextWindow: 8192, maxTokens: 4096 },

	// Mistral / Mixtral / Codestral
	{ test: /mixtral/, contextWindow: 32768, maxTokens: 8192 },
	{
		test: /mistral|magistral|codestral|devstral|pixtral/,
		contextWindow: 131_072,
		maxTokens: 16384,
	},

	// Cohere
	{ test: /command-r/, contextWindow: 128_000, maxTokens: 4096 },
	{ test: /command/, contextWindow: 4096, maxTokens: 4096 },

	// Microsoft / NVIDIA / others
	{ test: /phi-?3|phi-?4|phi4/, contextWindow: 128_000, maxTokens: 16384 },
	{ test: /nemotron/, contextWindow: 131_072, maxTokens: 16384 },
	{ test: /ernie/, contextWindow: 128_000, maxTokens: 8192 },
	{ test: /hunyuan/, contextWindow: 32768, maxTokens: 8192 },
	{ test: /internlm/, contextWindow: 32768, maxTokens: 4096 },
	{ test: /yi-/, contextWindow: 16384, maxTokens: 4096 },
];

/**
 * Best-effort context window / output cap inferred from a model id. Returns an
 * empty object when nothing matches (callers then apply their own default).
 */
export function inferModelMeta(id: string): InferredModelMeta {
	const s = id.trim().toLowerCase();
	if (!s) return {};
	for (const rule of RULES) {
		if (rule.test.test(s)) return { contextWindow: rule.contextWindow, maxTokens: rule.maxTokens };
	}
	return {};
}
