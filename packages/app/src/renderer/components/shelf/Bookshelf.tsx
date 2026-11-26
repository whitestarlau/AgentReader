import { useEffect, useMemo, useRef, useState } from "react";
import type { DocMeta } from "../../types.ts";
import type { ShelfDoc } from "../../shelf-state.ts";
import { Icon } from "../Icons.tsx";

/**
 * 书架：像主流阅读应用那样，用封面 + 进度 + 同步状态呈现书库。
 *
 * 封面的来源是主进程生成的 `library/{docId}/cover.png`（PDF 渲首页、EPUB 解封面图）。
 * 生成失败的书不报错，用 CSS 占位——书架不能因为一本书没有封面就打不开。
 */

type SortKey = "recent" | "title" | "imported";

const SORTS: Array<{ key: SortKey; label: string }> = [
	{ key: "recent", label: "最近阅读" },
	{ key: "title", label: "书名" },
	{ key: "imported", label: "导入时间" },
];

/** 当前位置：EPUB 用章节（reader-chapter.json），PDF 用页码。 */
function currentPosition(doc: ShelfDoc): number {
	if (doc.unit === "chapter") return doc.chapter ?? doc.lastPage ?? 0;
	return doc.lastPage ?? 0;
}

/** 「第 42 / 320 页」或「第 7 / 24 章」；没有分母时只显示当前位置。 */
function progressLabel(doc: ShelfDoc): string {
	const position = currentPosition(doc);
	if (!position) return "未开始";
	const unit = doc.unit === "chapter" ? "章" : "页";
	return doc.numPages ? `第 ${position} / ${doc.numPages} ${unit}` : `第 ${position} ${unit}`;
}

function progressRatio(doc: ShelfDoc): number {
	const position = currentPosition(doc);
	if (!position || !doc.numPages) return 0;
	return Math.min(1, Math.max(0, position / doc.numPages));
}

/** 没有封面时的占位：用书名首字做视觉锚点，比一块灰底好认。 */
function placeholderStyle(doc: ShelfDoc): React.CSSProperties {
	let hash = 0;
	for (const char of doc.title) hash = (hash * 31 + char.codePointAt(0)!) % 360;
	return {
		background: `linear-gradient(150deg, hsl(${hash} 32% 26%), hsl(${(hash + 40) % 360} 28% 16%))`,
	};
}

export function Bookshelf({
	docs,
	onOpen,
	onImport,
	onRemove,
	onDeleteCloud,
}: {
	docs: ShelfDoc[];
	onOpen: (docId: string) => void;
	onImport: () => void;
	onRemove: (doc: DocMeta) => void;
	/** 只在云端的书：删除云端原书与笔记（本地没有文件可删） */
	onDeleteCloud: (doc: DocMeta) => void;
}) {
	const [sort, setSort] = useState<SortKey>("recent");
	const [covers, setCovers] = useState<Record<string, string>>({});
	const urlsRef = useRef<string[]>([]);

	// 封面：主进程生成 → 读字节 → blob URL。失败就留空，让占位样式兜底。
	useEffect(() => {
		let cancelled = false;
		const missing = docs.filter((doc) => !doc.cloud && !covers[doc.id]);
		if (missing.length === 0) return;

		void (async () => {
			for (const doc of missing) {
				if (cancelled) return;
				try {
					const path = await window.api.docCover(doc.id);
					if (!path || cancelled) continue;
					const bytes = await window.api.readFile(path);
					// Uint8Array 的 buffer 可能是 SharedArrayBuffer，Blob 只收 ArrayBuffer 视图
					const buffer = bytes.buffer.slice(
						bytes.byteOffset,
						bytes.byteOffset + bytes.byteLength,
					) as ArrayBuffer;
					const url = URL.createObjectURL(new Blob([buffer], { type: "image/png" }));
					urlsRef.current.push(url);
					if (!cancelled) setCovers((prev) => ({ ...prev, [doc.id]: url }));
				} catch {}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [docs, covers]);

	// 卸载时释放 blob URL，否则每本书的封面图会一直占着内存
	useEffect(() => {
		return () => {
			for (const url of urlsRef.current) URL.revokeObjectURL(url);
			urlsRef.current = [];
		};
	}, []);

	const sorted = useMemo(() => {
		const list = [...docs];
		if (sort === "title") return list.sort((a, b) => a.title.localeCompare(b.title, "zh"));
		if (sort === "imported") return list.sort((a, b) => (b.importedAt ?? 0) - (a.importedAt ?? 0));
		// 「最近阅读」= 最后一次翻页的时间；从没读过的排在后面，按导入时间兜底
		const recent = (doc: ShelfDoc) => doc.positionUpdatedAt ?? 0;
		return list.sort((a, b) => recent(b) - recent(a) || (b.importedAt ?? 0) - (a.importedAt ?? 0));
	}, [docs, sort]);

	if (sorted.length === 0) {
		return (
			<div className="shelf shelf-empty">
				<div className="shelf-empty-inner">
					<Icon name="library" size={44} strokeWidth={1} />
					<h2>书架还是空的</h2>
					<p>导入 PDF 或 EPUB 开始阅读。书籍会被复制到本地书库，原文件不会被改动。</p>
					<button type="button" className="primary" onClick={onImport}>
						导入文档
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="shelf">
			<header className="shelf-head">
				<div className="shelf-title">
					<h2>书架</h2>
					<span className="shelf-count">{sorted.length} 本</span>
				</div>
				<div className="shelf-actions">
					<select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
						{SORTS.map((option) => (
							<option key={option.key} value={option.key}>
								{option.label}
							</option>
						))}
					</select>
					<button type="button" onClick={onImport}>
						<Icon name="plus" size={13} /> 导入
					</button>
				</div>
			</header>

			<div className="shelf-grid">
				{sorted.map((doc) => (
					<article key={doc.id} className="shelf-card">
						<button
							type="button"
							className="shelf-cover"
							onClick={() => onOpen(doc.id)}
							title={doc.cloud ? `${doc.title}（云端，点击后下载）` : doc.title}
						>
							{covers[doc.id] ? (
								<img src={covers[doc.id]} alt="" loading="lazy" />
							) : (
								<span className="shelf-cover-fallback" style={placeholderStyle(doc)}>
									{doc.title.slice(0, 1)}
								</span>
							)}
							{doc.cloud ? <span className="shelf-badge cloud">云端</span> : null}
							{doc.pending ? <span className="shelf-badge pending">待同步</span> : null}
							{!doc.cloud && doc.remote && !doc.pending ? (
								<span className="shelf-badge synced">已同步</span>
							) : null}
						</button>

						<div className="shelf-meta">
							<div className="shelf-name" title={doc.title}>
								{doc.title}
							</div>
							<div className="shelf-progress">
								<div className="shelf-progress-bar">
									<span style={{ width: `${progressRatio(doc) * 100}%` }} />
								</div>
								<span className="shelf-progress-text">{progressLabel(doc)}</span>
							</div>
						</div>

						<button
							type="button"
							className="shelf-remove"
							title={doc.cloud ? "从云端删除（原书与笔记）" : "从本地书库移除（云端副本保留）"}
							onClick={(event) => {
								event.stopPropagation();
								if (doc.cloud) onDeleteCloud(doc);
								else onRemove(doc);
							}}
						>
							<Icon name="trash" size={12} />
						</button>
					</article>
				))}
			</div>
		</div>
	);
}
