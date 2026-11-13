import assert from "node:assert/strict";
import test from "node:test";
import { geometrySeparator } from "./readable.ts";

const box = (top: number, left: number, height = 20, width = 100) => ({
	top,
	bottom: top + height,
	left,
	right: left + width,
	height,
});

test("a vertical gap becomes a hard break (heading / paragraph)", () => {
	// Next line starts well below the previous line's bottom.
	assert.equal(geometrySeparator(box(0, 0), box(34, 0), "第三章", "正文开始"), "\n");
});

test("adjacent lines of the same paragraph stay unbroken", () => {
	assert.equal(geometrySeparator(box(0, 0), box(22, 0), "上一行", "下一行继续"), "");
});

test("a horizontal gap becomes a word space", () => {
	assert.equal(geometrySeparator(box(0, 0), box(0, 140), "hello", "world"), " ");
});

test("glyphs that touch are one run", () => {
	assert.equal(geometrySeparator(box(0, 0, 20, 12), box(0, 12, 20, 12), "B", "e"), "");
});

test("missing boxes fall back to the text heuristic", () => {
	assert.equal(geometrySeparator(null, null, "hello", "world"), " ");
	assert.equal(geometrySeparator(null, null, "中", "文"), "");
});
