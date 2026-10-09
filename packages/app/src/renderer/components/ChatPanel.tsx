import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "./Icons.tsx";
import type { Annotation } from "./AnnotationLayer.tsx";
import { type Selection, MODIFIER_LABEL, SELECTION_LABEL } from "../selection.ts";

type TimelineItem =
	| { kind: "reasoning"; content: string }
	| { kind: "tool"; id: string; name: string; args: string; result?: string; pending?: boolean };

type Msg = {
	id?: string;
	role: "user" | "assistant";
	content: string;
	timeline?: TimelineItem[];
	stopped?: boolean;
};
type ChatRow = { id?: string; role?: string; content?: string; timeline?: TimelineItem[] };
type Conv = { id: string; title: string };
type Props = { selection: Selection | null; docId: string | null; page: number; isEpub?: boolean; annotations?: Annotation[] };

type Outline = { unit: "page" | "chapter"; numPages: number; chapterLabels: string[]; toc: { label: string; href: string }[] };

/** An item the user can reference with "@" in the composer. */
type MentionItem = {
	key: string;
	kind: "annotation" | "chapter";
	page: number;
	/** Shown in the picker list. */
	label: string;
	/** Literal text inserted into the composer. */
	token: string;
	/** Context block prepended to the prompt when the token is still present. */
	ref: string;
};

type MentionCategory = "annotation" | "chapter";

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

function refIcon(header: string): "book" | "annotations" | "chat" {
	if (header.includes("章节")) return "book";
	if (header.includes("标注")) return "annotations";
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

/** One collapsible block. Collapsed by default; opens only on explicit click. */
function Disclosure({
	icon,
	title,
	meta,
	streaming,
	children,
}: {
	icon: "sparkle" | "tool";
	title: string;
	meta?: string;
	streaming?: boolean;
	children?: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className={`disclosure${open ? " open" : ""}${streaming ? " active" : ""}`}>
			<button type="button" className="disclosure-head" onClick={() => setOpen((v) => !v)}>
				<Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
				<span className="disclosure-icon">{icon === "sparkle" ? <Icon name="sparkle" size={12} /> : <Icon name="tool" size={12} />}</span>
				<span className="disclosure-title">{title}</span>
				{meta && <span className="disclosure-meta">{meta}</span>}
			</button>
			{open && <div className="disclosure-body">{children}</div>}
		</div>
	);
}

export function ChatPanel({ selection, docId, page, isEpub, annotations = [] }: Props) {
	const [convs, setConvs] = useState<Conv[]>([]);
	const [convId, setConvId] = useState<string | null>(null);
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
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const composingRef = useRef(false);

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
	const allMentions = useMemo(() => [...annotationMentions, ...chapterMentions], [annotationMentions, chapterMentions]);

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
			if (chapterMentions.length) cats.push({ kind: "category", category: "chapter", label: "章节", count: chapterMentions.length });
			if (annotationMentions.length) cats.push({ kind: "category", category: "annotation", label: "标注", count: annotationMentions.length });
			return cats;
		}
		const list = mention.category === "chapter" ? chapterMentions : annotationMentions;
		return list.slice(0, 200).map((item) => ({ kind: "item", item }) as MentionRow);
	}, [mention, allMentions, annotationMentions, chapterMentions]);
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

	const refreshConvs = async (current?: string | null) => {
		if (!docId) return;
		const list: Conv[] = await window.api.listConversations(docId);
		// Preserve a locally-generated title if the disk copy still has the
		// generic placeholder (guards against read-after-write races).
		setConvs((prev) =>
			list.map((c) => {
				const local = prev.find((p) => p.id === c.id);
				const placeholder = !c.title || /^对话 \d+$/.test(c.title);
				return local && placeholder && local.title && !/^对话 \d+$/.test(local.title)
					? { ...c, title: local.title }
					: c;
			}),
		);
		const cid = current ?? convId;
		if (list.length > 0 && !cid) setConvId(list[0].id);
		if (list.length === 0) {
			const c: Conv = await window.api.createConversation(docId);
			setConvs([c]);
			setConvId(c.id);
		}
	};

	useEffect(() => { refreshConvs(); }, [docId]);
	useEffect(() => {
		if (!docId || !convId) { setMsgs([]); return; }
		window.api.getChats(docId, convId).then((rows) => setMsgs(rows.map(toMsg)));
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
		const offDelta = window.api.onChatDelta((delta: string) => {
			streamRef.current += delta;
			updateLast((m) => ({ ...m, content: streamRef.current }));
		});
		const offReasoning = window.api.onChatReasoning((delta: string) => {
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
			const d = data as { id?: string; name: string; args: string };
			pushTimeline({ kind: "tool", id: d.id ?? `tool-${Date.now()}`, name: d.name, args: d.args, pending: true });
		});
		const offToolResult = window.api.onToolResult((data: unknown) => {
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
		const offDone = window.api.onChatDone(() => setStreaming(false));
		return () => { offDelta(); offReasoning(); offToolCall(); offToolResult(); offDone(); };
	}, [updateLast, pushTimeline]);

	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
	}, [msgs]);

	const stop = useCallback(() => {
		if (!docId || !convId) return;
		setStopped(true);
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

	const createNew = async () => {
		if (!docId) return;
		const c: Conv = await window.api.createConversation(docId);
		setConvs((prev) => [c, ...prev]);
		setConvId(c.id);
		setMsgs([]);
	};

	const del = async (id: string) => {
		if (!docId) return;
		const next = (await window.api.deleteConversation(docId, id)) as Conv[];
		setConvs(next);
		if (convId === id) {
			if (next.length > 0) setConvId(next[0].id);
			else {
				const c: Conv = await window.api.createConversation(docId);
				setConvs([c]);
				setConvId(c.id);
			}
		}
	};

	/**
	 * Send `prompt` with the given `history` and stream the reply.
	 * The caller must have already appended the user message to `msgs`.
	 */
	const runChat = async (
		history: { role: string; content: string }[],
		prompt: string,
		persistUser = true,
	) => {
		if (!docId || !convId) return null;
		setStopped(false);
		setStreaming(true);
		streamRef.current = "";
		reasoningRef.current = "";
		setMsgs((m) => [...m, { role: "assistant", content: "", timeline: [] }]);
		const res: { ok?: boolean; error?: string; content?: string; title?: string; userId?: string } =
			await window.api.chat(docId, convId, prompt, history, page, persistUser);
		if (res.error) {
			setMsgs((m) => { const c = [...m]; c[c.length - 1] = { role: "assistant", content: `❌ ${res.error}` }; return c; });
			setStreaming(false);
			return res;
		}
		if (res.title) {
			setConvs((cs) => cs.map((c) => (c.id === convId ? { ...c, title: res.title! } : c)));
		}
		if (res.content !== undefined && streamRef.current === "") {
			setMsgs((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: res.content! }; return c; });
			setStreaming(false);
		}
		refreshConvs(convId);
		return res;
	};

	const send = async () => {
		if (!input.trim() || !docId || !convId || streaming) return;
		const sel = selection;
		const quote = sel?.text?.trim();
		// EPUB is reflowable and has no fixed page numbers — cite the chapter, not a page.
		const where = isEpub ? `第${sel?.page ?? "?"}章` : `第${sel?.page ?? "?"}页`;
		const blocks: string[] = [];
		if (quote && sel) blocks.push(`【引用文本 · ${where} · ${SELECTION_LABEL[sel.kind]}】\n${quote.slice(0, 4000)}`);
		// Only include mentions whose token is still present in the composer.
		const usedMentions = mentions.filter((m) => input.includes(m.token));
		for (const m of usedMentions) blocks.push(m.ref);
		const prompt = blocks.length
			? `${blocks.join("\n\n")}\n\n【问题】\n${input}`
			: input;
		const history = msgs.map((m) => ({ role: m.role, content: m.content }));
		setMsgs((m) => [...m, { role: "user", content: prompt }]);
		setInput("");
		setMention(null);
		const res = await runChat(history, prompt);
		// Attach the persisted id to the user turn so it becomes editable.
		if (res?.userId) {
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

	const saveEdit = async () => {
		if (!docId || !convId || !editingId) return;
		const target = editingId;
		const content = editText.trim();
		if (!content) return;
		setEditingId(null);
		const res = await window.api.editChat(docId, convId, target, content);
		if (!res.ok) {
			alert(res.error || "编辑失败");
			return;
		}
		const rows = (res.rows ?? []) as ChatRow[];
		const mapped = rows.map(toMsg);
		setMsgs(mapped);
		const last = mapped[mapped.length - 1];
		if (last) {
			await runChat(
				mapped.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
				last.content,
				false,
			);
		}
	};

	return (
		<div className="chat">
			{convId && msgs.length > 0 ? (
				<div className="chat-conv-head">
					<span className="chat-conv-title" title={convs.find((c) => c.id === convId)?.title}>
						{convs.find((c) => c.id === convId)?.title || "对话"}
					</span>
					<span className="spacer" />
					<button type="button" className="icon-btn" onClick={createNew} disabled={!docId} title="新建对话">
						<Icon name="plus" size={15} />
					</button>
				</div>
			) : (
				<div className="conv-picker">
					<div className="conv-picker-head">选择或新建对话</div>
					{convs.length > 0 && (
						<div className="conv-list">
							{convs.map((c) => (
								<button
									key={c.id}
									type="button"
									className="conv-item"
									onClick={() => setConvId(c.id)}
									title={c.title}
								>
									<Icon name="chat" size={13} />
									<span className="conv-item-title">{c.title}</span>
									<span
										className="conv-item-del"
										role="button"
										tabIndex={0}
										title="删除对话"
										onClick={(e) => {
											e.stopPropagation();
											del(c.id);
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												e.stopPropagation();
												del(c.id);
											}
										}}
									>
										<Icon name="close" size={11} />
									</span>
								</button>
							))}
						</div>
					)}
					<button type="button" className="conv-new-btn" onClick={createNew} disabled={!docId}>
						<Icon name="plus" size={14} /> 新建对话
					</button>
				</div>
			)}

			{convId && msgs.length > 0 && (
				<>
					{selection?.text && (
						<div className="quote-box">
							<div className="quote-head">
								引用 · P{selection.page} · {SELECTION_LABEL[selection.kind]}
							</div>
							<div className="quote-text">{selection.text.slice(0, 400)}</div>
						</div>
					)}

					<div className="quick-actions">
						{["解释", "总结", "翻译", "提问"].map((t) => (
							<button key={t} type="button" onClick={() => setInput(t + (selection?.text ? "以上内容" : ""))}>
								{t}
							</button>
						))}
					</div>
				</>
			)}

			<div ref={scrollRef} className="chat-scroll">
				{msgs.length === 0 ? (
					<div className="chat-empty">
						<div className="chat-empty-icon">
							<Icon name="sparkle" size={30} />
						</div>
						选中文本或 {MODIFIER_LABEL} 框选后提问
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
											{tl.length > 0 && (
												<div className="timeline">
													{tl.map((it, j) =>
														it.kind === "reasoning" ? (
															<Disclosure key={j} icon="sparkle" title="思考" streaming={streaming && isLast && it.content !== ""}>
																<div className="reasoning-text">{it.content || "…"}</div>
															</Disclosure>
														) : (
															<Disclosure
																key={j}
																icon="tool"
																title={it.name}
																meta={toolSummary(it.name, it.args)}
																streaming={!!it.pending}
															>
																<div className="tool-args">
																	<code>{it.args}</code>
																</div>
																{it.result !== undefined && (
																	<pre className="tool-result">{it.result.slice(0, 4000)}</pre>
																)}
															</Disclosure>
														),
													)}
												</div>
											)}
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
											{isLast && streaming && !m.content && tl.length > 0 && <div className="msg-status">生成中…</div>}
											{isLast && stopped && !streaming && <div className="msg-status">已停止</div>}
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
									<Icon name="chevronLeft" size={11} /> {mention.category === "chapter" ? "章节" : "标注"}
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
									<Icon name={row.category === "chapter" ? "book" : "annotations"} size={13} />
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
									<Icon name={row.item.kind === "chapter" ? "book" : "annotations"} size={13} />
									<span className="mention-label">{row.item.label}</span>
									<span className="mention-kind">{row.item.kind === "chapter" ? "章节" : "标注"}</span>
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
					placeholder={docId ? "输入问题，@ 引用章节 / 标注… (Enter 发送)" : "请先选择文档"}
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
