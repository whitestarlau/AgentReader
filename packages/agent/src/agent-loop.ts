import type { Context, Model, StreamFn } from "@agentreader/ai";
import type { AgentConfig, AgentEvent, AgentMessage } from "./types.ts";

export async function* runAgentLoop(
	messages: AgentMessage[],
	model: Model,
	streamFn: StreamFn,
	config: AgentConfig,
	signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
	const currentMessages = [...messages];
	let turn = 0;
	const maxTurns = config.maxTurns ?? 5;

	while (turn < maxTurns) {
		turn++;
		const context: Context = {
			systemPrompt: config.systemPrompt,
			// Preserve tool wiring: dropping toolCalls/toolCallId here breaks the
			// follow-up request (OpenAI rejects a `tool` message without tool_call_id).
			messages: currentMessages.map((m) => ({ ...m })),
			tools: config.tools?.map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
				...(t.native ? { native: true } : {}),
			})),
		};

		let assistantContent = "";
		let assistantReasoning = "";
		const toolCalls: { id: string; name: string; args: string }[] = [];

		for await (const event of streamFn(model, context, { signal })) {
			if (event.type === "text_delta") {
				if (assistantContent === "")
					yield { type: "message_start", message: { role: "assistant", content: "" } };
				assistantContent += event.delta;
				yield { type: "message_delta", delta: event.delta };
			} else if (event.type === "reasoning_delta") {
				assistantReasoning += event.delta;
				yield { type: "reasoning_delta", delta: event.delta };
			} else if (event.type === "tool_call") {
				toolCalls.push(event);
				yield { type: "tool_call", id: event.id, name: event.name, args: event.args };
			} else if (event.type === "done") {
				if (assistantContent || assistantReasoning) {
					yield {
						type: "message_end",
						message: {
							role: "assistant",
							content: assistantContent,
							...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
						},
					};
				}
				if (event.stopReason === "error") {
					const err = event.error || "unknown";
					yield { type: "done", stopReason: "error", error: err };
					return;
				}
				// User abort / output-token limit: surface it instead of letting the
				// loop look like a normal completion.
				if (event.stopReason === "aborted" || event.stopReason === "length") {
					yield { type: "done", stopReason: event.stopReason };
					return;
				}
				break;
			}
		}

		if (toolCalls.length === 0 && assistantContent.includes('"tool"')) {
			try {
				const m =
					assistantContent.match(/\{\s*"tool"\s*:\s*"([^"]+)"[^}]*"query"\s*:\s*"([^"]+)"/) ||
					assistantContent.match(/\{\s*"tool"\s*:\s*"([^"]+)"[^}]*"page"\s*:\s*(\d+)/);
				if (m) {
					const name = m[1];
					const isPage = assistantContent.includes('"page"');
					const args = isPage
						? JSON.stringify({ page: Number(m[2]) })
						: JSON.stringify({ query: m[2] });
					toolCalls.push({ id: `tool-${Date.now()}`, name, args });
					assistantContent = "";
				} else {
					const parsed = JSON.parse(assistantContent.trim().replace(/^```json\s*|\s*```$/g, ""));
					if (parsed.tool && (parsed.query || parsed.page)) {
						const name = parsed.tool;
						const args = JSON.stringify(
							parsed.query ? { query: parsed.query, limit: parsed.limit } : { page: parsed.page },
						);
						toolCalls.push({ id: `tool-${Date.now()}`, name, args });
						assistantContent = "";
					}
				}
			} catch {}
		}
		if (toolCalls.length === 0) {
			// No tool call and nothing to say: distinguish a genuinely empty reply
			// from a normal one so the caller can tell the user.
			yield { type: "done", stopReason: assistantContent || assistantReasoning ? "stop" : "empty" };
			return;
		}

		currentMessages.push({
			role: "assistant",
			content: assistantContent || "",
			...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
			...(toolCalls.length
				? { toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.args })) }
				: {}),
		});

		for (const tc of toolCalls) {
			const tool = config.tools?.find((t) => t.name === tc.name);
			let result: string;
			if (!tool) result = `Unknown tool: ${tc.name}`;
			else {
				try {
					const params = JSON.parse(tc.args || "{}");
					result = await tool.execute(params, signal ?? new AbortController().signal);
				} catch (e) {
					result = String(e);
				}
			}
			yield { type: "tool_result", id: tc.id, name: tc.name, result };
			currentMessages.push({ role: "tool", content: result, toolCallId: tc.id, toolName: tc.name });
		}
	}
	// Fell out of the loop: maxTurns tool rounds were used without a final answer.
	yield { type: "done", stopReason: "max_turns" };
}
