/**
 * Turning rendered pages into speakable, highlightable text.
 *
 * The document is the source of truth: text is read out of the DOM that is on
 * screen (PDF.js text layer, or an EPUB iframe), so a sentence offset maps back
 * onto real text nodes. Talking to the main process instead would give cleaner
 * text but no way to highlight it.
 */

export type TextMap = {
	text: string;
	nodes: { node: Text; start: number; end: number }[];
};

const LATIN = /[A-Za-z0-9]/;

/**
 * Separator between two adjacent text chunks.
 *
 * CJK needs none, and PDF.js likes to split glyphs into separate spans. Latin
 * runs do need a space, otherwise "thecat" — but only when neither side already
 * carries whitespace.
 */
export function joinSeparator(prev: string, next: string): string {
	if (!prev || !next) return "";
	if (/\s$/.test(prev) || /^\s/.test(next)) return "";
	return LATIN.test(prev) && LATIN.test(next) ? " " : "";
}

/** Flatten a DOM subtree into text + a per-node offset table. */
export function buildTextMap(root: Node): TextMap {
	const doc = root.ownerDocument ?? (root as Document);
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			return (node as Text).data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
		},
	});
	let text = "";
	const nodes: TextMap["nodes"] = [];
	let prev = "";
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const t = node as Text;
		text += joinSeparator(prev, t.data);
		const start = text.length;
		text += t.data;
		nodes.push({ node: t, start, end: text.length });
		prev = t.data;
	}
	return { text, nodes };
}

/**
 * Several documents concatenated in reading order.
 *
 * A double-column EPUB spread is two iframes; reading only the first would skip
 * half the page. Sentences stay inside one document in practice, so a sentence
 * still resolves to a single Range — the offsets are just rebased.
 */
export type MultiText = {
	text: string;
	slices: { doc: Document; map: TextMap; base: number }[];
};

export function buildMultiText(docs: Document[]): MultiText {
	let text = "";
	const slices: MultiText["slices"] = [];
	for (const doc of docs) {
		const map = buildTextMap(doc.body);
		if (!map.text.trim()) continue;
		if (text) text += "\n";
		const base = text.length;
		text += map.text;
		slices.push({ doc, map, base });
	}
	return { text, slices };
}

/** Resolve a `[start, end)` range against a multi-document map. */
export function rangeForMulti(multi: MultiText, start: number, end: number): Range | null {
	const slice =
		multi.slices.find((s) => start >= s.base && start < s.base + s.map.text.length) ??
		multi.slices[0];
	if (!slice) return null;
	const localStart = Math.max(0, start - slice.base);
	const localEnd = Math.min(slice.map.text.length, end - slice.base);
	return rangeFor(slice.map, localStart, Math.max(localEnd, localStart + 1));
}

/** Map a `[start, end)` range of the flattened text back onto DOM nodes. */
export function rangeFor(map: TextMap, start: number, end: number): Range | null {
	if (end <= start) return null;
	const firstIndex = map.nodes.findIndex((n) => n.end > start);
	let lastIndex = -1;
	for (let i = map.nodes.length - 1; i >= 0; i--) {
		const candidate = map.nodes[i];
		if (candidate && candidate.start < end) {
			lastIndex = i;
			break;
		}
	}
	if (firstIndex < 0 || lastIndex < firstIndex) return null;
	const first = map.nodes[firstIndex];
	const last = map.nodes[lastIndex];
	if (!first || !last) return null;
	const doc = first.node.ownerDocument;
	const range = doc.createRange();
	const from = Math.min(Math.max(start - first.start, 0), first.node.data.length);
	const to = Math.min(Math.max(end - last.start, 0), last.node.data.length);
	range.setStart(first.node, from);
	range.setEnd(last.node, to);
	return range;
}

type HighlightCtor = new (...ranges: Range[]) => unknown;
type HighlightRegistry = {
	set: (name: string, h: unknown) => void;
	delete: (name: string) => void;
};

/** CSS Custom Highlight API handles — not in every TS lib version. */
function highlightHandles(
	doc: Document,
): { registry: HighlightRegistry; ctor: HighlightCtor } | null {
	const view = doc.defaultView as
		| (Window & { CSS?: { highlights?: HighlightRegistry }; Highlight?: HighlightCtor })
		| null;
	const registry = view?.CSS?.highlights;
	const ctor = view?.Highlight;
	return registry && ctor ? { registry, ctor } : null;
}

/** Paint the sentence without mutating the document (works inside EPUB iframes). */
export function highlightRange(doc: Document, range: Range | null, name = "read-aloud"): void {
	const handles = highlightHandles(doc);
	if (!handles) return;
	if (range) handles.registry.set(name, new handles.ctor(range));
	else handles.registry.delete(name);
}

/** Register the highlight colour once per document (main page or iframe). */
export function ensureHighlightStyle(doc: Document): void {
	if (doc.getElementById("read-aloud-style")) return;
	const style = doc.createElement("style");
	style.id = "read-aloud-style";
	style.textContent = "::highlight(read-aloud){background:rgba(108,182,255,0.38);color:inherit;}";
	(doc.head ?? doc.documentElement).append(style);
}

/** Bring the sentence into view without stealing the user's selection. */
export function revealRange(range: Range | null): void {
	if (!range) return;
	const node = range.startContainer;
	const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	el?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
}
