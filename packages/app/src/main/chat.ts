import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { buildDocumentSystemPrompt, runAgentLoop } from "@agentreader/agent";
import type { StreamFn } from "@agentreader/ai";
import { BrowserWindow, ipcMain } from "electron";
import {
	buildRuntime,
	generateConversationTitle,
	getAgentMaxTurns,
	getWebSearchConfig,
	modelRef,
	resolveCurrentModel,
} from "./ai.ts";
import { buildChatTools } from "./chat-tools.ts";
import { appendChatEntry, chatFile, ensureConversations, saveConversations } from "./conversations.ts";
import { readReaderChapter } from "./doc-state.ts";
import { type DocText, getDocText } from "./doc-text.ts";
import { getDocDir } from "./paths.ts";
import { readSettings } from "./settings.ts";
import { loadSkills, readDocSkills, readTrusted } from "./skills.ts";

/** The streaming chat turn: model resolution, tools, agent loop, persistence. */

/** In-flight chat streams keyed by `${docId}:${convId}`, so the UI can stop them. */
export const activeChats = new Map<string, AbortController>();

export function registerChatIpc() {
	ipcMain.handle("chat:stop", (_e, docId: string, convId: string) => {
		activeChats.get(`${docId}:${convId}`)?.abort();
		return true;
	});

	ipcMain.handle(
		"chat:send",
		async (
			event,
			docId: string,
			convId: string,
			prompt: string,
			history: { role: string; content: string }[],
			page?: number,
			persistUser = true,
		) => {
			const { runtime, file } = buildRuntime();
			const model = resolveCurrentModel(runtime, file);
			if (!model) return { error: "未配置可用模型，请在设置中添加提供商与模型" };
			if (!runtime.resolveApiKey(model.provider)) {
				return { error: `未配置 ${model.provider} 的 API Key，请在设置中填写` };
			}

			// Register a controller so the UI can stop generation mid-stream.
			const chatKey = `${docId}:${convId}`;
			activeChats.get(chatKey)?.abort();
			const controller = new AbortController();
			activeChats.set(chatKey, controller);

			// First user message in this conversation -> let the model name it.
			// Determine "first" from the on-disk transcript rather than trusting the
			// renderer's history array (which can be stale right after creating a chat).
			let generatedTitle: string | null = null;
			let isFirstMessage = false;
			try {
				const p = chatFile(docId, convId);
				const raw = existsSync(p) ? readFileSync(p, "utf-8").trim() : "";
				isFirstMessage = raw.split("\n").filter(Boolean).length === 0;
			} catch {
				isFirstMessage = history.length === 0;
			}
			if (isFirstMessage && prompt.trim()) {
				generatedTitle = await generateConversationTitle(runtime, model, prompt);
				console.log("[chat] title generated", JSON.stringify(generatedTitle));
				// Fall back to a snippet of the user's message so the title is never
				// left as the generic "对话 N" placeholder.
				if (!generatedTitle) {
					const snippet = prompt
						.replace(/^【[\s\S]*?】\s*/, "")
						.replace(/\s+/g, " ")
						.trim()
						.slice(0, 16);
					if (snippet) generatedTitle = snippet;
				}
				if (generatedTitle) {
					try {
						const list = ensureConversations(docId);
						const conv = list.find((c: { id: string }) => c.id === convId);
						if (conv) {
							conv.title = generatedTitle;
							conv.updatedAt = Date.now();
							saveConversations(docId, list);
						}
					} catch {}
				}
			}

			// Persist the user turn with a stable id so it can be edited later.
			// Edits already rewrote the stored line, so they skip this.
			const userEntry = persistUser
				? appendChatEntry(docId, convId, { role: "user", content: prompt })
				: null;

			const docText: DocText = await getDocText(docId).catch(() => ({
				pages: [] as string[],
				numPages: 0,
				unit: "page" as const,
				toc: [] as { label: string; href: string }[],
				title: docId,
				ext: "pdf",
				isScanned: false,
				ocrCount: 0,
				getPage: async () => "",
			}));
			// EPUB: anchor on the chapter the reader is currently in. Chapters are exact
			// (spine order) and render-independent — unlike "pages", they can't drift.
			// The current chapter's text is included so the model has immediate context.
			const readerChapter = docText.unit === "chapter" ? readReaderChapter(docId) : undefined;
			const hintText =
				docText.unit === "chapter"
					? readerChapter
						? (await docText.getPage(readerChapter)) || ""
						: ""
					: typeof page === "number" && page > 0
						? await docText.getPage(Math.min(page, docText.numPages || page))
						: "";

			const webSearch = getWebSearchConfig();
			const useNativeSearch =
				webSearch.enabled &&
				webSearch.backend === "native" &&
				(model.api ?? "openai-completions") === "anthropic-messages";
			const enabledSkillNames = readDocSkills(getDocDir(docId));
			const enabledSkills = loadSkills().skills.filter((s) => enabledSkillNames.includes(s.name));
			const skillsExecution = readSettings().skillsExecutionEnabled === "1";
			const trustedSkills = new Set(readTrusted());
			// When execution is enabled, expose the tool for every enabled skill;
			// each run is confirmed with the user unless the skill is trusted.
			const executableSkills = skillsExecution ? enabledSkills : [];
			const toolNames = ["get_document_info", "search_document"];
			if (docText.unit === "chapter") toolNames.push("read_chapter", "locate_text");
			else toolNames.push("read_page");
			if (webSearch.enabled) toolNames.push("web_search");
			if (enabledSkills.length) toolNames.push("read_skill");
			if (executableSkills.length) toolNames.push("run_skill_script");

			const systemPrompt = buildDocumentSystemPrompt({
				title: docText.title,
				ext: docText.ext,
				numPages: docText.numPages,
				unit: docText.unit,
				chapterLabels: docText.chapterLabels,
				readerChapter,
				tocLabels: docText.toc.slice(0, 20).map((t) => t.label),
				currentText: hintText,
				ocr: { isScanned: docText.isScanned, ocrCount: docText.ocrCount },
				toolNames,
				webSearchEnabled: webSearch.enabled,
				skills: enabledSkills.map((s) => ({
					name: s.name,
					description: s.description,
					executable: executableSkills.includes(s),
					trusted: trustedSkills.has(s.name),
				})),
				skillsExecutionEnabled: skillsExecution,
			});

			const messages = [...history, { role: "user", content: prompt }];
			console.log(
				"[chat] messages",
				messages.map((m) => `${m.role}: ${String(m.content).slice(0, 120)}`),
			);

			console.log("[chat] request", {
				model: modelRef(model),
				historyLen: history.length,
				title: docText.title,
			});

			const win = BrowserWindow.fromWebContents(event.sender);
			const tools = buildChatTools({
				docText,
				webSearch,
				useNativeSearch,
				enabledSkills,
				executableSkills,
				trustedSkills,
				win,
				convId,
			});

			let full = "";
			const streamFn: StreamFn = (m, c, o) => runtime.stream(m, c, { ...o, sessionId: convId });

			// 结构化记录本轮对话（思考 / 工具调用 / 最终回答），用于持久化与回放。
			type StoredTimelineItem =
				| { kind: "reasoning"; content: string }
				| { kind: "tool"; id: string; name: string; args: string; result?: string; pending: boolean };
			const timeline: StoredTimelineItem[] = [];
			let timelineReasoning: Extract<StoredTimelineItem, { kind: "reasoning" }> | null = null;
			const pushReasoning = (delta: string) => {
				if (!timelineReasoning) {
					timelineReasoning = { kind: "reasoning", content: "" };
					timeline.push(timelineReasoning);
				}
				timelineReasoning.content += delta;
			};
			const persistAssistant = () => {
				if (!full && timeline.length === 0) return;
				appendFileSync(
					chatFile(docId, convId),
					`${JSON.stringify({
						id: randomUUID(),
						timestamp: Date.now(),
						role: "assistant",
						content: full,
						timeline,
					})}\n`,
				);
			};

			let lastError: string | null = null;
			try {
				for await (const evt of runAgentLoop(
					messages as never,
					model as never,
					streamFn as never,
					{
						systemPrompt,
						tools,
						maxTurns: getAgentMaxTurns(),
					} as never,
					controller.signal,
				)) {
					if (evt.type === "message_delta") {
						full += (evt as { delta: string }).delta;
						win?.webContents.send("chat:delta", (evt as { delta: string }).delta);
					} else if (evt.type === "reasoning_delta") {
						const delta = (evt as { delta: string }).delta;
						pushReasoning(delta);
						win?.webContents.send("chat:reasoning_delta", delta);
					} else if (evt.type === "tool_call") {
						const t = evt as { id: string; name: string; args: string };
						timeline.push({ kind: "tool", id: t.id, name: t.name, args: t.args, pending: true });
						win?.webContents.send("chat:tool_call", { id: t.id, name: t.name, args: t.args });
						console.log("[tool] call", t.name, t.args);
					} else if (evt.type === "tool_result") {
						const r = evt as { id: string; name?: string; result: string };
						const item = timeline.find((it) => it.kind === "tool" && it.id === r.id) as
							| Extract<StoredTimelineItem, { kind: "tool" }>
							| undefined;
						if (item) {
							item.result = r.result;
							item.pending = false;
						}
						win?.webContents.send("chat:tool_result", {
							id: r.id,
							name: r.name ?? item?.name ?? "",
							result: r.result,
						});
						console.log("[tool] result", r.id, r.result.slice(0, 200));
					} else if (evt.type === "done") {
						const d = evt as { stopReason: string; error?: string };
						console.log("[chat] agent done", d);
						if (d.stopReason === "error") {
							lastError = d.error || "unknown";
							console.error("[chat] agent error", JSON.stringify(d));
						}
					}
				}
				if (lastError) {
					console.error("[chat] final error", lastError);
					console.log("[chat] retry without tools");
					full = "";
					try {
						const fallbackStream = streamFn;
						const fallbackContext = {
							systemPrompt,
							messages: [...history, { role: "user", content: prompt }] as never,
						};
						for await (const e of fallbackStream(
							model,
							fallbackContext as never,
							{
								signal: controller.signal,
							} as never,
						)) {
							if (e.type === "text_delta") {
								full += (e as { delta: string }).delta;
								win?.webContents.send("chat:delta", (e as { delta: string }).delta);
							} else if (e.type === "reasoning_delta") {
								const delta = (e as { delta: string }).delta;
								pushReasoning(delta);
								win?.webContents.send("chat:reasoning_delta", delta);
							} else if (e.type === "done" && (e as { stopReason: string }).stopReason === "error") {
								return { error: (e as { error?: string }).error || lastError };
							}
						}
						persistAssistant();
						win?.webContents.send("chat:done", full);
						return {
							ok: true,
							content: full,
							title: generatedTitle ?? undefined,
							userId: userEntry?.id,
						};
					} catch (e) {
						console.error("[chat] fallback error", e);
						return { error: lastError };
					}
				}
				persistAssistant();
				win?.webContents.send("chat:done", full);
				return { ok: true, content: full, title: generatedTitle ?? undefined, userId: userEntry?.id };
			} catch (e) {
				console.error("[chat] fetch error", e);
				persistAssistant();
				return { error: String(e) };
			} finally {
				if (activeChats.get(chatKey) === controller) activeChats.delete(chatKey);
			}
		},
	);
}
