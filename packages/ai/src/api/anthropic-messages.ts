import type {
	AssistantMessageEvent,
	ContentPart,
	Context,
	Message,
	Model,
	StreamOptions,
} from "../types.ts";

type AnthBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } }
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| { type: "tool_result"; tool_use_id: string; content: string };

type AnthMessage = { role: "user" | "assistant"; content: AnthBlock[] };

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/messages$/, "");
}

function toTextBlock(content: string | ContentPart[]): AnthBlock[] {
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	const blocks: AnthBlock[] = [];
	for (const part of content) {
		if (part.type === "text") {
			if (part.text) blocks.push({ type: "text", text: part.text });
		} else {
			const match = /^data:([^;,]+)(;base64)?,(.*)$/.exec(part.dataUrl);
			if (match) {
				blocks.push({
					type: "image",
					source: { type: "base64", media_type: match[1], data: match[3] },
				});
			}
		}
	}
	return blocks;
}

function parseArgs(args: string): unknown {
	try {
		return JSON.parse(args || "{}");
	} catch {
		return {};
	}
}

/** Convert the normalized context into Anthropic messages, merging same-role turns. */
function toAnthropicMessages(messages: Message[]): AnthMessage[] {
	const out: AnthMessage[] = [];
	const push = (role: "user" | "assistant", blocks: AnthBlock[]) => {
		if (blocks.length === 0) return;
		const last = out[out.length - 1];
		if (last && last.role === role) last.content.push(...blocks);
		else out.push({ role, content: blocks });
	};

	for (const m of messages) {
		if (m.role === "system") {
			// System is hoisted to the top-level `system` field by the caller.
			continue;
		}
		if (m.role === "tool" && m.toolCallId) {
			push("user", [
				{
					type: "tool_result",
					tool_use_id: m.toolCallId,
					content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
				},
			]);
			continue;
		}
		if (m.role === "assistant") {
			const blocks: AnthBlock[] = [];
			const text = typeof m.content === "string" ? m.content : "";
			if (text) blocks.push({ type: "text", text });
			for (const tc of m.toolCalls ?? []) {
				blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: parseArgs(tc.arguments) });
			}
			push("assistant", blocks);
			continue;
		}
		push("user", toTextBlock(m.content));
	}
	return out;
}

/**
 * Anthropic Messages streaming adapter. The caller (runtime) resolves the base
 * URL, API key and headers; this function only speaks the protocol.
 */
export async function* anthropicMessagesStream(
	model: Model,
	context: Context,
	options: StreamOptions,
): AsyncGenerator<AssistantMessageEvent> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? model.baseUrl ?? "");
	if (!baseUrl) {
		yield { type: "done", stopReason: "error", error: "缺少 Base URL" };
		return;
	}

	const systemText = [
		context.systemPrompt ?? "",
		...context.messages.filter((m) => m.role === "system").map((m) => contentToText(m.content)),
	]
		.filter(Boolean)
		.join("\n\n");

	const tools = context.tools?.length
		? context.tools.map((t) => ({
				name: t.name,
				description: t.description,
				input_schema: t.parameters,
			}))
		: undefined;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
		"User-Agent": "agentreader/0.1.0",
		...model.headers,
		...options.headers,
	};
	if (options.apiKey) headers["x-api-key"] = options.apiKey;

	let res: Response;
	try {
		res = await fetch(`${baseUrl}/messages`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: model.id,
				max_tokens: options.maxTokens ?? model.maxTokens ?? 8192,
				...(systemText ? { system: systemText } : {}),
				messages: toAnthropicMessages(context.messages),
				...(tools ? { tools } : {}),
				...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
				stream: true,
			}),
			signal: options.signal,
		});
	} catch (e) {
		yield { type: "done", stopReason: "error", error: errorMessage(e) };
		return;
	}

	if (!res.ok || !res.body) {
		const body = await res.text().catch(() => "");
		yield { type: "done", stopReason: "error", error: `HTTP ${res.status} ${body.slice(0, 800)}` };
		return;
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let dataLines: string[] = [];
	const toolAccum = new Map<number, { id: string; name: string; args: string }>();
	let emittedTools = false;
	let stopReason: "stop" | "tool_calls" = "stop";

	const emitTools = function* (): Generator<AssistantMessageEvent> {
		for (const [, tc] of toolAccum) {
			yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };
		}
		toolAccum.clear();
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nl = buffer.indexOf("\n");
			while (nl >= 0) {
				const line = buffer.slice(0, nl).replace(/\r$/, "");
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");

				if (line === "") {
					if (dataLines.length) {
						const payload = dataLines.join("");
						dataLines = [];
						let json: {
							type?: string;
							index?: number;
							content_block?: { type?: string; id?: string; name?: string };
							delta?: {
								type?: string;
								text?: string;
								thinking?: string;
								partial_json?: string;
								stop_reason?: string;
							};
							error?: { type?: string; message?: string };
						};
						try {
							json = JSON.parse(payload);
						} catch {
							continue;
						}
						if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
							toolAccum.set(json.index ?? 0, {
								id: json.content_block.id ?? `tool-${json.index ?? 0}`,
								name: json.content_block.name ?? "",
								args: "",
							});
						} else if (json.type === "content_block_delta") {
							const d = json.delta;
							if (d?.type === "text_delta" && d.text) {
								yield { type: "text_delta", delta: d.text };
							} else if (d?.type === "thinking_delta" && d.thinking) {
								yield { type: "reasoning_delta", delta: d.thinking };
							} else if (d?.type === "input_json_delta" && d.partial_json) {
								const cur = toolAccum.get(json.index ?? 0);
								if (cur) cur.args += d.partial_json;
							}
						} else if (json.type === "content_block_stop") {
							const cur = toolAccum.get(json.index ?? 0);
							if (cur) {
								yield { type: "tool_call", id: cur.id, name: cur.name, args: cur.args };
								toolAccum.delete(json.index ?? 0);
								emittedTools = true;
								stopReason = "tool_calls";
							}
						} else if (json.type === "message_delta") {
							if (json.delta?.stop_reason === "tool_use") stopReason = "tool_calls";
						} else if (json.type === "error") {
							yield {
								type: "done",
								stopReason: "error",
								error: json.error?.message ?? "Anthropic error",
							};
							return;
						}
					}
					continue;
				}
				if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
			}
		}
	} catch (e) {
		const msg = errorMessage(e);
		yield { type: "done", stopReason: /abort/i.test(msg) ? "aborted" : "error", error: msg };
		return;
	}

	if (!emittedTools && toolAccum.size) {
		for (const evt of emitTools()) yield evt;
		stopReason = "tool_calls";
	}
	yield { type: "done", stopReason };
}

function contentToText(content: string | ContentPart[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map((p) => p.text)
		.join("\n");
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
