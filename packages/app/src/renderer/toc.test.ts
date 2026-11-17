import assert from "node:assert/strict";
import test from "node:test";
import { flattenToc } from "./toc.ts";

test("keeps TOC fragments so entries sharing a spine file stay distinct", () => {
	const items = flattenToc(
		[
			{ label: "卷一", href: "split_006.html#juan1" },
			{ label: "卷二", href: "split_006.html#juan2" },
			{ label: "卷三", href: "split_008.html" },
		],
		() => 8,
	);
	assert.deepEqual(
		items.map((i) => i.href),
		["split_006.html#juan1", "split_006.html#juan2", "split_008.html"],
	);
	assert.deepEqual(
		items.map((i) => i.page),
		[8, 8, 8],
	);
});

test("flattens nested entries in reading order with depth", () => {
	const items = flattenToc(
		[
			{
				label: "卷六",
				href: "split_014.html#juan6",
				subitems: [
					{ label: "董卓", href: "split_014.html#dongzhuo" },
					{ label: "袁绍", href: "split_015.html#yuanshao" },
				],
			},
		],
		(href) => (href.includes("split_015") ? 16 : 15),
	);
	assert.deepEqual(
		items.map((i) => [i.title, i.page, i.depth]),
		[
			["卷六", 15, 0],
			["董卓", 15, 1],
			["袁绍", 16, 1],
		],
	);
});

test("an unresolved href stays in the list but has no locator", () => {
	const items = flattenToc([{ label: "附录" }], () => 1);
	assert.equal(items.length, 1);
	assert.equal(items[0]?.page, null);
	assert.equal(items[0]?.href, undefined);
});

test("a throwing locator does not drop the entry", () => {
	const items = flattenToc([{ label: "卷七", href: "bad.html#x" }], () => {
		throw new Error("no section");
	});
	assert.equal(items[0]?.page, null);
	assert.equal(items[0]?.href, "bad.html#x");
});
