import { useMemo, useState } from "react";
import { Icon } from "../Icons.tsx";
import type { Annotation } from "../AnnotationLayer.tsx";
import type { ActivityView, DocMeta } from "../../types.ts";

type Props = {
	view: ActivityView;
	width: number;
	docs: DocMeta[];
	selectedId: string | null;
	annotations: Annotation[];
	page: number;
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

export function SideBar({
	view,
	width,
	docs,
	selectedId,
	annotations,
	page,
	onImport,
	onOpenDoc,
	onRemoveDoc,
	onJumpToPage,
	onDeleteAnnotation,
	onClearAnnotations,
}: Props) {
	const [query, setQuery] = useState("");
	const [docsOpen, setDocsOpen] = useState(true);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return docs;
		return docs.filter((d) => d.title.toLowerCase().includes(q));
	}, [docs, query]);

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
							placeholder="按标题搜索文档"
							style={{ width: "100%" }}
						/>
						<div className="toolbar-muted" style={{ marginTop: 8 }}>
							{query ? `${filtered.length} / ${docs.length} 个结果` : `共 ${docs.length} 个文档`}
						</div>
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
					{query && filtered.length === 0 && <div className="empty-hint">没有匹配「{query}」的文档</div>}
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
							选中文本自动高亮，按住修饰键拖拽可框选。
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
										<span className="page-tag">P{a.page}</span>
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
