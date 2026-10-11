export type Role = "system" | "user" | "assistant" | "tool";

export type ContentPart = { type: "text"; text: string } | { type: "image"; dataUrl: string };

export type Message = {
	role: Role;
	content: string | ContentPart[];
	toolCallId?: string;
	toolName?: string;
	toolCalls?: { id: string; name: string; arguments: string }[];
	reasoning?: string;
};

export type Context = {
	systemPrompt?: string;
	messages: Message[];
	tools?: ToolDefinition[];
};

export type ToolDefinition = {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	/** Provider handles this tool server-side (e.g. Anthropic web_search); not sent as a function tool. */
	native?: boolean;
};

/** Wire protocol a provider speaks. Determines which stream adapter handles a model. */
export type ApiType = "openai-completions" | "anthropic-messages";

export type Model = {
	id: string;
	provider: string;
	label: string;
	contextWindow: number;
	/** Where `contextWindow` came from: user override, catalog, inference or default. */
	contextWindowSource?: "override" | "catalog" | "inferred" | "default";
	/** Protocol override; falls back to the owning provider's api when omitted. */
	api?: ApiType;
	baseUrl?: string;
	maxTokens?: number;
	reasoning?: boolean;
	headers?: Record<string, string>;
};

/** Token accounting reported by a provider for one request. */
export type TokenUsage = { inputTokens: number; outputTokens: number };

export type AssistantMessageEvent =
	| { type: "text_delta"; delta: string }
	| { type: "reasoning_delta"; delta: string }
	| { type: "tool_call"; id: string; name: string; args: string }
	/** Provider-reported token usage; emitted once before `done` when available. */
	| { type: "usage"; usage: TokenUsage }
	| {
			type: "done";
			stopReason: "stop" | "tool_calls" | "error" | "aborted" | "length";
			error?: string;
	  };

export type StreamOptions = {
	signal?: AbortSignal;
	maxTokens?: number;
	temperature?: number;
	/** Resolved at call time by the runtime; adapters never read config themselves. */
	apiKey?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	/** Session/affinity id forwarded to providers that support it (e.g. opencode). */
	sessionId?: string;
};

export type StreamFn = (
	model: Model,
	context: Context,
	options: StreamOptions,
) => AsyncGenerator<AssistantMessageEvent, void, unknown>;

export type Provider = {
	id: string;
	name: string;
	baseUrl?: string;
	api: ApiType;
	models: Model[];
};
