import {
	clipText,
	type ExportBundle,
	type ExportOptions,
	type ExportTimelineItem,
	fence,
	formatIsoWithOffset,
	formatLocal,
	normalizeNewlines,
	oneLine,
	parseUserPrompt,
	prettyToolArgs,
	refTitle,
	type TranscriptRow,
	visibleTimelineItems,
	yamlString,
} from "../../shared/chat-export.ts";

/**
 * Render one conversation as a portable Markdown document.
 *
 * Citation blocks become blockquotes (works in every Markdown renderer);
 * optional reasoning/tool traces are wrapped in `<details>` so they stay
 * collapsed on GitHub/VS Code/Obsidian without cluttering the Q&A.
 */
export function renderMarkdown(bundle: ExportBundle, opts: ExportOptions): string {
	const conversation = bundle.conversations[0];
	const lines: string[] = [];

	lines.push(
		"---",
		`generator: "AgentReader"`,
		"format_version: 1",
		`document: ${yamlString(bundle.document.title)}`,
		`document_name: ${yamlString(bundle.document.name)}`,
		`document_type: ${yamlString(bundle.document.ext)}`,
		`conversation: ${yamlString(conversation.title)}`,
		`scope: "current"`,
		`exported_at: ${yamlString(formatIsoWithOffset(new Date(bundle.exportedAt)))}`,
		`message_count: ${conversation.messages.length}`,
		"---",
		"",
	);

	lines.push(`# ${oneLine(conversation.title)}`, "");
	lines.push(
		`> 文档：${oneLine(bundle.document.title)} · ${conversation.messages.length} 条消息 · 导出于 ${formatLocal(
			Date.parse(bundle.exportedAt),
		)}`,
		"",
	);

	for (const message of conversation.messages) {
		lines.push(...renderMessage(message, opts), "");
	}

	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()}\n`;
}

function renderMessage(message: TranscriptRow, opts: ExportOptions): string[] {
	const role = message.role === "assistant" ? "助手" : "你";
	const time = formatLocal(message.timestamp);
	const lines: string[] = [`## ${role}${time ? ` · ${time}` : ""}`, ""];

	if (message.role !== "assistant") {
		const { refs, question } = parseUserPrompt(message.content ?? "");
		if (opts.includeRefs) {
			for (const ref of refs) {
				lines.push(`> **${oneLine(refTitle(ref.header))}**`);
				if (ref.body) {
					lines.push(">");
					for (const line of normalizeNewlines(ref.body).split("\n")) {
						lines.push(line ? `> ${line}` : ">");
					}
				}
				lines.push("");
			}
		}
		if (question.trim()) lines.push(question.replace(/\s+$/, ""), "");
		return lines;
	}

	const content = normalizeNewlines(message.content ?? "");
	if (content.trim()) lines.push(content.replace(/\s+$/, ""), "");

	const visible = visibleTimelineItems(message.timeline, opts);
	if (visible.length > 0) {
		lines.push(...renderTimeline(visible, opts), "");
	}

	if (message.notice) lines.push(`> ⚠️ ${oneLine(message.notice)}`, "");

	if (!content.trim() && visible.length === 0 && !message.notice) {
		lines.push("（无内容）", "");
	}
	return lines;
}

function renderTimeline(items: ExportTimelineItem[], opts: ExportOptions): string[] {
	const reasoningCount = items.filter((item) => item.kind === "reasoning").length;
	const toolCount = items.length - reasoningCount;
	const summary = [
		reasoningCount > 0 ? `思考 ${reasoningCount} 段` : "",
		toolCount > 0 ? `工具 ${toolCount} 次` : "",
	]
		.filter(Boolean)
		.join(" · ");

	const lines = ["<details>", `<summary>${summary}</summary>`, ""];
	for (const item of items) {
		if (item.kind === "reasoning") {
			lines.push("**思考**", "", fence(item.content, "text"), "");
			continue;
		}
		const pending = item.pending ? "（未完成）" : "";
		lines.push(`**工具 \`${oneLine(item.name)}\`**${pending}`, "");
		const args = prettyToolArgs(item.args);
		if (args.text) {
			lines.push("参数：", "", fence(args.text, args.lang), "");
		}
		if (opts.includeToolResults && item.result !== undefined) {
			lines.push("结果（截断）：", "", fence(clipText(item.result), "text"), "");
		}
	}
	lines.push("</details>");
	return lines;
}
