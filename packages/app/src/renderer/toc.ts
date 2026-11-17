import type { OutlineItem } from "./types.ts";

/**
 * Flatten EPUB navigation (nested navPoints / nav list) into the shell outline.
 *
 * `href` is kept verbatim — including its `#fragment`. Many EPUBs put several
 * TOC chapters in one spine file, so resolving only the file makes every entry
 * jump to the file start (often the previous chapter's tail).
 */

export type TocNode = { label?: string; href?: string; subitems?: TocNode[] };

export function flattenToc(
	nodes: TocNode[],
	locatorOf: (href: string) => number | null,
): OutlineItem[] {
	const items: OutlineItem[] = [];
	const walk = (list: TocNode[], depth: number) => {
		for (const node of list) {
			const href = String(node.href ?? "");
			let page: number | null = null;
			if (href) {
				try {
					page = locatorOf(href);
				} catch {
					page = null;
				}
			}
			items.push({
				title: String(node.label ?? "").trim() || "（未命名）",
				page,
				depth,
				...(href ? { href } : {}),
			});
			if (node.subitems?.length) walk(node.subitems, depth + 1);
		}
	};
	walk(nodes, 0);
	return items;
}
