import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "./Icons.tsx";
import type { Annotation } from "./AnnotationLayer.tsx";
import { type Selection, MODIFIER_LABEL, SELECTION_LABEL } from "../selection.ts";
import { buildHistory, type HistoryMessage } from "../history.ts";
import { estimateTokens, formatTokens } from "../tokens.ts";
import type { OutlineItem } from "../types.ts";

type TimelineItem =
	| { kind: "reasoning"; content: string }
	| { kind: "tool"; id: string; name: string; args: string; result?: string; pending?: boolean };

type Msg = {
	id?: string;
	role: "user" | "assistant";
	content: string;
	timeline?: TimelineItem[];
	stopped?: boolean;
	/** User-facing note about an abnormal stop (tool cap / truncation / empty reply). */
	notice?: string;
};
type ChatRow = { id?: string; role?: string; content?: string; timeline?: TimelineItem[]; notice?: string };
type Conv = { id: string; title: string; updatedAt?: number };

const lastConvKey = (docId: string) => `chat.last.${docId}`;
function readLastConv(docId: string): string | null {
	try {
		return localStorage.getItem(lastConvKey(docId));
	} catch {
		return null;
	}
}
function writeLastConv(docId: string, convId: string) {
	try {
		localStorage.setItem(lastConvKey(docId), convId);
	} catch {}
}
/** Most recently active conversation first. */
function byRecent(list: Conv[]): Conv[] {
	return [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
/** A citation captured from the viewer, shown above the composer before send. */
type Quote = { text: string; page: number; kind: Selection["kind"] };
type Props = {
	selection: Selection | null;
	docId: string | null;
	page: number;
	isEpub?: boolean;
	annotations?: Annotation[];
	/** Flattened TOC reported by the viewer (PDF bookmarks / EPUB TOC). */
	outline?: OutlineItem[];
	/** PDF page count, for the "@ 页码" picker. */
	totalPages?: number;
	contextWindow?: number;
	newChatToken?: number;
};
/** Real or estimated context usage for the current conversation. */
type ContextUsage = { used: number; max: number; estimated: boolean };

type Outline = { unit: "page" | "chapter"; numPages: number; chapterLabels: string[]; toc: { label: string; href: string }[] };

/** An item the user can reference with "@" in the composer. */
type MentionItem = {
	key: string;
	kind: "annotation" | "chapter" | "section" | "page";
	page: number;
	/** Shown in the picker list. */
	label: string;
	/** Literal text inserted into the composer. */
	token: string;
	/** Context block prepended to the prompt when the token is still present. */
	ref: string;
};

type MentionCategory = "annotation" | "chapter" | "section" | "page";

const CATEGORY_LABEL: Record<MentionCategory, string> = {
	chapter: "章节",
	section: "目录",
	page: "页码",
	annotation: "标注",
};

function mentionKindLabel(kind: MentionItem["kind"]): string {
	if (kind === "chapter") return "章节";
	if (kind === "section") return "目录";
	if (kind === "page") return "页码";
	return "标注";
}

function mentionIcon(kind: MentionItem["kind"] | MentionCategory): "book" | "file" | "annotations" {
	if (kind === "chapter" || kind === "section") return "book";
	if (kind === "page") return "file";
	return "annotations";
}

/** A row in the "@" picker: either a category ("章节"/"标注") or one item. */
type MentionRow =
	| { kind: "category"; category: MentionCategory; label: string; count: number }
	| { kind: "item"; item: MentionItem };

function toMsg(r: ChatRow): Msg {
	return {
		id: r.id,
		role: r.role === "assistant" ? "assistant" : "user",
		content: r.content ?? "",
		timeline: r.timeline,
		notice: r.notice,
	};
}

function toolSummary(name: string, args: string): string {
	try {
		const a = JSON.parse(args || "{}");
		if (a.query) return String(a.query);
		if (a.chapter) return `第 ${a.chapter} 章`;
		if (a.page) return `第 ${a.page} 页`;
	} catch {}
	return "";
}

type RefBlock = { header: string; body: string };

/**
 * Split a persisted user message into its citation blocks and the actual
 * question. The prompt sent to the model is
 *   `【引用…】\n<body>\n\n【问题】\n<question>`
 * so we can render the (often very long) citations collapsed while keeping the
 * full text available to expand. Messages without citations render as before.
 */
function parseUserPrompt(content: string): { refs: RefBlock[]; question: string } {
	const marker = "\n\n【问题】\n";
	const qi = content.indexOf(marker);
	if (qi < 0) return { refs: [], question: content };
	const refsPart = content.slice(0, qi);
	const question = content.slice(qi + marker.length);
	const refs: RefBlock[] = [];
	for (const chunk of refsPart.split(/\n\n(?=【引用)/)) {
		const nl = chunk.indexOf("\n");
		const header = (nl >= 0 ? chunk.slice(0, nl) : chunk).trim();
		const body = nl >= 0 ? chunk.slice(nl + 1).replace(/\s+$/, "") : "";
		if (header.startsWith("【引用")) refs.push({ header, body });
	}
	return { refs, question };
}

function refIcon(header: string): "book" | "file" | "annotations" | "chat" {
	if (header.includes("标注")) return "annotations";
	if (header.includes("页码")) return "file";
	if (header.includes("章节") || header.includes("目录")) return "book";
	return "chat";
}

/** A citation attached to a user turn. Collapsed to one line by default. */
function RefDisclosure({ header, body }: RefBlock) {
	const [open, setOpen] = useState(false);
	const title = header.replace(/^【|】$/g, "");
	const preview = body.replace(/\s+/g, " ").trim().slice(0, 48);
	return (
		<div className={`user-ref${open ? " open" : ""}`}>
			<button type="button" className="user-ref-head" onClick={() => setOpen((v) => !v)} disabled={!body}>
				<Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
				<Icon name={refIcon(header)} size={12} />
				<span className="user-ref-title">{title}</span>
				{!open && preview && <span className="user-ref-preview">{preview}</span>}
			</button>
			{open && body && <div className="user-ref-body">{body}</div>}
		</div>
	);
}

/** User turn: citation blocks (collapsed) followed by the question. */
function UserMessage({ content }: { content: string }) {
	const { refs, question } = useMemo(() => parseUserPrompt(content), [content]);
	if (refs.length === 0) return <div className="msg-user-text">{question}</div>;
	return (
		<div className="msg-user-text">
			{refs.map((r) => (
				<RefDisclosure key={`${r.header}:${r.body.slice(0, 24)}`} header={r.header} body={r.body} />
			))}
			{question && <div className="msg-user-question">{question}</div>}
		</div>
	);
}

/** Live label for the work log while the turn is streaming. */
function liveLabel(items: TimelineItem[]): string {
	const last = items[items.length - 1];
	if (last?.kind === "tool") return last.pending ? `正在调用 ${last.name}…` : "正在生成回答…";
	return "正在思考…";
}

/** Summary of a finished turn's work log, e.g. "思考 2 段 · 工具 2 次". */
function timelineSummary(items: TimelineItem[]): string {
	const toolCount = items.filter((it) => it.kind === "tool").length;
	const reasoningCount = items.length - toolCount;
	const parts: string[] = [];
	if (reasoningCount > 0) parts.push(reasoningCount > 1 ? `思考 ${reasoningCount} 段` : "思考");
	if (toolCount > 0) parts.push(`工具 ${toolCount} 次`);
	return parts.join(" · ");
}

/**
 * One step inside the work log (a reasoning burst or a tool call). Collapsed by
 * default, so expanding the group first shows a compact overview of the steps.
 */
function TimelineStep({ item }: { item: TimelineItem }) {
	if (item.kind === "reasoning") {
		const preview = item.content.replace(/\s+/g, " ").trim().slice(0, 60);
		return (
			<Disclosure icon="sparkle" title="思考" preview={preview}>
				<div className="reasoning-text">{item.content || "…"}</div>
			</Disclosure>
		);
	}
	return (
		<Disclosure
			icon="tool"
			title={item.name}
			meta={toolSummary(item.name, item.args)}
			state={item.pending ? "进行中" : undefined}
		>
			<div className="tool-args">
				<code>{item.args}</code>
			</div>
			{item.result !== undefined && <pre className="tool-result">{item.result.slice(0, 4000)}</pre>}
		</Disclosure>
	);
}

/** One collapsible step. Collapsed by default; opens only on explicit click. */
function Disclosure({
	icon,
	title,
	meta,
	preview,
	state,
	children,
}: {
	icon: "sparkle" | "tool";
	title: string;
	meta?: string;
	/** Shown in place of the meta while collapsed (e.g. a reasoning preview). */
	preview?: string;
	state?: string;
	children?: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className={`disclosure sub${open ? " open" : ""}`}>
			<button type="button" className="disclosure-head" onClick={() => setOpen((v) => !v)}>
				<Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
				<span className="disclosure-icon">
					{icon === "sparkle" ? <Icon name="sparkle" size={12} /> : <Icon name="tool" size={12} />}
				</span>
				<span className="disclosure-title">{title}</span>
				{!open && preview && <span className="disclosure-meta">{preview}</span>}
				{!open && meta && <span className="disclosure-meta">{meta}</span>}
				{!open && state && <span className="timeline-step-state">{state}</span>}
			</button>
			{open && <div className="disclosure-body">{children}</div>}
		</div>
	);
}

/**
 * Codex-style work log for one assistant turn: all reasoning and tool calls are
 * folded into a single line, collapsed by default, so multi-round turns stay
 * compact. While the turn is streaming the line shows the live step instead.
 * Expanding reveals the steps, each of which folds again (second level) so you
 * can drill into just the one you care about.
 */
function TimelineGroup({ items, live }: { items: TimelineItem[]; live: boolean }) {
	const [open, setOpen] = useState(false);
	const hasReasoning = items.some((it) => it.kind === "reasoning");
	const toolNames = items
		.filter((it): it is Extract<TimelineItem, { kind: "tool" }> => it.kind === "tool")
		.map((it) => it.name)
		.filter((name, i, all) => name && all.indexOf(name) === i);
	return (
		<div className={`disclosure timeline-group${open ? " open" : ""}${live ? " active" : ""}`}>
			<button type="button" className="disclosure-head" onClick={() => setOpen((v) => !v)}>
				<Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
				<span className="disclosure-icon">
					<Icon name={hasReasoning ? "sparkle" : "tool"} size={12} />
				</span>
				<span className="disclosure-title">{live ? liveLabel(items) : timelineSummary(items)}</span>
				{!live && toolNames.length > 0 && <span className="disclosure-meta">{toolNames.join("、")}</span>}
			</button>
			{open && (
				<div className="disclosure-body">
					<div className="timeline-steps">
						{items.map((it, j) => (
							<TimelineStep key={j} item={it} />
						))}
					</div>
				</div>
			)}
		</div>
	);
}

export function ChatPanel({
	selection,
	docId,
	page,
	isEpub,
	annotations = [],
	outline: documentOutline = [],
	totalPages = 0,
	contextWindow,
	newChatToken = 0,
}: Props) {
	const [convs, setConvs] = useState<Conv[]>([]);
	const [convId, setConvId] = useState<string | null>(null);
	const [convLoading, setConvLoading] = useState(false);
	const [convMenuOpen, setConvMenuOpen] = useState(false);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameText, setRenameText] = useState("");
	const renameTextRef = useRef("");
	const [msgs, setMsgs] = useState<Msg[]>([]);
	const [input, setInput] = useState("");
	const [outline, setOutline] = useState<Outline | null>(null);
	// Mentions the user picked via "@", keyed by token still present in `input`.
	const [mentions, setMentions] = useState<MentionItem[]>([]);
	const [mention, setMention] = useState<{ start: number; query: string; index: number; category: MentionCategory | null } | null>(null);
	const [streaming, setStreaming] = useState(false);
	const [stopped, setStopped] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editText, setEditText] = useState("");
	const streamRef = useRef("");
	const reasoningRef = useRef("");
	const scrollRef = useRef<HTMLDivElement>(null);
	// Whether new output should follow the bottom. Cleared when the user scrolls
	// up to read history, so streaming no longer yanks them back down.
	const stickRef = useRef(true);
	const [showJump, setShowJump] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const composingRef = useRef(false);
	// Current pending citation, captured from the viewer's latest selection so the
	// user can review, edit, or remove it before sending.
	const [quote, setQuote] = useState<Quote | null>(null);
	const [quoteEditing, setQuoteEditing] = useState(false);
	const lastSelRef = useRef<Selection | null>(null);
	// The conversation id is only valid for the document it was loaded from.
	// Guards async responses against being applied after a document switch.
	const convDocRef = useRef<string | null>(null);
	const docIdRef = useRef<string | null>(docId);
	docIdRef.current = docId;
	const convIdRef = useRef<string | null>(convId);
	convIdRef.current = convId;
	const activeStreamRef = useRef<{ docId: string; convId: string } | null>(null);
	const convMenuRef = useRef<HTMLDivElement>(null);
	const renameInputRef = useRef<HTMLInputElement>(null);
	const renameCancelRef = useRef(false);
	// Latest context usage for this conversation: exact when a provider reports
	// token usage, otherwise estimated from the loaded messages.
	const [usage, setUsage] = useState<ContextUsage | null>(null);

	const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTo({ top: el.scrollHeight, behavior });
		stickRef.current = true;
		setShowJump(false);
	}, []);

	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
		stickRef.current = atBottom;
		setShowJump(!atBottom);
	}, []);

	// Grow the composer with its content, up to a cap, then scroll internally.
	const resizeInput = useCallback(() => {
		const el = inputRef.current;
		if (!el) return;
		const max = 200;
		el.style.height = "auto";
		const cs = getComputedStyle(el);
		const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
		const full = el.scrollHeight + border;
		el.style.height = `${Math.min(full, max)}px`;
		el.style.overflowY = full > max ? "auto" : "hidden";
	}, []);

	useEffect(() => { resizeInput(); }, [input, resizeInput]);

	// Switching documents must not carry a citation (or its text) into the new
	// conversation.
	useEffect(() => {
		setQuote(null);
		setQuoteEditing(false);
		lastSelRef.current = null;
	}, [docId]);

	// Capture a fresh viewer selection into an editable composer citation. Each
	// pick produces a new Selection object, so identity flags a re-selection;
	// removing the citation does not re-add it because the selection is unchanged.
	useEffect(() => {
		if (!selection?.text?.trim()) return;
		if (lastSelRef.current === selection) return;
		lastSelRef.current = selection;
		setQuote({ text: selection.text, page: selection.page, kind: selection.kind });
		setQuoteEditing(false);
	}, [selection]);

	// A citation belongs to one document; drop it when the document changes.
	useEffect(() => {
		setQuote(null);
		setQuoteEditing(false);
		lastSelRef.current = null;
	}, [docId]);

	// Focus/select the inline rename field as soon as it appears.
	useEffect(() => {
		if (!renamingId) return;
		const el = renameInputRef.current;
		if (!el) return;
		el.focus();
		el.select();
	}, [renamingId]);

	// Conversation menu: close on outside click or Escape.
	useEffect(() => {
		if (!convMenuOpen) return;
		const onDown = (e: MouseEvent) => {
			if (convMenuRef.current && !convMenuRef.current.contains(e.target as Node)) {
				if (renamingId) void commitRename(renamingId);
				setConvMenuOpen(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// Closing the menu shouldn't also stop a running answer.
				e.stopPropagation();
				setConvMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [convMenuOpen, renamingId]);

	// Chapter labels for the "@" picker. Only EPUB has chapters, and calling
	// getDocText on a PDF would eagerly extract pages, so skip it there.
	useEffect(() => {
		setMentions([]);
		setMention(null);
		if (!docId || !isEpub) { setOutline(null); return; }
		let cancelled = false;
		window.api.getDocOutline(docId)
			.then((o) => { if (!cancelled) setOutline(o); })
			.catch(() => { if (!cancelled) setOutline(null); });
		return () => { cancelled = true; };
	}, [docId, isEpub]);

	// Build the mention catalog: annotations first (usually few and specific),
	// then every chapter with its name. Memoized so streaming re-renders don't
	// rebuild it on every token.
	const annotationMentions = useMemo<MentionItem[]>(() => {
		return annotations.map((a) => {
			const where = isEpub ? `第${a.page}章` : `P${a.page}`;
			const snippet = (a.text ?? "").replace(/\s+/g, " ").trim();
			const kindLabel = a.type === "rect" ? "框选" : "高亮";
			return {
				key: `ann:${a.id}`,
				kind: "annotation",
				page: a.page,
				label: `${where} ${kindLabel}${snippet ? ` · ${snippet.slice(0, 24)}` : ""}`,
				token: `@标注(${where}${snippet ? `·${snippet.slice(0, 12)}` : ""})`,
				ref: `【引用标注 · ${where} · ${kindLabel}】\n${snippet.slice(0, 2000) || "（无文本）"}`,
			};
		});
	}, [annotations, isEpub]);
	const chapterMentions = useMemo<MentionItem[]>(() => {
		if (outline?.unit !== "chapter") return [];
		return (outline.chapterLabels ?? []).map((raw, i) => {
			const n = i + 1;
			const name = (raw ?? "").trim();
			const hasNumber = name.includes(`第${n}章`);
			return {
				key: `ch:${n}`,
				kind: "chapter",
				page: n,
				label: name ? `第${n}章${hasNumber ? "" : ` · ${name}`}` : `第${n}章`,
				token: `@章节(第${n}章${name && !hasNumber ? `·${name}` : ""})`,
				ref: `【引用章节 · 第${n}章${name && !hasNumber ? ` · ${name}` : ""}】`,
			};
		});
	}, [outline]);
	// PDF bookmarks act like EPUB chapters. The viewer already resolved the
	// bookmarks to real page numbers, so no extra PDF parsing is needed here.
	const sectionMentions = useMemo<MentionItem[]>(() => {
		if (isEpub) return [];
		const items: MentionItem[] = [];
		for (const [i, item] of documentOutline.entries()) {
			const page = item.page;
			if (typeof page !== "number" || page < 1) continue;
			const title = (item.title ?? "").replace(/\s+/g, " ").trim();
			const short = title.slice(0, 24);
			items.push({
				key: `section:${i}:${page}`,
				kind: "section",
				page,
				label: `P${page}${short ? ` · ${short}` : ""}`,
				token: `@目录(P${page}${short ? `·${short.slice(0, 12)}` : ""})`,
				ref: `【引用目录 · P${page}${title ? ` · ${title}` : ""}】`,
			});
		}
		return items;
	}, [isEpub, documentOutline]);

	// A PDF has no chapters; @-mention a page instead. Order the current page
	// first (then its neighbours) so the category is useful without scrolling.
	const pageMentions = useMemo<MentionItem[]>(() => {
		if (isEpub || totalPages < 1) return [];
		const current = Math.min(Math.max(page || 1, 1), totalPages);
		const order: number[] = [current];
		for (let d = 1; d <= 20; d++) {
			if (current - d >= 1) order.push(current - d);
			if (current + d <= totalPages) order.push(current + d);
		}
		const seen = new Set(order);
		for (let n = 1; n <= totalPages; n++) if (!seen.has(n)) order.push(n);
		return order.map((n) => ({
			key: `page:${n}`,
			kind: "page",
			page: n,
			label: `P${n}`,
			token: `@P${n}`,
			ref: `【引用页码 · P${n}】`,
		}));
	}, [isEpub, totalPages, page]);

	const allMentions = useMemo(
		() => [...annotationMentions, ...chapterMentions, ...sectionMentions, ...pageMentions],
		[annotationMentions, chapterMentions, sectionMentions, pageMentions],
	);

	// Picker rows. With no input: first the categories, then (after choosing one)
	// its items. While typing, search across every item directly.
	const mentionRows = useMemo<MentionRow[]>(() => {
		if (!mention) return [];
		const q = mention.query.trim().toLowerCase();
		if (q) {
			return allMentions
				.filter((m) => m.label.toLowerCase().includes(q) || m.token.toLowerCase().includes(q))
				.slice(0, 12)
				.map((item) => ({ kind: "item", item }) as MentionRow);
		}
		if (!mention.category) {
			const cats: MentionRow[] = [];
			if (chapterMentions.length) cats.push({ kind: "category", category: "chapter", label: CATEGORY_LABEL.chapter, count: chapterMentions.length });
			if (sectionMentions.length) cats.push({ kind: "category", category: "section", label: CATEGORY_LABEL.section, count: sectionMentions.length });
			if (pageMentions.length) cats.push({ kind: "category", category: "page", label: CATEGORY_LABEL.page, count: pageMentions.length });
			if (annotationMentions.length) cats.push({ kind: "category", category: "annotation", label: CATEGORY_LABEL.annotation, count: annotationMentions.length });
			return cats;
		}
		const list =
			mention.category === "chapter"
				? chapterMentions
				: mention.category === "section"
					? sectionMentions
					: mention.category === "page"
						? pageMentions
						: annotationMentions;
		return list.slice(0, 200).map((item) => ({ kind: "item", item }) as MentionRow);
	}, [mention, allMentions, annotationMentions, chapterMentions, sectionMentions, pageMentions]);
	const activeMentionIndex = mention ? Math.min(mention.index, Math.max(0, mentionRows.length - 1)) : 0;

	const syncMention = useCallback(() => {
		const el = inputRef.current;
		if (!el) return;
		const caret = el.selectionStart ?? 0;
		const before = el.value.slice(0, caret);
		const at = before.lastIndexOf("@");
		if (at < 0) { setMention(null); return; }
		const between = before.slice(at + 1);
		if (between.includes("\n") || between.length > 24 || /\s/.test(between)) { setMention(null); return; }
		setMention((prev) => {
			const sameCtx = prev && prev.start === at;
			return {
				start: at,
				query: between,
				index: sameCtx && prev.query === between ? prev.index : 0,
				category: sameCtx ? prev.category : null,
			};
		});
	}, []);

	const applyMention = (item: MentionItem) => {
		const el = inputRef.current;
		if (!el || !mention) return;
		const caret = el.selectionStart ?? input.length;
		const before = input.slice(0, mention.start);
		const after = input.slice(caret);
		const insert = `${item.token} `;
		setInput(before + insert + after);
		setMentions((prev) => (prev.some((m) => m.key === item.key) ? prev : [...prev, item]));
		setMention(null);
		const pos = before.length + insert.length;
		requestAnimationFrame(() => {
			el.focus();
			el.setSelectionRange(pos, pos);
		});
	};

	const openMentionCategory = (category: MentionCategory) => {
		setMention((m) => (m ? { ...m, category, index: 0 } : m));
	};

	const activateMentionRow = (row: MentionRow) => {
		if (row.kind === "category") openMentionCategory(row.category);
		else applyMention(row.item);
	};

	const refreshConvs = async () => {
		if (!docId) return;
		const list: Conv[] = await window.api.listConversations(docId);
		if (docIdRef.current !== docId) return;
		// Preserve a locally-generated title if the disk copy still has the
		// generic placeholder (guards against read-after-write races).
		setConvs((prev) => {
			const merged = list.map((c) => {
				const local = prev.find((p) => p.id === c.id);
				const placeholder = !c.title || /^对话 \d+$/.test(c.title);
				return local && placeholder && local.title && !/^对话 \d+$/.test(local.title)
					? { ...c, title: local.title }
					: c;
			});
			return byRecent(merged);
		});
	};

	// Switching documents must reset every conversation-scoped piece of state.
	// The old convId belonged to the previous document; reusing it used to leave
	// the panel on "select a conversation" and, worse, write messages into an
	// orphan transcript under the new document.
	useEffect(() => {
		const active = activeStreamRef.current;
		if (active && active.docId !== docId) {
			activeStreamRef.current = null;
			window.api.stopChat(active.docId, active.convId).catch(() => {});
		}
		setStreaming(false);
		setStopped(false);
		streamRef.current = "";
		reasoningRef.current = "";
		convDocRef.current = null;
		setConvId(null);
		setConvs([]);
		setMsgs([]);
		setUsage(null);
		setInput("");
		setMentions([]);
		setMention(null);
		setEditingId(null);
		setEditText("");
		setShowJump(false);
		setConvMenuOpen(false);
		setRenamingId(null);
		if (!docId) {
			setConvLoading(false);
			return;
		}
		setConvLoading(true);
		let cancelled = false;
		(async () => {
			try {
				let list: Conv[] = byRecent(await window.api.listConversations(docId));
				if (cancelled) return;
				if (list.length === 0) {
					const created: Conv = await window.api.createConversation(docId);
					if (cancelled) return;
					list = [created];
				}
				if (cancelled) return;
				setConvs(list);
				const remembered = readLastConv(docId);
				const target = list.find((c) => c.id === remembered) ?? list[0];
				setConvId(target.id);
				convDocRef.current = docId;
				writeLastConv(docId, target.id);
			} catch (e) {
				console.error("[chat] load conversations failed", e);
			} finally {
				if (!cancelled) setConvLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [docId]);

	useEffect(() => {
		// While a document switch is still loading its conversations, convId is
		// null; never fetch chats with a conversation from the previous document.
		if (!docId || !convId || convDocRef.current !== docId) {
			setMsgs([]);
			setUsage(null);
			return;
		}
		let cancelled = false;
		setMsgs([]);
		setUsage(null);
		window.api
			.getChats(docId, convId)
			.then((rows) => {
				if (!cancelled) setMsgs(rows.map(toMsg));
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [docId, convId]);

	// 流式期间原地更新最后一条 assistant 消息的某一个字段
	const updateLast = useCallback((fn: (m: Msg) => Msg) => {
		setMsgs((cur) => {
			const c = [...cur];
			const i = c.length - 1;
			if (i < 0) return cur;
			c[i] = fn(c[i]);
			return c;
		});
	}, []);

	const pushTimeline = useCallback((item: TimelineItem) => {
		updateLast((m) => ({ ...m, timeline: [...(m.timeline ?? []), item] }));
	}, [updateLast]);

	useEffect(() => {
		// Ignore late stream events once the turn was stopped or its document was
		// switched away. They arrive without a doc/conv id, so the active-stream
		// ref is the only thing that can keep them from mutating another chat.
		const offDelta = window.api.onChatDelta((delta: string) => {
			if (!activeStreamRef.current) return;
			streamRef.current += delta;
			updateLast((m) => ({ ...m, content: streamRef.current }));
		});
		const offReasoning = window.api.onChatReasoning((delta: string) => {
			if (!activeStreamRef.current) return;
			reasoningRef.current += delta;
			updateLast((m) => {
				const tl = [...(m.timeline ?? [])];
				const last = tl[tl.length - 1];
				if (last && last.kind === "reasoning") tl[tl.length - 1] = { ...last, content: reasoningRef.current };
				else tl.push({ kind: "reasoning", content: reasoningRef.current });
				return { ...m, timeline: tl };
			});
		});
		const offToolCall = window.api.onToolCall((data: unknown) => {
			if (!activeStreamRef.current) return;
			const d = data as { id?: string; name: string; args: string };
			pushTimeline({ kind: "tool", id: d.id ?? `tool-${Date.now()}`, name: d.name, args: d.args, pending: true });
		});
		const offToolResult = window.api.onToolResult((data: unknown) => {
			if (!activeStreamRef.current) return;
			const d = data as { id: string; name?: string; result: string };
			updateLast((m) => {
				const tl = [...(m.timeline ?? [])];
				const idx = tl.findIndex((it) => it.kind === "tool" && it.id === d.id);
				if (idx >= 0) {
					const t = tl[idx] as Extract<TimelineItem, { kind: "tool" }>;
					tl[idx] = { ...t, result: d.result, pending: false, name: d.name || t.name };
				}
				return { ...m, timeline: tl };
			});
		});
		const offDone = window.api.onChatDone(() => {
			activeStreamRef.current = null;
			setStreaming(false);
		});
		const offNotice = window.api.onChatNotice((notice: string) => {
			if (!activeStreamRef.current) return;
			updateLast((m) => ({ ...m, notice }));
		});
		const offUsage = window.api.onChatUsage((u) => {
			if (!activeStreamRef.current) return;
			setUsage({ used: u.used, max: u.max, estimated: u.estimated });
		});
		return () => { offDelta(); offReasoning(); offToolCall(); offToolResult(); offDone(); offNotice(); offUsage(); };
	}, [updateLast, pushTimeline]);

	// Jump to the bottom when switching conversations.
	useEffect(() => {
		stickRef.current = true;
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [docId, convId]);

	// Follow new output only while the user is already at the bottom. Instant
	// (not smooth) so streaming stays in sync without animation lag.
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || !stickRef.current) return;
		el.scrollTop = el.scrollHeight;
	}, [msgs]);

	const stop = useCallback(() => {
		if (!docId || !convId) return;
		setStopped(true);
		activeStreamRef.current = null;
		window.api.stopChat(docId, convId).catch(() => {});
	}, [docId, convId]);

	// Esc stops generation while streaming.
	useEffect(() => {
		if (!streaming) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				stop();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [streaming, stop]);

	const stopActiveStream = useCallback(() => {
		const active = activeStreamRef.current;
		if (!active) return;
		activeStreamRef.current = null;
		window.api.stopChat(active.docId, active.convId).catch(() => {});
		setStreaming(false);
	}, []);

	const selectConv = useCallback(
		(id: string) => {
			if (!docId) return;
			if (id === convId) {
				setConvMenuOpen(false);
				return;
			}
			stopActiveStream();
			setConvId(id);
			convDocRef.current = docId;
			writeLastConv(docId, id);
			setConvMenuOpen(false);
			setRenamingId(null);
		},
		[docId, convId, stopActiveStream],
	);

	const createNew = async () => {
		if (!docId || convLoading) return;
		// Clicking + on an empty, untouched conversation should just focus it
		// instead of piling up empty "对话 N" entries.
		if (convId && msgs.length === 0 && !input.trim() && !streaming) {
			setConvMenuOpen(false);
			inputRef.current?.focus();
			return;
		}
		stopActiveStream();
		const c: Conv = await window.api.createConversation(docId);
		if (docIdRef.current !== docId) return;
		setConvs((prev) => [c, ...prev.filter((x) => x.id !== c.id)]);
		setConvId(c.id);
		convDocRef.current = docId;
		writeLastConv(docId, c.id);
		setMsgs([]);
		setInput("");
		setQuote(null);
		setEditingId(null);
		setConvMenuOpen(false);
		requestAnimationFrame(() => inputRef.current?.focus());
	};

	// 菜单「新建对话」(⌘N / Ctrl+N) 信号。
	useEffect(() => {
		if (newChatToken) void createNew();
	}, [newChatToken]);

	const del = async (c: Conv) => {
		if (!docId) return;
		if (!window.confirm(`删除对话「${c.title}」？此操作不可恢复。`)) return;
		if (activeStreamRef.current?.docId === docId && activeStreamRef.current.convId === c.id) {
			stopActiveStream();
		}
		const next = (await window.api.deleteConversation(docId, c.id)) as Conv[];
		if (docIdRef.current !== docId) return;
		const sorted = byRecent(next);
		setConvs(sorted);
		if (convId === c.id) {
			if (sorted.length > 0) {
				selectConv(sorted[0].id);
			} else {
				const created: Conv = await window.api.createConversation(docId);
				if (docIdRef.current !== docId) return;
				setConvs([created]);
				selectConv(created.id);
			}
		}
	};

	const startRename = (c: Conv) => {
		renameCancelRef.current = false;
		renameTextRef.current = c.title;
		setRenamingId(c.id);
		setRenameText(c.title);
	};

	const commitRename = async (id: string) => {
		if (!docId) return;
		const title = renameTextRef.current.trim();
		setRenamingId(null);
		setRenameText("");
		renameTextRef.current = "";
		if (!title) return;
		await window.api.renameConversation(docId, id, title);
		if (docIdRef.current !== docId) return;
		setConvs((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
	};

	const cancelRename = () => {
		renameCancelRef.current = true;
		renameTextRef.current = "";
		setRenamingId(null);
		setRenameText("");
	};

	/**
	 * Send `prompt` with the given `history` and stream the reply.
	 * The caller must have already appended the user message to `msgs`.
	 */
	const runChat = async (
		history: HistoryMessage[],
		prompt: string,
		persistUser = true,
	) => {
		if (!docId || !convId || convDocRef.current !== docId) return null;
		const sessionDoc = docId;
		const sessionConv = convId;
		activeStreamRef.current = { docId: sessionDoc, convId: sessionConv };
		setStopped(false);
		setStreaming(true);
		streamRef.current = "";
		reasoningRef.current = "";
		setMsgs((m) => [...m, { role: "assistant", content: "", timeline: [] }]);
		const res: { ok?: boolean; error?: string; content?: string; title?: string; userId?: string } =
			await window.api.chat(sessionDoc, sessionConv, prompt, history, page, persistUser);
		// The user may have switched documents or conversations while the
		// request was in flight. Nothing from this turn belongs to the new one.
		if (
			docIdRef.current !== sessionDoc ||
			convDocRef.current !== sessionDoc ||
			convIdRef.current !== sessionConv
		) {
			activeStreamRef.current = null;
			return res;
		}
		if (res.error) {
			activeStreamRef.current = null;
			setMsgs((m) => { const c = [...m]; c[c.length - 1] = { role: "assistant", content: `❌ ${res.error}` }; return c; });
			setStreaming(false);
			return res;
		}
		if (res.title) {
			setConvs((cs) => cs.map((c) => (c.id === sessionConv ? { ...c, title: res.title! } : c)));
		}
		if (res.content !== undefined && streamRef.current === "") {
			activeStreamRef.current = null;
			setMsgs((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: res.content! }; return c; });
			setStreaming(false);
		}
		await refreshConvs();
		return res;
	};

	const send = async () => {
		if (!input.trim() || !docId || !convId || convDocRef.current !== docId || streaming) return;
		const sessionDoc = docId;
		const sessionConv = convId;
		const q = quote;
		const text = q?.text.trim();
		// EPUB is reflowable and has no fixed page numbers — cite the chapter, not a page.
		const where = isEpub ? `第${q?.page ?? "?"}章` : `第${q?.page ?? "?"}页`;
		const blocks: string[] = [];
		if (text && q) blocks.push(`【引用文本 · ${where} · ${SELECTION_LABEL[q.kind]}】\n${text.slice(0, 4000)}`);
		// Only include mentions whose token is still present in the composer.
		const usedMentions = mentions.filter((m) => input.includes(m.token));
		for (const m of usedMentions) blocks.push(m.ref);
		const prompt = blocks.length
			? `${blocks.join("\n\n")}\n\n【问题】\n${input}`
			: input;
		// 历史带上此前各轮的工具调用与结果，追问时模型不会丢失上一轮读到的内容。
		const history = buildHistory(msgs);
		// Sending is an explicit intent to follow the reply, so re-pin to bottom.
		stickRef.current = true;
		setMsgs((m) => [...m, { role: "user", content: prompt }]);
		setInput("");
		setMention(null);
		setQuote(null);
		setQuoteEditing(false);
		const res = await runChat(history, prompt);
		// Attach the persisted id to the user turn so it becomes editable.
		if (res?.userId && docIdRef.current === sessionDoc && convIdRef.current === sessionConv) {
			const uid = res.userId;
			setMsgs((m) => {
				const c = [...m];
				for (let i = c.length - 1; i >= 0; i--) {
					if (c[i].role === "user" && !c[i].id) {
						c[i] = { ...c[i], id: uid };
						break;
					}
				}
				return c;
			});
		}
	};

	const startEdit = (m: Msg) => {
		if (!m.id) return;
		setEditingId(m.id);
		setEditText(m.content);
	};

	// Context consumption: exact usage from the provider when available, else a
	// rough estimate from the rebuilt history (tool calls/results included) plus
	// fixed prompt/tool overhead.
	const contextUsage = useMemo<ContextUsage | null>(() => {
		if (usage) return usage;
		if (!contextWindow || msgs.length === 0) return null;
		let used = 1500;
		for (const m of buildHistory(msgs)) {
			used += estimateTokens(m.content);
			if (m.toolCalls) used += estimateTokens(JSON.stringify(m.toolCalls));
		}
		return { used, max: contextWindow, estimated: true };
	}, [usage, msgs, contextWindow]);

	const saveEdit = async () => {
		if (!docId || !convId || convDocRef.current !== docId || !editingId) return;
		const target = editingId;
		const content = editText.trim();
		if (!content) return;
		setEditingId(null);
		const res = await window.api.editChat(docId, convId, target, content);
		if (
			docIdRef.current !== docId ||
			convDocRef.current !== docId ||
			convIdRef.current !== convId
		) {
			return;
		}
		if (!res.ok) {
			alert(res.error || "编辑失败");
			return;
		}
		const rows = (res.rows ?? []) as ChatRow[];
		const mapped = rows.map(toMsg);
		setMsgs(mapped);
		const last = mapped[mapped.length - 1];
		if (last) {
			await runChat(buildHistory(mapped.slice(0, -1)), last.content, false);
		}
	};

	return (
		<div className="chat">
			{docId && (
				<div className="chat-conv-head" ref={convMenuRef}>
					<button
						type="button"
						className="chat-conv-title-btn"
						onClick={() => {
							if (convMenuOpen && renamingId) void commitRename(renamingId);
							setConvMenuOpen((v) => !v);
						}}
						disabled={convLoading}
						title="切换、重命名或删除对话"
						aria-haspopup="menu"
						aria-expanded={convMenuOpen}
					>
						<Icon name="chat" size={12} />
						<span className="chat-conv-title">
							{convLoading ? "加载对话…" : convs.find((c) => c.id === convId)?.title || "新对话"}
						</span>
						<span className="chat-conv-caret">
							<Icon name="chevronDown" size={12} />
						</span>
					</button>
					<span className="spacer" />
					<button
						type="button"
						className="icon-btn"
						onClick={() => void createNew()}
						disabled={!docId || convLoading}
						title="新建对话"
					>
						<Icon name="plus" size={15} />
					</button>

					{convMenuOpen && (
						<div className="conv-menu" role="menu">
							<div className="conv-menu-head">
								<span>对话</span>
								<span className="spacer" />
								<span>{convs.length}</span>
							</div>
							<div className="conv-menu-list">
								{convs.length === 0 ? (
									<div className="conv-menu-empty">暂无对话</div>
								) : (
									convs.map((c) => (
										// biome-ignore lint/a11y/useSemanticElements: row contains its own action buttons
										<div
											key={c.id}
											className={`conv-menu-item${c.id === convId ? " active" : ""}`}
											role="menuitem"
											tabIndex={0}
											title={c.title}
											onClick={() => selectConv(c.id)}
											onKeyDown={(e) => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault();
													selectConv(c.id);
												}
											}}
										>
											{renamingId === c.id ? (
												// biome-ignore lint/a11y/noAutofocus: inline rename is explicitly requested
												<input
													ref={renameInputRef}
													className="conv-rename-input"
													value={renameText}
													onChange={(e) => {
														renameTextRef.current = e.target.value;
														setRenameText(e.target.value);
													}}
													onClick={(e) => e.stopPropagation()}
													onKeyDown={(e) => {
														e.stopPropagation();
														if (e.nativeEvent.isComposing) return;
														if (e.key === "Enter") {
															e.preventDefault();
															e.currentTarget.blur();
														} else if (e.key === "Escape") {
															e.preventDefault();
															cancelRename();
														}
													}}
													onBlur={() => {
														if (renameCancelRef.current) {
															renameCancelRef.current = false;
															return;
														}
														void commitRename(c.id);
													}}
													autoFocus
												/>
											) : (
												<>
													<span className="conv-menu-title">{c.title}</span>
													<span className="conv-menu-actions">
														<button
															type="button"
															title="重命名"
															onClick={(e) => {
																e.stopPropagation();
																startRename(c);
															}}
														>
															<Icon name="edit" size={12} />
														</button>
														<button
															type="button"
															title="删除对话"
															onClick={(e) => {
																e.stopPropagation();
																void del(c);
															}}
														>
															<Icon name="trash" size={12} />
														</button>
													</span>
												</>
											)}
										</div>
									))
								)}
							</div>
							<button type="button" className="conv-menu-new" onClick={() => void createNew()} disabled={convLoading}>
								<Icon name="plus" size={13} /> 新建对话
							</button>
						</div>
					)}
				</div>
			)}

			{convId && (msgs.length > 0 || !!quote) && (
				<div className="quick-actions">
					{["解释", "总结", "翻译", "提问"].map((t) => (
						<button key={t} type="button" onClick={() => setInput(t + (quote?.text ? "以上内容" : ""))}>
							{t}
						</button>
					))}
				</div>
			)}

			<div ref={scrollRef} className="chat-scroll" onScroll={onScroll}>
				{msgs.length === 0 ? (
					<div className="chat-empty">
						<div className="chat-empty-icon">
							<Icon name="sparkle" size={30} />
						</div>
						选中文本 → 引用提问 · {MODIFIER_LABEL} 拖拽框选
						<br />
						AI 会结合引用与全书上下文回答
					</div>
				) : (
					msgs.map((m, i) => {
						const isLast = i === msgs.length - 1;
						const tl = m.timeline ?? [];
						return (
							<div key={i} className={`msg ${m.role}`}>
								<div className="msg-avatar">{m.role === "user" ? "你" : <Icon name="sparkle" size={13} />}</div>
								<div className="msg-body">
									{m.role === "assistant" ? (
										<>
											{tl.length > 0 && <TimelineGroup items={tl} live={streaming && isLast && !m.content} />}
											{(m.content || !isLast || tl.length === 0) && (
												<div className="markdown">
													<ReactMarkdown
														remarkPlugins={[remarkGfm]}
														components={{
															code: ({ children, ...props }: { children?: React.ReactNode }) => <code {...props}>{children}</code>,
															a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
														}}
													>
														{m.content}
													</ReactMarkdown>
												</div>
											)}
											{isLast && streaming && !m.content && tl.length === 0 && <div className="msg-status">思考中…</div>}
											{isLast && stopped && !streaming && <div className="msg-status">已停止</div>}
											{m.notice && <div className="msg-status warn">{m.notice}</div>}
										</>
									) : editingId && m.id === editingId ? (
										<div className="msg-edit">
											<textarea
												value={editText}
												onChange={(e) => setEditText(e.target.value)}
												rows={3}
												onKeyDown={(e) => {
													if (e.key === "Escape") setEditingId(null);
													if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEdit();
												}}
											/>
											<div className="button-row">
												<button type="button" className="primary" onClick={saveEdit}>
													保存并重新生成
												</button>
												<button type="button" onClick={() => setEditingId(null)}>
													取消
												</button>
											</div>
										</div>
									) : (
										<div className="msg-user">
											<UserMessage content={m.content} />
											{m.id && !streaming && (
												<button
													type="button"
													className="msg-edit-btn"
													onClick={() => startEdit(m)}
													title="编辑并重新生成"
												>
													<Icon name="edit" size={13} />
												</button>
											)}
										</div>
									)}
								</div>
							</div>
						);
					})
				)}
			</div>

			{showJump && (
				<button type="button" className="scroll-down-btn" onClick={() => scrollToBottom("smooth")} title="回到最新">
					<Icon name="chevronDown" size={14} /> 回到最新
				</button>
			)}

			{(contextUsage || quote) && (
				<div className="composer-extras">
					{contextUsage && contextUsage.max > 0 && (
						<div
							className={`context-usage${
								contextUsage.used / contextUsage.max >= 0.8 ? " warn" : ""
							}`}
							title={`${contextUsage.estimated ? "约 " : ""}已用 ${contextUsage.used.toLocaleString()} / ${contextUsage.max.toLocaleString()} tokens${
								contextUsage.estimated ? "（估算，发送后以服务商返回为准）" : ""
							}`}
						>
							<div className="context-bar">
								<span
									style={{
										width: `${Math.min(100, (contextUsage.used / contextUsage.max) * 100).toFixed(1)}%`,
									}}
								/>
							</div>
							<span className="context-label">
								{contextUsage.estimated ? "≈ " : ""}
								{formatTokens(contextUsage.used)} / {formatTokens(contextUsage.max)} 上下文
							</span>
						</div>
					)}
					{quote && (
						<div className="quote-box">
							<div className="quote-head">
								<Icon name="chat" size={11} />
								<span className="quote-where">
									引用 · {isEpub ? `第${quote.page}章` : `P${quote.page}`} · {SELECTION_LABEL[quote.kind]}
								</span>
								<span className="spacer" />
								<button
									type="button"
									className="quote-act"
									onClick={() => setQuoteEditing((v) => !v)}
									title={quoteEditing ? "完成编辑" : "编辑引用内容"}
								>
									<Icon name={quoteEditing ? "check" : "edit"} size={12} />
								</button>
								<button
									type="button"
									className="quote-act"
									onClick={() => { setQuote(null); setQuoteEditing(false); }}
									title="移除引用"
								>
									<Icon name="close" size={12} />
								</button>
							</div>
							{quoteEditing ? (
								<textarea
									className="quote-edit"
									value={quote.text}
									onChange={(e) => setQuote((q) => (q ? { ...q, text: e.target.value } : q))}
									rows={3}
								/>
							) : (
								<div className="quote-text">{quote.text}</div>
							)}
						</div>
					)}
				</div>
			)}

			<div className="chat-composer">
				{mention && mentionRows.length > 0 && (
					<div className="mention-menu">
						<div className="mention-menu-head">
							{mention.category && !mention.query ? (
								<button
									type="button"
									className="mention-back"
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => setMention((m) => (m ? { ...m, category: null, index: 0 } : m))}
								>
									<Icon name="chevronLeft" size={11} /> {CATEGORY_LABEL[mention.category]}
								</button>
							) : mention.query ? (
								"搜索结果"
							) : (
								"选择引用类型"
							)}
						</div>
						{mentionRows.map((row, i) =>
							row.kind === "category" ? (
								<button
									key={`cat:${row.category}`}
									type="button"
									className={`mention-item${i === activeMentionIndex ? " active" : ""}`}
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => activateMentionRow(row)}
								>
									<Icon name={mentionIcon(row.category)} size={13} />
									<span className="mention-label">{row.label}</span>
									<span className="mention-kind">{row.count}</span>
									<Icon name="chevronRight" size={12} />
								</button>
							) : (
								<button
									key={row.item.key}
									type="button"
									className={`mention-item${i === activeMentionIndex ? " active" : ""}`}
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => applyMention(row.item)}
								>
									<Icon name={mentionIcon(row.item.kind)} size={13} />
									<span className="mention-label">{row.item.label}</span>
									<span className="mention-kind">{mentionKindLabel(row.item.kind)}</span>
								</button>
							),
						)}
					</div>
				)}
				<textarea
					ref={inputRef}
					value={input}
					onChange={(e) => { setInput(e.target.value); syncMention(); }}
					onSelect={syncMention}
					onBlur={() => setMention(null)}
					onCompositionStart={() => { composingRef.current = true; }}
					onCompositionEnd={() => { composingRef.current = false; }}
					onKeyDown={(e) => {
						if (mention && mentionRows.length > 0 && !composingRef.current && !e.nativeEvent.isComposing) {
							if (e.key === "ArrowDown") {
								e.preventDefault();
								setMention((m) => (m ? { ...m, index: Math.min(m.index + 1, mentionRows.length - 1) } : m));
								return;
							}
							if (e.key === "ArrowUp") {
								e.preventDefault();
								setMention((m) => (m ? { ...m, index: Math.max(m.index - 1, 0) } : m));
								return;
							}
							if (e.key === "Enter" || e.key === "Tab") {
								e.preventDefault();
								activateMentionRow(mentionRows[activeMentionIndex]);
								return;
							}
							if (e.key === "Escape") {
								e.preventDefault();
								// Back out of a category first, then close the picker.
								setMention((m) => (m && m.category && !m.query ? { ...m, category: null, index: 0 } : null));
								return;
							}
						}
						if (e.key === "Enter" && !e.shiftKey) {
							// Ignore the Enter used to confirm an IME candidate (中文输入法选词).
							if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
							e.preventDefault();
							send();
						}
					}}
					placeholder={
						docId
							? `输入问题，@ 引用${isEpub ? "章节 / 标注" : "目录 / 页码 / 标注"}… (Enter 发送)`
							: "请先选择文档"
					}
					disabled={!docId || !convId || streaming}
					rows={1}
				/>
				{streaming ? (
					<button type="button" className="icon-btn stop" onClick={stop} title="停止生成 (Esc)">
						<Icon name="stop" size={15} />
					</button>
				) : (
					<button type="button" className="icon-btn" onClick={send} disabled={!docId || !convId} title="发送">
						<Icon name="send" size={15} />
					</button>
				)}
			</div>
		</div>
	);
}
