import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../Icons.tsx";
import type { Annotation } from "../AnnotationLayer.tsx";
import type { ActivityView, DocMeta, DocSearchResult } from "../../types.ts";

type Props = {
	view: ActivityView;
	width: number;
	docs: DocMeta[];
	selectedId: string | null;
	annotations: Annotation[];
	page: number;
	isEpub?: boolean;
	onImport: () => void;
	onOpenDoc: (id: string) => void;
	onRemoveDoc: (doc: DocMeta) => void;
	onJumpToPage: (page: number) => void;
	onDeleteAnnotation: (id: string) => void;
	onClearAnnotations: () => void;
};

const TITLES: Record<ActivityView, string> = {
	explorer: "图书馆",
	search: "搜索",
	annotations: "标注",
};

/** Wrap the first case-insensitive match of `q` in a <mark>. */
function highlightMatch(text: string, q: string) {
	const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
	if (i < 0) return text;
	return (
		<>
			{text.slice(0, i)}
			<mark>{text.slice(i, i + q.length)}</mark>
			{text.slice(i + q.length)}
		</>
	);
}

export function SideBar({
	view,
	width,
	docs,
	selectedId,
	annotations,
	page,
	isEpub,
	onImport,
	onOpenDoc,
	onRemoveDoc,
	onJumpToPage,
	onDeleteAnnotation,
	onClearAnnotations,
}: Props) {
	const [query, setQuery] = useState("");
	const [docsOpen, setDocsOpen] = useState(true);
	// In-document full-text search (same engine as the AI's search_document tool).
	const [scope, setScope] = useState<"doc" | "titles">("doc");
	const [searching, setSearching] = useState(false);
	const [docResult, setDocResult] = useState<DocSearchResult | null>(null);
	// Locators whose snippets are expanded (results are collapsed by default).
	const [expanded, setExpanded] = useState<Set<number>>(new Set());
	const searchSeq = useRef(0);

	const toggleHit = (locator: number) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(locator)) next.delete(locator);
			else next.add(locator);
			return next;
		});

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return docs;
		return docs.filter((d) => d.title.toLowerCase().includes(q));
	}, [docs, query]);

	// Default to in-document search whenever a document is open.
	useEffect(() => {
		setScope(selectedId ? "doc" : "titles");
	}, [selectedId]);

	// Debounced full-text search of the current document.
	useEffect(() => {
		const q = query.trim();
		if (scope !== "doc" || !selectedId || !q) {
			setDocResult(null);
			setSearching(false);
			setExpanded(new Set());
			return;
		}
		setSearching(true);
		setExpanded(new Set());
		const seq = ++searchSeq.current;
		const t = window.setTimeout(() => {
			window.api
				.searchDoc(selectedId, q, { limit: 60 })
				.then((res) => {
					if (seq === searchSeq.current) setDocResult(res);
				})
				.catch(() => {
					if (seq === searchSeq.current) setDocResult(null);
				})
				.finally(() => {
					if (seq === searchSeq.current) setSearching(false);
				});
		}, 180);
		return () => window.clearTimeout(t);
	}, [query, scope, selectedId]);

	return (
		<aside className="sidebar" style={{ width, flexBasis: width }}>
			<div className="sidebar-header">
				<span>{TITLES[view]}</span>
				<span className="spacer" />
				{view === "explorer" && (
					<button type="button" className="icon-btn" title="导入 PDF / EPUB" onClick={onImport}>
						<Icon name="plus" size={15} />
					</button>
				)}
			</div>

			{view === "explorer" && (
				<div className="sidebar-content">
					<div className="sidebar-section">
						<button
							type="button"
							className="section-title"
							style={{ background: "none", border: "none", width: "100%", cursor: "pointer", textAlign: "left" }}
							onClick={() => setDocsOpen((v) => !v)}
						>
							<span className="chev">
								<Icon name={docsOpen ? "chevronDown" : "chevronRight"} size={14} />
							</span>
							<span>文档</span>
							<span className="count">{docs.length}</span>
						</button>
						{docsOpen &&
							(docs.length === 0 ? (
								<div className="empty-hint">
									<div className="empty-hint-title">还没有文档</div>
									点击右上角 ＋ 导入 PDF / EPUB，文件会被复制到本地图书馆。
								</div>
							) : (
								<div>
									{docs.map((d) => (
										<div
											key={d.id}
											className={`row${selectedId === d.id ? " active" : ""}`}
											onClick={() => onOpenDoc(d.id)}
											onKeyDown={(e) => e.key === "Enter" && onOpenDoc(d.id)}
											role="button"
											tabIndex={0}
										>
											<Icon name={d.ext === "epub" ? "book" : "file"} size={14} />
											<span className="row-label" title={d.title}>
												{d.title}
											</span>
											<span className="row-sub">{d.ext ?? "pdf"}</span>
											<button
												type="button"
												className="row-action danger"
												title="删除文档（含标注、对话与 OCR 缓存）"
												onClick={(e) => {
													e.stopPropagation();
													onRemoveDoc(d);
												}}
											>
												<Icon name="trash" size={13} />
											</button>
										</div>
									))}
								</div>
							))}
					</div>
				</div>
			)}

			{view === "search" && (
				<div className="sidebar-content">
					<div className="sidebar-actions">
						<input
							// biome-ignore lint/a11y/noAutofocus: search view is explicitly requested
							autoFocus
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder={scope === "doc" ? "在当前文档中检索…" : "按标题搜索文档"}
							style={{ width: "100%" }}
						/>
						<div className="search-scope">
							<button
								type="button"
								className={scope === "doc" ? "active" : ""}
								disabled={!selectedId}
								title={selectedId ? "在当前文档全文检索" : "请先打开一个文档"}
								onClick={() => setScope("doc")}
							>
								当前文档
							</button>
							<button
								type="button"
								className={scope === "titles" ? "active" : ""}
								onClick={() => setScope("titles")}
							>
								文档标题
							</button>
						</div>
					</div>

					{scope === "doc" ? (
						!selectedId ? (
							<div className="empty-hint">先打开一个文档，再在当前文档中检索。</div>
						) : !query.trim() ? (
							<div className="empty-hint">
								<div className="empty-hint-title">文档内全文检索</div>
								输入关键词，按章节 / 页码命中次数排序；点击结果可跳转。
							</div>
						) : searching && !docResult ? (
							<div className="toolbar-muted" style={{ padding: "0 8px" }}>
								搜索中…
							</div>
						) : !docResult || docResult.hits.length === 0 ? (
							<div className="empty-hint">未找到「{query.trim()}」</div>
						) : (
							<div className="sidebar-section">
								<div className="toolbar-muted" style={{ padding: "0 8px 6px" }}>
									{docResult.hits.length} 个{docResult.unit === "chapter" ? "章节" : "页面"}命中 · 共{" "}
									{docResult.hits.reduce((n, h) => n + h.count, 0)} 处
								</div>
								{docResult.hits.map((h) => {
									const open = expanded.has(h.locator);
									return (
										<div
											key={h.locator}
											className={`search-hit${open ? " open" : ""}${page === h.locator ? " active" : ""}`}
										>
											<div className="search-hit-head">
												<button
													type="button"
													className="search-hit-toggle"
													onClick={() => toggleHit(h.locator)}
													title={open ? "收起片段" : "展开片段"}
												>
													<Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
													<span className="page-tag">
														{isEpub ? `第${h.locator}章` : `P${h.locator}`}
													</span>
													{h.label && <span className="search-hit-label">{h.label}</span>}
													<span className="spacer" style={{ flex: 1 }} />
													<span className="search-hit-count">{h.count} 处</span>
												</button>
												<button
													type="button"
													className="search-hit-jump"
													title={isEpub ? "跳转到该章" : "跳转到该页"}
													onClick={() => onJumpToPage(h.locator)}
												>
													跳转
												</button>
											</div>
											{open &&
												h.snippets.map((s, i) => (
													<div key={i} className="search-hit-snippet">
														{highlightMatch(s, query.trim())}
													</div>
												))}
										</div>
									);
								})}
							</div>
						)
					) : (
						<>
							<div className="toolbar-muted" style={{ padding: "0 8px 6px" }}>
								{query ? `${filtered.length} / ${docs.length} 个结果` : `共 ${docs.length} 个文档`}
							</div>
							{filtered.map((d) => (
								<div
									key={d.id}
									className={`row${selectedId === d.id ? " active" : ""}`}
									onClick={() => onOpenDoc(d.id)}
									onKeyDown={(e) => e.key === "Enter" && onOpenDoc(d.id)}
									role="button"
									tabIndex={0}
								>
									<Icon name={d.ext === "epub" ? "book" : "file"} size={14} />
									<span className="row-label">{d.title}</span>
								</div>
							))}
							{query && filtered.length === 0 && (
								<div className="empty-hint">没有匹配「{query}」的文档</div>
							)}
						</>
					)}
				</div>
			)}

			{view === "annotations" && (
				<div className="sidebar-content">
					<div className="sidebar-header" style={{ height: 28, flexBasis: 28 }}>
						<span style={{ textTransform: "none", letterSpacing: 0 }}>共 {annotations.length} 条</span>
						<span className="spacer" />
						{annotations.length > 0 && (
							<button type="button" className="icon-btn" title="清空当前文档的所有标注" onClick={onClearAnnotations}>
								<Icon name="trash" size={14} />
							</button>
						)}
					</div>
					{!selectedId ? (
						<div className="empty-hint">先打开一个文档，再查看它的标注。</div>
					) : annotations.length === 0 ? (
						<div className="empty-hint">
							<div className="empty-hint-title">暂无标注</div>
							{isEpub ? "选中文本后点击「高亮标注」。" : "选中文本自动高亮，按住修饰键拖拽可框选。"}
						</div>
					) : (
						<div className="sidebar-section">
							{annotations.map((a) => (
								<div
									key={a.id}
									className={`ann-card${page === a.page ? " active" : ""}`}
									onClick={() => onJumpToPage(a.page)}
									onKeyDown={(e) => e.key === "Enter" && onJumpToPage(a.page)}
									role="button"
									tabIndex={0}
									title="点击跳转到该页"
								>
									<div className="ann-card-head">
										<span className="page-tag">{isEpub ? `第${a.page}章` : `P${a.page}`}</span>
										<span>{a.type === "rect" ? "框选" : "高亮"}</span>
										<span className="spacer" style={{ flex: 1 }} />
										<button
											type="button"
											className="row-action danger"
											title="删除标注"
											onClick={(e) => {
												e.stopPropagation();
												onDeleteAnnotation(a.id);
											}}
										>
											<Icon name="trash" size={12} />
										</button>
									</div>
									<div className="ann-card-body">{a.text?.trim() || "（无文本）"}</div>
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</aside>
	);
}
