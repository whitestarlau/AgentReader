import {
	clipText,
	type ExportBundle,
	type ExportOptions,
	type ExportTimelineItem,
	formatLocal,
	formatTime,
	normalizeNewlines,
	parseUserPrompt,
	prettyToolArgs,
	type RefBlock,
	refTitle,
	type TranscriptRow,
	visibleTimelineItems,
} from "../../shared/chat-export.ts";
import { escapeHtml, htmlDocument } from "./template.ts";

/**
 * Render one conversation as a standalone HTML file. The unified/remark
 * pipeline is imported lazily so Markdown/JSON exports (and app startup) don't
 * pay for it.
 */
export async function renderHtml(bundle: ExportBundle, opts: ExportOptions): Promise<string> {
	const { renderMarkdownToHtml } = await import("./markdown-to-html.ts");
	const conversation = bundle.conversations[0];
	const exportedAt = Date.parse(bundle.exportedAt);
	const body = conversation.messages
		.map((message, index) => renderMessage(message, opts, index, renderMarkdownToHtml))
		.join("\n");

	return htmlDocument({
		title: `${conversation.title} · ${bundle.document.name} · AgentReader`,
		heading: conversation.title,
		meta: [
			`文档：${bundle.document.title}`,
			`${conversation.messages.length} 条消息`,
			`导出于 ${formatLocal(exportedAt)}`,
		],
		body,
		footer: `由 AgentReader 导出 · ${formatLocal(exportedAt)}`,
	});
}

function renderMessage(
	message: TranscriptRow,
	opts: ExportOptions,
	index: number,
	renderMarkdownToHtml: (markdown: string) => string,
): string {
	const isAssistant = message.role === "assistant";
	const roleLabel = isAssistant ? "助手" : "你";
	const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;
	const time = formatTime(timestamp);
	const timeHtml = time
		? `<time${
				timestamp !== undefined
					? ` datetime="${escapeHtml(new Date(timestamp).toISOString())}"`
					: ""
			} title="${escapeHtml(formatLocal(timestamp))}">${time}</time>`
		: "";

	const head = `<header class="turn-head"><span class="role">${roleLabel}</span>${timeHtml}</header>`;
	const id = `m${index + 1}`;

	if (!isAssistant) {
		const { refs, question } = parseUserPrompt(message.content ?? "");
		const questionHtml = question.trim()
			? renderMarkdownToHtml(question)
			: `<p class="muted">（无问题文本）</p>`;
		const refsHtml = opts.includeRefs && refs.length > 0 ? renderRefs(refs) : "";
		return `<article class="turn user" id="${id}">${head}<div class="turn-body md">${questionHtml}</div>${refsHtml}</article>`;
	}

	const content = normalizeNewlines(message.content ?? "");
	const contentHtml = content.trim() ? renderMarkdownToHtml(content) : "";
	const visible = visibleTimelineItems(message.timeline, opts);
	const traceHtml = visible.length > 0 ? renderTrace(visible, opts) : "";
	const noticeHtml = message.notice
		? `<div class="notice">⚠️ ${escapeHtml(message.notice)}</div>`
		: "";
	const emptyHtml =
		!contentHtml && !traceHtml && !noticeHtml ? `<p class="muted">（无内容）</p>` : "";
	const body = contentHtml || emptyHtml;

	return `<article class="turn assistant" id="${id}">${head}<div class="turn-body md">${body}</div>${traceHtml}${noticeHtml}</article>`;
}

function renderRefs(refs: RefBlock[]): string {
	const items = refs
		.map(
			(ref) =>
				`<div class="ref"><div class="ref-head">${escapeHtml(refTitle(ref.header))}</div>${
					ref.body ? `<pre class="ref-body">${escapeHtml(ref.body)}</pre>` : ""
				}</div>`,
		)
		.join("");
	return `<details class="refs"><summary>引用 ${refs.length} 条</summary>${items}</details>`;
}

function renderTrace(items: ExportTimelineItem[], opts: ExportOptions): string {
	const reasoningCount = items.filter((item) => item.kind === "reasoning").length;
	const toolCount = items.length - reasoningCount;
	const summary = [
		reasoningCount > 0 ? `思考 ${reasoningCount} 段` : "",
		toolCount > 0 ? `工具 ${toolCount} 次` : "",
	]
		.filter(Boolean)
		.join(" · ");

	const steps = items
		.map((item) => {
			if (item.kind === "reasoning") {
				return `<section class="step"><h4>思考</h4><pre>${escapeHtml(item.content)}</pre></section>`;
			}
			const args = prettyToolArgs(item.args);
			const pending = item.pending ? `<span class="pending">未完成</span>` : "";
			return `<section class="step"><h4>工具 <code>${escapeHtml(item.name)}</code>${pending}</h4>${
				args.text ? `<pre class="args">${escapeHtml(args.text)}</pre>` : ""
			}${
				opts.includeToolResults && item.result !== undefined
					? `<pre class="result">${escapeHtml(clipText(item.result))}</pre>`
					: ""
			}</section>`;
		})
		.join("");

	return `<details class="trace"><summary>${summary}</summary>${steps}</details>`;
}
