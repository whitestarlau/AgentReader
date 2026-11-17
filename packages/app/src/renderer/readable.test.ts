import assert from "node:assert/strict";
import test from "node:test";
import { geometrySeparator, revealOffset, revealRangeIn } from "./readable.ts";

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

test("revealOffset keeps an already visible target still", () => {
	assert.equal(
		revealOffset({
			targetStart: 140,
			targetSize: 20,
			viewStart: 100,
			viewSize: 500,
			block: "center",
			margin: 24,
		}),
		100,
	);
});

test("revealOffset nearest only moves when the target leaves the padded viewport", () => {
	// Below the bottom edge: end + padding becomes the new bottom.
	assert.equal(
		revealOffset({
			targetStart: 620,
			targetSize: 20,
			viewStart: 100,
			viewSize: 500,
			block: "nearest",
			margin: 24,
		}),
		164,
	);
	// Above the top edge: start - padding becomes the new top.
	assert.equal(
		revealOffset({
			targetStart: 90,
			targetSize: 20,
			viewStart: 100,
			viewSize: 500,
			block: "nearest",
			margin: 24,
		}),
		66,
	);
});

test("revealOffset center places a newly reached sentence above the middle", () => {
	const next = revealOffset({
		targetStart: 900,
		targetSize: 20,
		viewStart: 100,
		viewSize: 500,
		block: "center",
		margin: 24,
	});
	assert.equal(next, 900 - Math.min(500 * 0.32, (500 - 20) / 2));
});

function fakeContainer(overrides: Partial<Record<"scrollTop" | "scrollLeft", number>> = {}) {
	const calls: { top?: number; left?: number }[] = [];
	const container = {
		scrollTop: overrides.scrollTop ?? 100,
		scrollLeft: overrides.scrollLeft ?? 0,
		clientHeight: 500,
		clientWidth: 300,
		scrollHeight: 2000,
		scrollWidth: 1000,
		getBoundingClientRect: () => ({
			top: 0,
			left: 0,
			right: 300,
			bottom: 500,
			width: 300,
			height: 500,
		}),
		scrollTo: (o: { top?: number; left?: number }) => calls.push({ top: o.top, left: o.left }),
	} as unknown as HTMLElement;
	return { container, calls };
}

function fakeRange(top: number, height = 20, left = 10, width = 40) {
	return {
		getBoundingClientRect: () => ({
			top,
			bottom: top + height,
			left,
			right: left + width,
			width,
			height,
		}),
		startContainer: { ownerDocument: { defaultView: { frameElement: null } } },
	} as unknown as Range;
}

test("revealRangeIn scrolls exactly one container, never the page shell", () => {
	const { container, calls } = fakeContainer({ scrollTop: 0 });
	revealRangeIn(container, fakeRange(620), { block: "nearest", inline: "none" });
	assert.deepEqual(calls, [{ top: 164, left: 0 }]);
});

test("revealRangeIn does not move a sentence that is already visible", () => {
	const { container, calls } = fakeContainer();
	revealRangeIn(container, fakeRange(140), { block: "center" });
	assert.deepEqual(calls, []);
});
