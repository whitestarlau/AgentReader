/**
 * Sentence segmentation for mixed Chinese/English book text.
 *
 * The player synthesizes one sentence at a time, so this splitter is the thing
 * that makes "highlight follows the voice" work on every engine, including the
 * ones with no timestamps at all. It is therefore required to be exact about
 * offsets: `text.slice(start, end) === segment.text` always holds.
 */

export type Segment = {
	text: string;
	/** UTF-16 offset into the original string. */
	start: number;
	/** Exclusive. */
	end: number;
};

const SENTENCE_END = new Set(["。", "！", "？", "；", "…", "!", "?", ";", "\n", "\r"]);
const CLOSERS = new Set(["」", "』", "”", "’", "）", ")", "]", "】", "》", "〉", "»"]);
const SECONDARY = new Set(["，", "、", ",", "：", ":", "—", "－"]);
const SPACE = /\s/;

/** Latin abbreviations whose trailing period must not end a sentence. */
const ABBREVIATIONS = [
	"mr.",
	"mrs.",
	"ms.",
	"dr.",
	"prof.",
	"st.",
	"jr.",
	"sr.",
	"vs.",
	"etc.",
	"e.g.",
	"i.e.",
	"fig.",
	"no.",
	"inc.",
	"ltd.",
	"al.",
];

export type SegmentOptions = {
	/** Hard ceiling per segment; longer sentences are split at secondary punctuation. */
	maxChars?: number;
};

/**
 * Split text into sentences, keeping every returned range exact.
 *
 * Rules: CJK terminators plus `.!?;` end a sentence; trailing closing quotes and
 * repeated punctuation stay with the sentence they close; Latin decimal points
 * and common abbreviations do not end a sentence; paragraph breaks always do.
 */
export function splitSentences(text: string, opts: SegmentOptions = {}): Segment[] {
	const maxChars = Math.max(40, Math.floor(opts.maxChars ?? 400));
	const out: Segment[] = [];
	let start = 0;
	let i = 0;
	const flush = (endExclusive: number) => {
		const piece = trim(text, start, endExclusive);
		if (piece) out.push(piece);
		start = endExclusive;
	};

	while (i < text.length) {
		const ch = text[i];
		if (ch === "\n" || ch === "\r") {
			let j = i;
			while (j < text.length && (text[j] === "\n" || text[j] === "\r")) j++;
			flush(j);
			i = j;
			continue;
		}
		if (SENTENCE_END.has(ch)) {
			let j = i + 1;
			// "？！", "……", "!!" are one boundary, not several empty sentences.
			while (j < text.length && SENTENCE_END.has(text[j]) && !SPACE.test(text[j])) j++;
			j = consumeClosers(text, j);
			flush(j);
			i = j;
			continue;
		}
		if (ch === "." && isDotTerminator(text, i)) {
			const j = consumeClosers(text, i + 1);
			flush(j);
			i = j;
			continue;
		}
		i++;
	}
	if (start < text.length) flush(text.length);

	if (out.every((s) => s.text.length <= maxChars)) return out;
	const split: Segment[] = [];
	for (const seg of out) split.push(...splitLong(text, seg, maxChars));
	return split;
}

/** True when the "." at `i` really ends a sentence (not a decimal or abbreviation). */
function isDotTerminator(text: string, i: number): boolean {
	const next = text[i + 1];
	// "3.14", "a.com" — a period glued to the next character is never a boundary.
	if (next !== undefined && next !== "\n" && next !== "\r" && !SPACE.test(next)) return false;
	const head = text.slice(Math.max(0, i - 8), i + 1).toLowerCase();
	for (const abbr of ABBREVIATIONS) {
		if (head.endsWith(abbr)) return false;
	}
	return true;
}

function consumeClosers(text: string, from: number): number {
	let j = from;
	while (j < text.length && (CLOSERS.has(text[j]) || text[j] === '"' || text[j] === "'")) j++;
	return j;
}

function trim(text: string, start: number, end: number): Segment | null {
	let s = start;
	let e = end;
	while (s < e && SPACE.test(text[s])) s++;
	while (e > s && SPACE.test(text[e - 1])) e--;
	if (e <= s) return null;
	return { text: text.slice(s, e), start: s, end: e };
}

/**
 * Break one over-long sentence at the last secondary punctuation before the
 * limit, so the cut lands where a reader would pause. Falls back to a hard cut
 * that never lands inside a surrogate pair.
 */
function splitLong(text: string, seg: Segment, maxChars: number): Segment[] {
	const out: Segment[] = [];
	let start = seg.start;
	while (start < seg.end) {
		const limit = Math.min(start + maxChars, seg.end);
		if (limit >= seg.end) {
			const tail = trim(text, start, seg.end);
			if (tail) out.push(tail);
			break;
		}
		let cut = -1;
		for (let k = limit - 1; k > start + 20; k--) {
			if (SECONDARY.has(text[k])) {
				cut = k + 1;
				break;
			}
		}
		if (cut < 0) cut = safeCut(text, limit);
		const piece = trim(text, start, cut);
		if (piece) out.push(piece);
		start = cut;
	}
	return out;
}

function safeCut(text: string, cut: number): number {
	const before = text.charCodeAt(cut - 1);
	const after = text.charCodeAt(cut);
	const beforeIsHigh = before >= 0xd800 && before <= 0xdbff;
	const afterIsLow = after >= 0xdc00 && after <= 0xdfff;
	return beforeIsHigh && afterIsLow ? cut - 1 : cut;
}
