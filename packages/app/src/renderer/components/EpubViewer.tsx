import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icons.tsx";
import {
	loadReadingCfi,
	loadReadingLoc,
	parseEpubLocation,
	type EpubLocation,
	saveReadingLoc,
	serializeEpubLocation,
} from "../reading.ts";
// @ts-ignore
import ePub from "epubjs";

type Props = {
	docId: string;
	onTextSelected: (text: string) => void;
	onPageChange?: (page: number) => void;
	onTotalChange?: (total: number) => void;
};

type SpreadMode = "single" | "double";

// epubjs 的类型是 UMD：`import ePub from "epubjs"` 在 Node16 解析下拿到的是模块命名空间，
// 而不是可调用的默认导出。这里从模块声明的 `default` 导出里恢复真实的工厂/实例类型。
type EpubBook = ReturnType<(typeof import("epubjs"))["default"]>;
type Rendition = ReturnType<EpubBook["renderTo"]>;

const createBook = ePub as unknown as (input: string | ArrayBuffer) => EpubBook;

type ManagerLike = {
	container?: { scrollLeft: number; clientWidth: number; scrollWidth: number };
	scrollTo?: (x: number, y: number, silent?: boolean) => void;
	currentLocation: () => unknown;
	layout?: { divisor?: number };
};

const SPREAD_STORAGE_KEY = "epub-spread-mode";

function readSpreadMode(): SpreadMode {
	try {
		return localStorage.getItem(SPREAD_STORAGE_KEY) === "single" ? "single" : "double";
	} catch {
		return "double";
	}
}

function getManager(rendition: Rendition | null): ManagerLike | null {
	if (!rendition) return null;
	return (rendition as unknown as { manager?: ManagerLike }).manager ?? null;
}

/** Section href + in-section scroll offset for the current view. */
function captureLocation(rendition: Rendition | null): EpubLocation | null {
	const manager = getManager(rendition);
	if (!manager?.container) return null;
	const views = (manager as unknown as { views?: { first: () => { section?: { href?: string } } | null } }).views;
	const section = views?.first?.()?.section;
	if (!section?.href) return null;
	return { href: section.href, offset: Math.max(0, Math.round(manager.container.scrollLeft)) };
}

/** Place the reader at a saved section + offset without using CFIs. */
async function applyLocation(rendition: Rendition, loc: EpubLocation) {
	try {
		await rendition.display(loc.href);
	} catch {
		return;
	}
	// display() is async about layout; give the container a beat to settle.
	await new Promise((r) => setTimeout(r, 120));
	const manager = getManager(rendition);
	if (manager?.scrollTo && manager.container) {
		const maxOffset = Math.max(0, manager.container.scrollWidth - manager.container.clientWidth);
		manager.scrollTo(Math.min(loc.offset, maxOffset), 0, true);
	}
}

export function EpubViewer({ docId, onTextSelected, onPageChange, onTotalChange }: Props) {
	const ref = useRef<HTMLDivElement>(null);
	const renditionRef = useRef<Rendition | null>(null);
	const [toc, setToc] = useState<{ label: string; href: string }[]>([]);
	const [atStart, setAtStart] = useState(true);
	const [atEnd, setAtEnd] = useState(false);
	const [spreadMode, setSpreadMode] = useState<SpreadMode>(readSpreadMode);
	const spreadModeRef = useRef<SpreadMode>(spreadMode);
	spreadModeRef.current = spreadMode;

	// Report page/total up to the status bar without re-subscribing on every render.
	const pageCb = useRef(onPageChange);
	pageCb.current = onPageChange;
	const totalCb = useRef(onTotalChange);
	totalCb.current = onTotalChange;

	const [error, setError] = useState<string | null>(null);

	// 仅支持单栏 / 双栏（最多两栏）。切换后重排，并尽量停留在原阅读位置。
	// 注意：不要用 clear()+display(cfi)。epub.js 在 paginated 双栏下把同一个
	// CFI 重定位到比 currentLocation() 报告更早的一页，会导致"翻页接不上"。
	// 改为按「章节 href + 页偏移」恢复。
	const applySpread = useCallback((mode: SpreadMode) => {
		setSpreadMode(mode);
		spreadModeRef.current = mode;
		try {
			localStorage.setItem(SPREAD_STORAGE_KEY, mode);
		} catch {}
		const rendition = renditionRef.current;
		if (!rendition) return;
		const saved = captureLocation(rendition);
		// "both" + minSpreadWidth=0：显式按用户选择生效，不会再出现第三栏。
		// spread() 自身会触发 updateLayout() 重排列，不需要再 resize()。
		rendition.spread(mode === "double" ? "both" : "none", 0);
		if (!saved) return;
		void (async () => {
			// 等重排完成后再按新页宽把偏移对齐到页起点。
			await new Promise((r) => setTimeout(r, 250));
			const manager = getManager(rendition);
			if (!manager?.container || !manager.scrollTo) return;
			const width = manager.container.clientWidth || 1;
			const pageWidth = (manager as unknown as { layout?: { pageWidth?: number } }).layout?.pageWidth;
			// 双栏步进 = 2 个页宽；单栏步进 = 1 个页宽。
			const step = pageWidth && pageWidth > 0 ? pageWidth : width;
			const aligned = Math.floor(saved.offset / step) * step;
			const maxOffset = Math.max(0, manager.container.scrollWidth - width);
			manager.scrollTo(Math.min(aligned, maxOffset), 0, true);
		})();
	}, []);

	useEffect(() => {
		let book: EpubBook | null = null;
		let ro: ResizeObserver | null = null;
		let resizeTimer: number | undefined;
		let disposed = false;
		(async () => {
			try {
				const path = await window.api.getDocPath(docId);
				if (!path || !ref.current) return;
				const raw = await window.api.readFile(path) as unknown as Uint8Array | { data: number[] } | ArrayBuffer;
				let buffer: ArrayBuffer;
				if (raw instanceof Uint8Array) buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
				else if (raw && typeof raw === "object" && "data" in raw) buffer = new Uint8Array((raw as { data: number[] }).data).buffer;
				else if (raw instanceof ArrayBuffer) buffer = raw;
				else buffer = raw as unknown as ArrayBuffer;
				console.log("[epub] loading", path, "size", (buffer as ArrayBuffer).byteLength);
				book = createBook(buffer);
			await book.ready;
			console.log("[epub] ready", book);
			setToc((book.navigation as { toc: { label: string; href: string }[] })?.toc ?? []);
			const rendition = book.renderTo(ref.current, { width: "100%", height: "100%", flow: "paginated", allowScriptedContent: true, minSpreadWidth: 0 });
			// 显式应用当前分栏选择（minSpreadWidth=0 时不会因窗口宽度退化）
			rendition.spread(spreadModeRef.current === "double" ? "both" : "none", 0);
			renditionRef.current = rendition as unknown as typeof renditionRef.current;
			rendition.themes.default({
				body: { "font-family": "Inter, sans-serif", "line-height": "1.7", padding: "24px", "background-color": "#fff", "max-width": "100%", "word-wrap": "break-word", "overflow-wrap": "break-word" },
				"img": { "max-width": "100% !important", height: "auto !important" },
				"pre": { "white-space": "pre-wrap", "word-wrap": "break-word" },
			});
			// Resume the last read position for this document.
			// Prefer the section href + scroll offset form (round-trips exactly);
			// fall back to a legacy CFI for documents saved before this change.
			const stored = await window.api.getReading(docId).catch(() => null);
			const savedLoc = loadReadingLoc(docId) ?? parseEpubLocation(stored?.location);
			const legacyCfi = loadReadingCfi(docId) ?? (stored?.location && !parseEpubLocation(stored.location) ? stored.location : null);
			if (savedLoc) {
				await applyLocation(rendition, savedLoc);
			} else {
				await rendition.display(legacyCfi ?? undefined);
			}
			console.log("[epub] displayed");
			const update = () => {
				const loc = rendition.currentLocation() as unknown as { atStart: boolean; atEnd: boolean; start?: { cfi?: string } };
				setAtStart(!!loc?.atStart);
				setAtEnd(!!loc?.atEnd);
				// Map the current CFI to a generated "page" index. This is
				// display-only: positions are still restored by href + offset,
				// never by re-displaying a CFI (see comment above).
				const locations = book?.locations;
				if (locations && locations.length() > 0 && loc?.start?.cfi) {
					// epubjs types claim `Location`, but it actually returns a numeric index.
					const idx = locations.locationFromCfi(loc.start.cfi) as unknown as number;
					if (idx >= 0) pageCb.current?.(idx + 1);
				}
				// Persist reading position (href + offset) so reopening resumes here.
				const current = captureLocation(rendition);
				if (current) {
					saveReadingLoc(docId, current);
					window.api.saveReading(docId, { location: serializeEpubLocation(current) }).catch(() => {});
				}
			};
			// Build a pagination map in the background; until it's ready the
			// status bar shows an unknown total. length() is the boundary count,
			// which matches the page range produced by locationFromCfi()+1.
			const locBook = book;
			if (locBook) {
				locBook.locations
					.generate(1600)
					.then(() => {
						if (disposed) return;
						totalCb.current?.(locBook.locations.length());
						update();
					})
					.catch((e: unknown) => console.error("[epub] locations", e));
			}
			rendition.on("relocated", update);
			rendition.on("keydown", (e: KeyboardEvent) => {
				if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") { e.preventDefault(); rendition.next(); }
				else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); rendition.prev(); }
			});
			rendition.on("selected", (cfiRange: string, contents: { window: Window }) => {
				const sel = contents.window.getSelection();
				const text = sel?.toString().trim();
				if (text) onTextSelected(text);
				book?.getRange(cfiRange);
			});
			// also bind inside iframe document for direct key
			rendition.on("rendered", (_: unknown, contents: { document: Document }) => {
				const doc = contents.document;
				doc.addEventListener("keydown", (e: KeyboardEvent) => {
					if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") { e.preventDefault(); rendition.next(); }
					else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); rendition.prev(); }
				});
			});
			// epubjs 只监听 window.resize；收起侧栏 / 拖动分隔条只会改变容器宽度，
			// 不会触发 window.resize，必须自己观察容器并主动重排，否则会露出半截下一栏。
			// 另外 epub.js 的 resize() 会用 currentLocation().start.cfi 重定位，
			// 而该 CFI 在双栏下会跳到更早一页，所以重排后按偏移量校正回来。
			if (!disposed && ref.current) {
				ro = new ResizeObserver(() => {
					if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
					resizeTimer = window.setTimeout(() => {
						const at = captureLocation(rendition);
						try { (rendition as unknown as { resize: () => void }).resize(); } catch {}
						if (!at) return;
						window.setTimeout(() => {
							const manager = getManager(rendition);
							if (manager?.scrollTo && manager.container) {
								const maxOffset = Math.max(0, manager.container.scrollWidth - manager.container.clientWidth);
								manager.scrollTo(Math.min(at.offset, maxOffset), 0, true);
							}
						}, 60);
					}, 120);
				});
				ro.observe(ref.current);
			}
			// 少数书的元数据会把 spread 强制为 none，这里在监听就绪后按用户选择再确认一次。
			// 同样不用 clear()+display(cfi)（会因 CFI 偏差跳页），改为重排后按偏移恢复。
			{
				const wantDouble = spreadModeRef.current === "double";
				const divisor = (rendition as unknown as { manager?: { layout?: { divisor?: number } } }).manager?.layout?.divisor;
				if ((wantDouble && divisor !== 2) || (!wantDouble && divisor !== 1)) {
					const at = captureLocation(rendition);
					rendition.spread(wantDouble ? "both" : "none", 0);
					if (at) {
						await new Promise((r) => setTimeout(r, 250));
						const manager = getManager(rendition);
						if (manager?.scrollTo && manager.container) {
							const maxOffset = Math.max(0, manager.container.scrollWidth - manager.container.clientWidth);
							manager.scrollTo(Math.min(at.offset, maxOffset), 0, true);
						}
					}
				}
			}
			update();
			} catch (e) {
				console.error("[epub] error", e);
				setError(String(e));
			}
		})();
		return () => {
			disposed = true;
			if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
			ro?.disconnect();
			try { renditionRef.current?.destroy(); } catch {}
			try { book?.destroy(); } catch {}
		};
	}, [docId]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
			if ((e.target as HTMLElement)?.closest?.("iframe")) return;
			if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") { e.preventDefault(); renditionRef.current?.next(); }
			else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); renditionRef.current?.prev(); }
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	if (error)
		return (
			<div className="document-stage" style={{ alignItems: "center", justifyContent: "center" }}>
				<div style={{ color: "#f48771", whiteSpace: "pre-wrap", textAlign: "center", maxWidth: 480 }}>
					EPUB 加载失败: {error}
					<br />
					<span className="toolbar-muted">请检查终端 [epub] 日志</span>
				</div>
			</div>
		);

	return (
		<div className="editor-area" style={{ background: "#fff" }}>
			<div className="editor-toolbar">
				<button type="button" className="icon-btn" onClick={() => renditionRef.current?.prev()} disabled={atStart} title="上一章" style={{ width: "auto", padding: "0 8px" }}>
					<Icon name="chevronLeft" size={14} /> 上一章
				</button>
				<button type="button" className="icon-btn" onClick={() => renditionRef.current?.next()} disabled={atEnd} title="下一章" style={{ width: "auto", padding: "0 8px" }}>
					下一章 <Icon name="chevronRight" size={14} />
				</button>
				<span className="toolbar-sep" />
				<div className="toolbar-group" role="group" aria-label="分栏方式">
					<button
						type="button"
						className={`icon-btn${spreadMode === "single" ? " active" : ""}`}
						onClick={() => applySpread("single")}
						title="单栏"
						aria-pressed={spreadMode === "single"}
						style={{ width: "auto", padding: "0 8px" }}
					>
						单栏
					</button>
					<button
						type="button"
						className={`icon-btn${spreadMode === "double" ? " active" : ""}`}
						onClick={() => applySpread("double")}
						title="双栏"
						aria-pressed={spreadMode === "double"}
						style={{ width: "auto", padding: "0 8px" }}
					>
						双栏
					</button>
				</div>
				<span className="toolbar-muted" style={{ marginLeft: 8 }}>
					方向键翻页 · 选中文本提问
				</span>
				{toc.length > 0 && (
					<select
						onChange={(e) => renditionRef.current?.display(e.target.value)}
						style={{ marginLeft: "auto", maxWidth: 180 }}
						aria-label="目录"
					>
						<option value="">目录</option>
						{toc.map((t) => (
							<option key={t.href} value={t.href}>
								{t.label}
							</option>
						))}
					</select>
				)}
			</div>
			<div ref={ref} style={{ flex: 1, overflow: "hidden", background: "#fff", minHeight: 0, minWidth: 0, maxWidth: "100%" }} />
		</div>
	);
}
