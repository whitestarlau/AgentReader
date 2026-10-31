/**
 * Paragraph selection for the PDF text layer.
 *
 * PDF.js emits one text-layer span per text run; CJK PDFs (and many
 * InDesign/Word exports) emit one span per glyph and no paragraph structure at
 * all. There is therefore nothing named "paragraph" in the DOM to lean on.
 * We reconstruct lines and paragraphs from geometry instead:
 *
 *   glyph spans -> lines (same baseline) -> visual segments (horizontal gaps
 *   split columns/table cells) -> paragraphs (indent, vertical gap, or a short
 *   previous line).
 *
 * Double-clicking a glyph selects the enclosing visual paragraph. Everything
 * is best-effort: if the layout is too strange to classify, returning `null`
 * lets the browser keep its native word selection.
 */

type Item = {
	el: HTMLElement;
	text: string;
	top: number;
	bottom: number;
	left: number;
	right: number;
	height: number;
};

export type TextSegment = {
	top: number;
	bottom: number;
	left: number;
	right: number;
	height: number;
	items: Item[];
};

function textNodeOf(el: HTMLElement): Text | null {
	if (el.firstChild?.nodeType === Node.TEXT_NODE) return el.firstChild as Text;
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	return (walker.nextNode() as Text | null) ?? null;
}

function buildItems(root: HTMLElement): Item[] {
	const items: Item[] = [];
	for (const el of Array.from(root.querySelectorAll<HTMLElement>("span"))) {
		// Only leaf spans: pdf.js wraps some runs in a parent span, which would
		// otherwise contribute the same glyphs twice.
		if (el.childElementCount > 0) continue;
		const text = el.textContent ?? "";
		if (!text.trim()) continue;
		const r = el.getBoundingClientRect();
		if (r.width < 0.5 || r.height < 0.5) continue;
		items.push({
			el,
			text,
			top: r.top,
			bottom: r.bottom,
			left: r.left,
			right: r.right,
			height: r.height,
		});
	}
	return items;
}

/** Group glyph boxes into horizontal line segments. */
function segmentsFromItems(items: Item[]): TextSegment[] {
	items.sort((a, b) => a.top - b.top || a.left - b.left);

	const rows: Item[][] = [];
	for (const item of items) {
		const row = rows[rows.length - 1];
		const tolerance = Math.max(3, item.height * 0.4);
		if (row && Math.abs(item.top - row[0].top) <= tolerance) {
			row.push(item);
		} else {
			rows.push([item]);
		}
	}

	const segments: TextSegment[] = [];
	for (const row of rows) {
		row.sort((a, b) => a.left - b.left);
		const heights = row.map((i) => i.height).sort((a, b) => a - b);
		const median = heights[Math.floor(heights.length / 2)] ?? 12;
		// A wide gap is a column gutter or a table cell boundary, not a space
		// inside a sentence (those are a small fraction of the font size).
		const gapLimit = Math.max(10, median * 0.9);
		let run: Item[] = [];
		const flush = () => {
			if (run.length === 0) return;
			segments.push({
				top: Math.min(...run.map((i) => i.top)),
				bottom: Math.max(...run.map((i) => i.bottom)),
				left: Math.min(...run.map((i) => i.left)),
				right: Math.max(...run.map((i) => i.right)),
				height: Math.max(...run.map((i) => i.height)),
				items: run,
			});
			run = [];
		};
		for (const item of row) {
			const prev = run[run.length - 1];
			if (prev && item.left - prev.right > gapLimit) flush();
			run.push(item);
		}
		flush();
	}
	return segments.sort((a, b) => a.top - b.top || a.left - b.left);
}

export function buildTextSegments(root: HTMLElement): TextSegment[] {
	return segmentsFromItems(buildItems(root));
}

/** The leaf span under the pointer, with fallbacks for wrappers/blank space. */
function hitItem(
	root: HTMLElement,
	target: EventTarget | null,
	clientX: number,
	clientY: number,
	items: Item[],
): Item | null {
	const doc = root.ownerDocument as Document & {
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
		caretPositionFromPoint?: (x: number, y: number) => CaretPosition | null;
	};
	let el = (target as HTMLElement | null)?.closest?.("span") ?? null;
	if (!el || el.childElementCount > 0) {
		try {
			const range = doc.caretRangeFromPoint?.(clientX, clientY);
			const node =
				range?.startContainer ?? doc.caretPositionFromPoint?.(clientX, clientY)?.offsetNode;
			el =
				((node?.nodeType === Node.TEXT_NODE
					? node.parentElement
					: (node as Element | null)
				)?.closest?.("span") as HTMLElement | null) ?? el;
		} catch {}
	}
	if (el) {
		const exact = items.find((i) => i.el === el);
		if (exact) return exact;
		const inside = items.find((i) => el.contains(i.el));
		if (inside) return inside;
	}
	// Blank page areas / margins must not select the nearest paragraph — only
	// points on (or a couple of px inside) an actual glyph box qualify.
	return (
		items.find(
			(i) =>
				clientX >= i.left - 2 &&
				clientX <= i.right + 2 &&
				clientY >= i.top - 2 &&
				clientY <= i.bottom + 2,
		) ?? null
	);
}

function horizontalOverlap(a: TextSegment, b: TextSegment): number {
	return Math.min(a.right, b.right) - Math.max(a.left, b.left);
}

/**
 * Build the DOM Range for the visual paragraph containing (clientX, clientY).
 * Returns null when there is no usable text or the layout cannot be classified.
 */
export function paragraphRangeAt(
	root: HTMLElement,
	target: EventTarget | null,
	clientX: number,
	clientY: number,
): Range | null {
	const items = buildItems(root);
	if (items.length === 0) return null;
	const segments = segmentsFromItems(items);
	if (segments.length === 0) return null;
	const hit = hitItem(root, target, clientX, clientY, items);
	if (!hit) return null;
	const clicked = segments.find((segment) => segment.items.includes(hit));
	if (!clicked) return null;

	// Only walk through lines that overlap the clicked column / cell. This keeps
	// two-column papers from leaking text across the gutter, and table cells
	// from selecting the whole row.
	const minOverlap = Math.max(8, clicked.height * 0.4);
	const related = segments.filter((segment) => horizontalOverlap(segment, clicked) >= minOverlap);
	const index = related.indexOf(clicked);
	if (index < 0) return null;

	const heights = related.map((s) => s.height).sort((a, b) => a - b);
	const font = heights[Math.floor(heights.length / 2)] ?? clicked.height;
	// The median left is the body margin; outliers such as a centered title or a
	// page number at the far left must not shift the indent baseline.
	const lefts = related.map((s) => s.left).sort((a, b) => a - b);
	const baseLeft = lefts[Math.floor(lefts.length / 2)] ?? Math.min(...lefts);
	const columnRight = Math.max(...related.map((s) => s.right));
	const columnWidth = Math.max(1, columnRight - baseLeft);
	const indentLimit = Math.max(8, font * 0.8);

	const isBlockStart = (segment: TextSegment, prev: TextSegment | null): boolean => {
		if (!prev) return true;
		const indent = segment.left - baseLeft;
		const indented = indent > indentLimit && indent < columnWidth * 0.5;
		const gap = segment.top - prev.bottom;
		const bigGap = gap > font * 1.1;
		// A short line is usually the end of a paragraph; the next line starts
		// the next one even if the exporter forgot the first-line indent.
		const shortPrev = prev.right < columnRight - font * 1.2;
		return indented || bigGap || shortPrev;
	};

	let start = index;
	while (start > 0 && !isBlockStart(related[start], related[start - 1])) start--;
	let end = start;
	while (end + 1 < related.length && !isBlockStart(related[end + 1], related[end])) end++;

	const firstSegment = related[start];
	const lastSegment = related[end];
	const firstEl = firstSegment.items[0]?.el;
	const lastEl = lastSegment.items[lastSegment.items.length - 1]?.el;
	if (!firstEl || !lastEl) return null;
	const firstText = textNodeOf(firstEl);
	const lastText = textNodeOf(lastEl);
	if (!firstText || !lastText) return null;
	const range = document.createRange();
	try {
		range.setStart(firstText, 0);
		range.setEnd(lastText, lastText.textContent?.length ?? 0);
	} catch {
		return null;
	}
	return range.toString().trim() ? range : null;
}

/**
 * Install paragraph selection on a rendered text layer. Returns a disposer.
 *
 * Follows the browser convention: double-click stays a word selection (handled
 * natively by the text layer), and a triple-click replaces the browser's
 * line-ish selection with the visual paragraph. `MouseEvent.detail` is the
 * browser's click count, so it honours the OS double-click interval/position.
 */
export function installParagraphSelection(root: HTMLElement, onSelected: () => void): () => void {
	const handler = (e: MouseEvent) => {
		if (e.detail !== 3) return;
		if (e.button !== 0 || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
		const target = e.target as HTMLElement | null;
		if (target?.closest?.("[data-ann], [data-toolbar], button, a, input, textarea, select")) return;
		const range = paragraphRangeAt(root, e.target, e.clientX, e.clientY);
		if (!range) return;
		const selection = window.getSelection();
		if (!selection) return;
		selection.removeAllRanges();
		selection.addRange(range);
		onSelected();
	};
	root.addEventListener("click", handler);
	return () => root.removeEventListener("click", handler);
}
