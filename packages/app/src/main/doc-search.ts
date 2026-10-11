import type { DocText } from "./doc-text.ts";

/**
 * Full-text search over a document's text (the same engine the AI's
 * `search_document` tool uses), exposed to the UI via `doc:search`.
 */

export type DocSearchHit = {
	/** 1-based page (PDF) or chapter (EPUB). */
	locator: number;
	/** Human label for the locator (chapter name for EPUB). */
	label: string;
	/** Total match count in this unit. */
	count: number;
	/** Up to a few surrounding snippets. */
	snippets: string[];
};

export type DocSearchResult = {
	unit: "page" | "chapter";
	query: string;
	total: number;
	/** Present when a sub-range (from/to/chapter) was searched. */
	range?: { from: number; to: number };
	hits: DocSearchHit[];
};

export type DocSearchOptions = {
	limit?: number;
	chapter?: number;
	from?: number;
	to?: number;
};

/**
 * Search `docText` for `query`, returning one hit per page/chapter (sorted by
 * match count). The query is matched case-insensitively; multiple
 * whitespace-separated terms fall back to a "all terms present" match.
 */
export async function searchDocText(
	docText: DocText,
	query: string,
	opts: DocSearchOptions = {},
): Promise<DocSearchResult> {
	const q = String(query ?? "")
		.trim()
		.toLowerCase();
	const total = docText.numPages;
	if (!q) return { unit: docText.unit, query: "", total, hits: [] };

	const max = Math.max(1, Math.min(100, Number(opts.limit) || 20));
	const terms = q.split(/\s+/).filter(Boolean);
	const lo0 = Math.max(1, Math.floor(Number(opts.from ?? opts.chapter ?? 1) || 1));
	const hi0 = Math.min(
		total || 1,
		Math.floor(Number(opts.to ?? opts.chapter ?? total) || total || 1),
	);
	const [lo, hi] = hi0 < lo0 ? [hi0, lo0] : [lo0, hi0];
	const scoped = !(lo === 1 && hi === total);

	const byUnit = new Map<number, DocSearchHit>();
	for (let n = lo; n <= hi; n++) {
		const text = await docText.getPage(n);
		if (!text) continue;
		const lower = text.toLowerCase();
		const positions: number[] = [];
		let from = 0;
		for (;;) {
			const idx = lower.indexOf(q, from);
			if (idx === -1) break;
			positions.push(idx);
			from = idx + q.length;
		}
		if (!positions.length && terms.length > 1 && terms.every((t) => lower.includes(t))) {
			positions.push(Math.max(0, lower.indexOf(terms[0])));
		}
		if (!positions.length) continue;
		const label = docText.chapterLabels?.[n - 1]?.trim() || "";
		const hit: DocSearchHit = byUnit.get(n) ?? { locator: n, label, count: 0, snippets: [] };
		hit.count += positions.length;
		for (const idx of positions) {
			if (hit.snippets.length >= 3) break;
			const snip = text
				.slice(Math.max(0, idx - 60), idx + 140)
				.replace(/\s+/g, " ")
				.trim();
			if (snip && !hit.snippets.includes(snip)) hit.snippets.push(snip);
		}
		byUnit.set(n, hit);
	}

	const hits = [...byUnit.values()]
		.sort((a, b) => b.count - a.count || a.locator - b.locator)
		.slice(0, max);
	return {
		unit: docText.unit,
		query,
		total,
		...(scoped ? { range: { from: lo, to: hi } } : {}),
		hits,
	};
}
