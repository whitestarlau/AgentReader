import assert from "node:assert/strict";
import test from "node:test";
import type { ExportBundle, ExportOptions } from "../../shared/chat-export.ts";
import { renderHtml } from "./html.ts";
import { renderJson } from "./json.ts";
import { renderMarkdown } from "./markdown.ts";

const bundle: ExportBundle = {
	format: "agentreader.conversation-export",
	version: 1,
	exportedAt: "2026-11-03T14:11:32.000Z",
	generator: { app: "AgentReader", version: "0.2.0" },
	scope: "current",
	document: { id: "doc", title: "利率与周期.pdf", name: "利率与周期", ext: "pdf" },
	conversations: [
		{
			id: "conv",
			title: "利率与周期",
			messages: [
				{
					id: "m1",
					timestamp: 1762170000000,
					role: "user",
					content: "【引用文本 · 第12页 · 选中】\n利率是资金的价格。\n\n【问题】\n这句话怎么理解？",
				},
				{
					id: "m2",
					timestamp: 1762170005000,
					role: "assistant",
					content:
						"这句话的意思是 **利率**。\n\n[危险链接](javascript:alert(1))\n\n<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>",
					timeline: [
						{ kind: "reasoning", content: "先看上下文……" },
						{
							kind: "tool",
							id: "call_1",
							name: "search_document",
							args: '{"query":"利率"}',
							result: "结果第一行\n结果第二行",
							pending: false,
						},
					],
					notice: "已达到单轮工具调用上限……",
				},
			],
		},
	],
};

const defaults: ExportOptions = {
	format: "html",
	includeRefs: true,
	includeReasoning: false,
	includeTools: true,
	includeToolResults: false,
	openAfter: false,
};

test("HTML export sanitizes dangerous links and raw HTML", async () => {
	const html = await renderHtml(bundle, defaults);
	assert.ok(!html.includes("javascript:"));
	assert.ok(!html.toLowerCase().includes("onerror"));
	assert.ok(!html.includes("<script>alert"));
	assert.ok(html.includes("<a>危险链接</a>"));
});

test("HTML export honours the content toggles", async () => {
	const defaultHtml = await renderHtml(bundle, defaults);
	assert.ok(defaultHtml.includes('class="refs"'));
	assert.ok(!defaultHtml.includes("<h4>思考</h4>"));
	assert.ok(defaultHtml.includes("<h4>工具"));
	assert.ok(!defaultHtml.includes('class="result"'));

	const fullHtml = await renderHtml(bundle, {
		...defaults,
		includeReasoning: true,
		includeToolResults: true,
	});
	assert.ok(fullHtml.includes("<h4>思考</h4>"));
	assert.ok(fullHtml.includes('class="result"'));

	const noRefs = await renderHtml(bundle, { ...defaults, includeRefs: false });
	assert.ok(!noRefs.includes('class="refs"'));
});

test("Markdown export keeps the question, citations and optional trace", () => {
	const md = renderMarkdown(bundle, { ...defaults, format: "md" });
	assert.ok(md.includes("# 利率与周期"));
	assert.ok(md.includes("> **引用文本 · 第12页 · 选中**"));
	assert.ok(md.includes("这句话怎么理解？"));
	assert.ok(!md.includes("**思考**"));
	assert.ok(md.includes("**工具 `search_document`**"));

	const full = renderMarkdown(bundle, {
		...defaults,
		format: "md",
		includeReasoning: true,
		includeToolResults: true,
	});
	assert.ok(full.includes("**思考**"));
	assert.ok(full.includes("结果（截断）："));
});

test("JSON export preserves raw fields and omits local paths", () => {
	const json = renderJson(bundle);
	const parsed = JSON.parse(json) as ExportBundle;
	assert.equal(parsed.format, "agentreader.conversation-export");
	assert.equal(parsed.scope, "current");
	assert.equal(parsed.conversations[0].messages[1].notice, "已达到单轮工具调用上限……");
	assert.ok(!json.includes("originalPath"));
});
