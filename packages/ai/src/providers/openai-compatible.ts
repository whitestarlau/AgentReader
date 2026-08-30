import type { AssistantMessageEvent, Context, Model, StreamFn, StreamOptions } from "../types.ts";

export function createOpenAICompatibleProvider(
	baseUrl: string,
	apiKey: string,
	sessionId?: string,
) {
	const stream: StreamFn = async function* (
		model: Model,
		context: Context,
		options: StreamOptions,
	): AsyncGenerator<AssistantMessageEvent> {
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
				if (
					m.role === "assistant" &&
					(m as unknown as { toolCalls?: { id: string; name: string; arguments: string }[] })
						.toolCalls?.length
				) {
					const tc = (
						m as unknown as { toolCalls: { id: string; name: string; arguments: string }[] }
					).toolCalls;
					return {
						role: "assistant",
						content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
						tool_calls: tc.map((t) => ({
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

		const tools = context.tools?.length
			? context.tools.map((t) => ({
					type: "function" as const,
					function: { name: t.name, description: t.description, parameters: t.parameters },
				}))
			: undefined;

		const cleanBase = baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			"User-Agent": "agentreader/0.1.0",
		};
		if (sessionId) headers["x-opencode-session"] = sessionId;
		if ((options as unknown as { sessionId?: string })?.sessionId)
			headers["x-opencode-session"] = (options as unknown as { sessionId: string }).sessionId;

		const res = await fetch(`${cleanBase}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: model.id,
				messages,
				...(tools ? { tools, tool_choice: "auto" } : {}),
				stream: true,
				max_tokens: options.maxTokens,
				temperature: options.temperature ?? 0.7,
			}),
			signal: options.signal,
		});

		if (!res.ok || !res.body) {
			const body = await res.text().catch(() => "");
			yield {
				type: "done",
				stopReason: "error",
				error: `HTTP ${res.status} ${body.slice(0, 800)}`,
			};
			return;
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		const toolAccum = new Map<number, { id: string; name: string; args: string }>();
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
						for (const [, tc] of toolAccum)
							yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };
						yield { type: "done", stopReason: toolAccum.size ? "tool_calls" : "stop" };
						return;
					}
					try {
						const json = JSON.parse(data);
						const choice = json.choices?.[0];
						const delta = choice?.delta;
						if (delta?.content) yield { type: "text_delta", delta: delta.content };
						// 思考内容：不同服务商字段名不同
						const reasoning =
							delta?.reasoning_content ??
							delta?.reasoning ??
							delta?.thinking ??
							delta?.reasoning_details;
						if (typeof reasoning === "string" && reasoning) {
							yield { type: "reasoning_delta", delta: reasoning };
						}
						if (delta?.tool_calls) {
							for (const tc of delta.tool_calls as {
								index: number;
								id?: string;
								function?: { name?: string; arguments?: string };
							}[]) {
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
							for (const tc of choice.message.tool_calls as {
								id: string;
								function: { name: string; arguments: string };
							}[]) {
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
					} catch {}
				}
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes("abort")) yield { type: "done", stopReason: "aborted" };
			else yield { type: "done", stopReason: "error", error: msg };
		}
		if (toolAccum.size)
			for (const [, tc] of toolAccum)
				yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };
		yield { type: "done", stopReason: toolAccum.size ? "tool_calls" : "stop" };
	};

	return { stream };
}
