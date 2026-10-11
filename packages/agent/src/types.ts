export type AgentTool = {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (params: unknown, signal: AbortSignal) => Promise<string>;
	/** Handled by the provider server-side (e.g. Anthropic web search); the loop never executes it. */
	native?: boolean;
};

export type AgentMessage = {
	role: "user" | "assistant" | "tool";
	content: string;
	toolCallId?: string;
	toolName?: string;
	toolCalls?: { id: string; name: string; arguments: string }[];
	reasoning?: string;
};

export type AgentState = {
	messages: AgentMessage[];
	isStreaming: boolean;
	pendingToolCalls: { id: string; name: string; args: string }[];
};

export type AgentStopReason =
	| "stop"
	| "tool_calls"
	| "error"
	| "aborted"
	/** Provider cut the reply at the output-token limit. */
	| "length"
	/** The tool-call loop hit `maxTurns` before a final answer was produced. */
	| "max_turns"
	/** The model returned no text, no reasoning and no tool call. */
	| "empty";

export type AgentEvent =
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_delta"; delta: string }
	| { type: "reasoning_delta"; delta: string }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_call"; id: string; name: string; args: string }
	| { type: "tool_result"; id: string; name: string; result: string }
	| { type: "done"; stopReason: AgentStopReason; error?: string };

export type AgentConfig = {
	systemPrompt?: string;
	tools?: AgentTool[];
	maxTurns?: number;
	onEvent?: (event: AgentEvent) => void;
};
