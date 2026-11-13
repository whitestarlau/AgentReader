import assert from "node:assert/strict";
import test from "node:test";
import {
	defaultExportFileName,
	ensureExtension,
	fence,
	formatFromPath,
	normalizeExportOptions,
	parseUserPrompt,
	prettyToolArgs,
	sanitizeFilename,
} from "./chat-export.ts";

test("parseUserPrompt separates citations from the question", () => {
	const parsed = parseUserPrompt(
		"【引用文本 · 第12页 · 选中】\n利率是资金的价格。\n\n【引用章节 · 第3章】\n\n【问题】\n这句话怎么理解？",
	);
	assert.equal(parsed.refs.length, 2);
	assert.equal(parsed.refs[0].header, "【引用文本 · 第12页 · 选中】");
	assert.equal(parsed.refs[0].body, "利率是资金的价格。");
	assert.equal(parsed.refs[1].body, "");
	assert.equal(parsed.question, "这句话怎么理解？");
});

test("parseUserPrompt leaves a plain question untouched", () => {
	const parsed = parseUserPrompt("just a question");
	assert.deepEqual(parsed.refs, []);
	assert.equal(parsed.question, "just a question");
});

test("sanitizeFilename removes path/Windows-illegal characters and reserved names", () => {
	assert.equal(sanitizeFilename('a/b:c*d?e"f<g>h|i'), "a-b-c-d-e-f-g-h-i");
	assert.equal(sanitizeFilename("  ..name..  "), "name");
	assert.equal(sanitizeFilename("CON"), "_CON");
	assert.ok(Buffer.byteLength(sanitizeFilename("很长".repeat(100))) <= 180);
});

test("defaultExportFileName keeps the requested extension and a readable stem", () => {
	const name = defaultExportFileName(
		"利率与周期.pdf",
		"利率 / 周期",
		"html",
		new Date(2026, 10, 3, 22, 11),
	);
	assert.match(name, /^AgentReader-利率与周期-利率 - 周期-20261103-2211\.html$/);
});

test("normalizeExportOptions applies the documented defaults", () => {
	const options = normalizeExportOptions(undefined);
	assert.equal(options.format, "md");
	assert.equal(options.includeRefs, true);
	assert.equal(options.includeReasoning, false);
	assert.equal(options.includeTools, true);
	assert.equal(options.includeToolResults, false);
	assert.equal(options.openAfter, false);
});

test("format inference and extension normalization", () => {
	assert.equal(formatFromPath("a.markdown"), "md");
	assert.equal(formatFromPath("a.htm"), "html");
	assert.equal(formatFromPath("a.txt"), null);
	assert.equal(ensureExtension("/tmp/a", "md"), "/tmp/a.md");
	assert.equal(ensureExtension("/tmp/a.md", "json"), "/tmp/a.json");
	assert.equal(ensureExtension("/tmp/a.HTML", "html"), "/tmp/a.HTML");
});

test("fence grows longer than the content's backtick runs", () => {
	const fenced = fence("```js\nconst a = 1;\n```", "md");
	assert.ok(fenced.startsWith("````md"));
	assert.ok(fenced.endsWith("````"));
});

test("prettyToolArgs pretty-prints valid JSON and falls back to text", () => {
	assert.deepEqual(prettyToolArgs('{"query":"利率"}'), {
		text: '{\n  "query": "利率"\n}',
		lang: "json",
	});
	assert.deepEqual(prettyToolArgs("not json"), { text: "not json", lang: "text" });
});
