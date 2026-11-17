import assert from "node:assert/strict";
import test from "node:test";
import { splitSentences } from "./segment.ts";

const texts = (input: string) => splitSentences(input).map((s) => s.text);

test("splits on CJK terminators and keeps offsets exact", () => {
	const input = "第一句。第二句！第三句？";
	const segs = splitSentences(input);
	assert.deepEqual(
		segs.map((s) => s.text),
		["第一句。", "第二句！", "第三句？"],
	);
	for (const seg of segs) assert.equal(input.slice(seg.start, seg.end), seg.text);
});

test("keeps closing quotes with the sentence they close", () => {
	const input = "他说：“走。”然后离开。";
	assert.deepEqual(texts(input), ["他说：“走。”", "然后离开。"]);
});

test("treats repeated punctuation as one boundary", () => {
	assert.deepEqual(texts("真的吗？！好吧……我们继续。"), ["真的吗？！", "好吧……", "我们继续。"]);
});

test("does not split decimals or latin abbreviations", () => {
	assert.deepEqual(texts("Pi is 3.14 today. Mr. Smith agreed. Done."), [
		"Pi is 3.14 today.",
		"Mr. Smith agreed.",
		"Done.",
	]);
});

test("splits paragraphs on newlines and trims whitespace", () => {
	const input = "第一段。\n\n第二段。\n  第三段";
	const segs = splitSentences(input);
	assert.deepEqual(
		segs.map((s) => s.text),
		["第一段。", "第二段。", "第三段"],
	);
	for (const seg of segs) assert.equal(input.slice(seg.start, seg.end), seg.text);
});

test("splits an over-long sentence at secondary punctuation", () => {
	const long = `${"甲".repeat(60)}，${"乙".repeat(60)}，${"丙".repeat(60)}。`;
	const segs = splitSentences(long, { maxChars: 100 });
	assert.ok(segs.length >= 2, "expected the sentence to be split");
	assert.ok(
		segs.every((s) => s.text.length <= 100),
		"every piece must respect the limit",
	);
	for (const seg of segs) assert.equal(long.slice(seg.start, seg.end), seg.text);
	// The trailing terminator stays with the last piece.
	assert.ok(segs.at(-1)?.text.endsWith("。"));
});

test("hard-splits text with no secondary punctuation", () => {
	const long = "丙".repeat(250);
	const segs = splitSentences(long, { maxChars: 100 });
	assert.ok(segs.length >= 3);
	assert.ok(segs.every((s) => s.text.length <= 100));
	assert.equal(segs.map((s) => s.text).join(""), long);
});

test("never splits a surrogate pair", () => {
	const long = `${"😀".repeat(60)}`;
	const segs = splitSentences(long, { maxChars: 61 });
	for (const seg of segs) assert.equal(long.slice(seg.start, seg.end), seg.text);
	assert.equal(segs.map((s) => s.text).join(""), long);
});

test("returns nothing for whitespace-only input", () => {
	assert.deepEqual(splitSentences("   \n\n  "), []);
});

test("forced page breaks split a sentence at the boundary", () => {
	const text = "这一句话被分页切开了前后两半。";
	const segments = splitSentences(text, { breaks: [8] });
	assert.equal(segments.length, 2);
	assert.equal(segments[0]?.text, "这一句话被分页切");
	assert.equal(segments[1]?.text, "开了前后两半。");
	assert.equal(segments[0]?.start, 0);
	assert.equal(segments[0]?.end, 8);
	for (const seg of segments) assert.equal(text.slice(seg.start, seg.end), seg.text);
});
