export type AgentTool = {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (params: unknown, signal: AbortSignal) => Promise<string>;
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

export type AgentEvent =
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_delta"; delta: string }
	| { type: "reasoning_delta"; delta: string }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_call"; id: string; name: string; args: string }
	| { type: "tool_result"; id: string; name: string; result: string }
	| { type: "done"; stopReason: string };

export type AgentConfig = {
	systemPrompt?: string;
	tools?: AgentTool[];
	onEvent?: (event: AgentEvent) => void;
};
