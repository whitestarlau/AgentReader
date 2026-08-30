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
};

export type Model = {
	id: string;
	provider: string;
	label: string;
	contextWindow: number;
};

export type AssistantMessageEvent =
	| { type: "text_delta"; delta: string }
	| { type: "reasoning_delta"; delta: string }
	| { type: "tool_call"; id: string; name: string; args: string }
	| { type: "done"; stopReason: "stop" | "tool_calls" | "error" | "aborted"; error?: string };

export type StreamOptions = {
	signal?: AbortSignal;
	maxTokens?: number;
	temperature?: number;
};

export type StreamFn = (
	model: Model,
	context: Context,
	options: StreamOptions,
) => AsyncGenerator<AssistantMessageEvent, void, unknown>;

export type Provider = {
	name: string;
	stream: StreamFn;
	models: Model[];
};
