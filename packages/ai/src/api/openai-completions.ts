import type { AssistantMessageEvent, Context, Model, StreamOptions, TokenUsage } from "../types.ts";

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/chat\/completions$/, "");
}

/**
 * OpenAI Chat Completions streaming adapter. The caller (runtime) resolves the
 * base URL, API key and headers; this function only speaks the protocol.
 */
export async function* openAICompletionsStream(
	model: Model,
	context: Context,
	options: StreamOptions,
): AsyncGenerator<AssistantMessageEvent> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? model.baseUrl ?? "");
	if (!baseUrl) {
		yield { type: "done", stopReason: "error", error: "缺少 Base URL" };
		return;
	}

	const messages = [
		...(context.systemPrompt ? [{ role: "system", content: context.systemPrompt }] : []),
		...context.messages.map((m) => {
			if (m.role === "tool" && m.toolCallId) {
				return {
					role: "tool",
					tool_call_id: m.toolCallId,
					content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
				};
			}
			if (m.role === "assistant" && m.toolCalls?.length) {
				return {
					role: "assistant",
					content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
					tool_calls: m.toolCalls.map((t) => ({
						id: t.id,
						type: "function" as const,
						function: { name: t.name, arguments: t.arguments },
					})),
				};
			}
			return {
				role: m.role,
				content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
			};
		}),
	] as { role: string; content: string | null; tool_call_id?: string; tool_calls?: unknown }[];

	const tools = context.tools?.filter((t) => !t.native).length
		? context.tools
				.filter((t) => !t.native)
				.map((t) => ({
					type: "function" as const,
					function: { name: t.name, description: t.description, parameters: t.parameters },
				}))
		: undefined;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"User-Agent": "agentreader/0.1.0",
		...model.headers,
		...options.headers,
	};
	if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
	if (options.sessionId) headers["x-opencode-session"] = options.sessionId;

	const post = (includeUsage: boolean) =>
		fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: model.id,
				messages,
				...(tools ? { tools, tool_choice: "auto" } : {}),
				stream: true,
				// Ask for a final usage chunk so we can report context consumption.
				...(includeUsage ? { stream_options: { include_usage: true } } : {}),
				max_tokens: options.maxTokens ?? model.maxTokens,
				temperature: options.temperature ?? 0.7,
			}),
			signal: options.signal,
		});

	let res: Response;
	try {
		res = await post(true);
		// Some OpenAI-compatible gateways reject `stream_options`; retry without it
		// so usage reporting never breaks an otherwise working provider.
		if (!res.ok && res.status === 400) {
			const peek = await res.text().catch(() => "");
			if (/stream_options|include_usage/i.test(peek)) res = await post(false);
			else {
				yield {
					type: "done",
					stopReason: "error",
					error: `HTTP ${res.status} ${peek.slice(0, 800)}`,
				};
				return;
			}
		}
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

	const toolAccum = new Map<number, { id: string; name: string; args: string }>();
	// finish_reason of the last chunk ("stop" / "tool_calls" / "length" / ...).
	let finishReason: string | undefined;
	// Provider-reported usage from the trailing usage chunk (stream_options).
	let usage: TokenUsage | null = null;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.startsWith("data: ")) continue;
				const data = line.slice(6).trim();
				if (data === "[DONE]") {
					// A length-truncated stream may hold partial tool calls; don't run them.
					if (finishReason !== "length")
						for (const [, tc] of toolAccum)
							yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };
					if (usage) yield { type: "usage", usage };
					yield { type: "done", stopReason: doneReason(finishReason, toolAccum.size) };
					return;
				}
				let json: {
					choices?: {
						delta?: {
							content?: string;
							reasoning_content?: string;
							reasoning?: string;
							thinking?: string;
							reasoning_details?: unknown;
							tool_calls?: {
								index: number;
								id?: string;
								function?: { name?: string; arguments?: string };
							}[];
						};
						message?: {
							tool_calls?: { id: string; function: { name: string; arguments: string } }[];
						};
						finish_reason?: string;
					}[];
					usage?: { prompt_tokens?: number; completion_tokens?: number };
				};
				try {
					json = JSON.parse(data);
				} catch {
					continue;
				}
				const choice = json.choices?.[0];
				if (json.usage) {
					usage = {
						inputTokens: json.usage.prompt_tokens ?? 0,
						outputTokens: json.usage.completion_tokens ?? 0,
					};
				}
				if (choice?.finish_reason) finishReason = choice.finish_reason;
				const delta = choice?.delta;
				if (delta?.content) yield { type: "text_delta", delta: delta.content };
				// Thinking content: field names vary across providers.
				const reasoning =
					delta?.reasoning_content ??
					delta?.reasoning ??
					delta?.thinking ??
					delta?.reasoning_details;
				if (typeof reasoning === "string" && reasoning) {
					yield { type: "reasoning_delta", delta: reasoning };
				}
				if (delta?.tool_calls) {
					for (const tc of delta.tool_calls) {
						const idx = tc.index ?? 0;
						const cur = toolAccum.get(idx) ?? {
							id: tc.id ?? `tool-${idx}`,
							name: tc.function?.name ?? "",
							args: "",
						};
						if (tc.id) cur.id = tc.id;
						if (tc.function?.name) cur.name = tc.function.name;
						if (tc.function?.arguments) cur.args += tc.function.arguments;
						toolAccum.set(idx, cur);
					}
				}
				if (choice?.message?.tool_calls) {
					for (const tc of choice.message.tool_calls) {
						yield {
							type: "tool_call",
							id: tc.id,
							name: tc.function.name,
							args: tc.function.arguments,
						};
					}
				}
				if (choice?.finish_reason === "tool_calls") {
					for (const [, tc] of toolAccum)
						yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };
					toolAccum.clear();
				}
			}
		}
	} catch (e) {
		const msg = errorMessage(e);
		yield { type: "done", stopReason: isAbort(msg) ? "aborted" : "error", error: msg };
		return;
	}
	// A length-truncated stream may hold partial tool calls; don't run them.
	if (finishReason !== "length")
		for (const [, tc] of toolAccum)
			yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };
	if (usage) yield { type: "usage", usage };
	yield { type: "done", stopReason: doneReason(finishReason, toolAccum.size) };
}

/** Map an OpenAI finish_reason (+ accumulated tool calls) onto our stop reasons. */
function doneReason(
	finishReason: string | undefined,
	toolCalls: number,
): "stop" | "tool_calls" | "length" {
	if (finishReason === "length") return "length";
	if (finishReason === "tool_calls" || toolCalls > 0) return "tool_calls";
	return "stop";
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function isAbort(msg: string): boolean {
	return /abort/i.test(msg);
}
