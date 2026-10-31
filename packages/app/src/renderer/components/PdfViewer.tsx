import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { type Annotation } from "./AnnotationLayer.tsx";
import { PdfPage, type RectSelectKind } from "./PdfPage.tsx";
import { Icon } from "./Icons.tsx";
import { ocrCanvas } from "../ocr.ts";
import { loadPdfLocation, savePdfLocation, saveReadingPage } from "../reading.ts";
import type { OutlineItem } from "../types.ts";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const STAGE_PAD = 24;
const TOP_GAP = 12;
const ACTIVE_MARGIN = 900;
const VIEW_KEY = "pdfViewer.viewMode";
const ZOOM_MODE_KEY = "pdfViewer.zoomMode";
const ZOOM_SCALE_KEY = "pdfViewer.scale";
const LEGACY_SCALE_KEY = "pdfViewer.scaleMode";

type ViewMode = "continuous" | "paged";
type ZoomMode = "fit-width" | "fit-page" | "custom";
type PageSize = { width: number; height: number };
type ZoomState = { mode: ZoomMode; scale: number };
type PageAnchor = { kind: "page"; page: number; ratio: number };
type PointAnchor = { kind: "point"; page: number; x: number; y: number; clientX: number; clientY: number };
type Anchor = PageAnchor | PointAnchor;

type SelectionRect = { left: number; top: number; width: number; height: number };
type SelectionOverlayHandle = {
	setRects: (rects: SelectionRect[]) => void;
	clear: () => void;
};

type SelectionMenu = {
	text: string;
	page: number;
	rect: Annotation["rect"];
	/** Per-line boxes, so a multi-line highlight isn't one huge rectangle. */
	rects: Annotation["rect"][];
	/** Coordinates relative to the editor area (the menu's positioning context). */
	x: number;
	y: number;
	below: boolean;
};

type Props = {
	docId: string;
	page?: number;
	onPageChange?: (page: number) => void;
	onTextSelected: (text: string, page: number, rect?: Annotation["rect"]) => void;
	onRectSelect?: (text: string, page: number, kind: RectSelectKind) => void;
	annotations?: Annotation[];
	onAnnotationCreate?: (a: Annotation) => void;
	onAnnotationUpdate?: (id: string, patch: Partial<Annotation>) => void;
	onAnnotationDelete?: (id: string) => void;
	ocrLang?: string;
	onZoomChange?: (scale: number) => void;
	onOcrJob?: (job: { running: boolean; page: number; total: number; progress: number } | null) => void;
	onTotalChange?: (total: number) => void;
	/** Flattened PDF bookmarks, reported to the shell's outline view. */
	onOutlineChange?: (items: OutlineItem[]) => void;
	onOpenOutline?: () => void;
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const clampScale = (n: number) => clamp(n, MIN_SCALE, MAX_SCALE);

function readViewMode(): ViewMode {
	try {
		return localStorage.getItem(VIEW_KEY) === "paged" ? "paged" : "continuous";
	} catch {
		return "continuous";
	}
}

function readZoom(): ZoomState {
	const fit = (mode: ZoomMode): ZoomState => ({ mode, scale: 1 });
	try {
		const mode = localStorage.getItem(ZOOM_MODE_KEY);
		if (mode === "fit-width" || mode === "fit-page") return fit(mode);
		if (mode === "custom") {
			const n = Number(localStorage.getItem(ZOOM_SCALE_KEY));
			return { mode: "custom", scale: clampScale(Number.isFinite(n) && n > 0 ? n : 1) };
		}
		// Migrate the pre-continuous-scroll preference.
		const legacy = localStorage.getItem(LEGACY_SCALE_KEY);
		if (legacy === "fit-width") return fit("fit-width");
		if (legacy) {
			const n = Number(legacy);
			if (Number.isFinite(n) && n > 0) return { mode: "custom", scale: clampScale(n) };
		}
	} catch {
		// storage can be unavailable; fall back to fit-width
	}
	return fit("fit-width");
}

function saveViewMode(mode: ViewMode) {
	try {
		localStorage.setItem(VIEW_KEY, mode);
	} catch {}
}

function saveZoom(zoom: ZoomState) {
	try {
		localStorage.setItem(ZOOM_MODE_KEY, zoom.mode);
		if (zoom.mode === "custom") localStorage.setItem(ZOOM_SCALE_KEY, String(zoom.scale));
	} catch {}
}

/** Scale for fit-width / fit-page given the visible stage box. */
function fitScale(base: PageSize, stage: HTMLElement, mode: ZoomMode): number {
	const availW = Math.max(80, stage.clientWidth - STAGE_PAD * 2);
	const availH = Math.max(80, stage.clientHeight - STAGE_PAD * 2);
	if (mode === "fit-page") return clampScale(Math.min(availW / base.width, availH / base.height));
	return clampScale(availW / base.width);
}

/**
 * True when a key event belongs to some other surface (chat composer, search
 * box, settings modal, sidebar list). The old viewer only skipped <input>, so
 * pressing Space in the AI textarea flipped the PDF page and swallowed the
 * space — the single most annoying bug in the old reader.
 */
function ignoreReaderKey(e: KeyboardEvent): boolean {
	const target = e.target as HTMLElement | null;
	if (target && typeof target.closest === "function") {
		if (target.closest(".modal-backdrop, .sidebar, .secondary")) return true;
		if (target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']")) return true;
		if (e.key === " " && target.closest("button, a, [role='button'], [role='menuitem'], [role='option']")) return true;
	}
	return Boolean(document.querySelector(".modal-backdrop"));
}

/** Flatten PDF bookmarks into the shell's outline model, resolving names to pages. */
async function buildOutline(doc: pdfjs.PDFDocumentProxy): Promise<OutlineItem[]> {
	let raw: Awaited<ReturnType<pdfjs.PDFDocumentProxy["getOutline"]>>;
	try {
		raw = await doc.getOutline();
	} catch {
		return [];
	}
	if (!raw?.length) return [];

	const items: OutlineItem[] = [];
	const resolvePage = async (dest: unknown): Promise<number | null> => {
		try {
			let target = dest;
			if (typeof target === "string") target = await doc.getDestination(target);
			if (!Array.isArray(target) || target.length === 0) return null;
			const ref = target[0];
			if (typeof ref === "number") return ref + 1;
			if (ref && typeof ref === "object") return (await doc.getPageIndex(ref as never)) + 1;
		} catch {}
		return null;
	};
	const walk = async (nodes: NonNullable<typeof raw>, depth: number) => {
		for (const node of nodes) {
			const title = String(node.title ?? "").trim() || "（未命名）";
			const page = await resolvePage(node.dest);
			items.push({ title, page: page && page >= 1 && page <= doc.numPages ? page : null, depth });
			if (items.length >= 2000) return;
			if (node.items?.length) await walk(node.items, depth + 1);
		}
	};
	await walk(raw, 0);
	return items;
}

export function PdfViewer({
	docId,
	page: externalPage,
	onPageChange,
	onTextSelected,
	onRectSelect,
	annotations = [],
	onAnnotationCreate,
	onAnnotationUpdate,
	onAnnotationDelete,
	ocrLang = "chi_sim+eng",
	onZoomChange,
	onOcrJob,
	onTotalChange,
	onOutlineChange,
	onOpenOutline,
}: Props) {
	const areaRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	const pagesContentRef = useRef<HTMLDivElement>(null);
	const selectionOverlayRef = useRef<SelectionOverlayHandle>(null);
	const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [total, setTotal] = useState(0);
	const totalRef = useRef(0);
	const [pageNum, setPageNum] = useState(Math.max(1, externalPage ?? 1));
	const pageNumRef = useRef(pageNum);
	const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
	const viewModeRef = useRef(viewMode);
	const [zoom, setZoom] = useState<ZoomState>(readZoom);
	const zoomRef = useRef(zoom);
	const [scale, setScale] = useState(() => (zoom.mode === "custom" ? zoom.scale : 1));
	const scaleRef = useRef(scale);
	const [baseSize, setBaseSize] = useState<PageSize | null>(null);
	const baseSizeRef = useRef<PageSize | null>(null);
	const sizesRef = useRef<Map<number, PageSize>>(new Map());
	const [sizeVersion, bumpSizes] = useReducer((x: number) => x + 1, 0);
	const [activePages, setActivePages] = useState<Set<number>>(() => new Set());
	const activeRef = useRef<Set<number>>(new Set());
	const visibleRef = useRef<Set<number>>(new Set());
	const pageElsRef = useRef<Map<number, HTMLElement>>(new Map());
	const [outline, setOutline] = useState<OutlineItem[]>([]);
	const [scanned, setScanned] = useState(false);
	const [dpr, setDpr] = useState(() => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1));
	const [ocrJob, setOcrJob] = useState<{ running: boolean; page: number; total: number; progress: number; status: string } | null>(null);
	const cancelOcr = useRef(false);
	const [selectionMenu, setSelectionMenu] = useState<SelectionMenu | null>(null);
	const [activeAnnId, setActiveAnnId] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [ocrMenuOpen, setOcrMenuOpen] = useState(false);
	const ocrMenuRef = useRef<HTMLSpanElement>(null);

	const restoreRef = useRef<{ page: number; offset: number } | null>(null);
	const initializedRef = useRef(false);
	const pendingAnchorRef = useRef<Anchor | null>(null);
	const modeJumpRef = useRef(false);
	const scrollRafRef = useRef(0);
	const saveTimerRef = useRef<number | undefined>(undefined);
	const offsetRef = useRef(0);
	const lastApiPageRef = useRef(0);

	// Latest callbacks without making them effect dependencies (the document
	// must not reload just because App re-rendered).
	const pageCb = useRef(onPageChange);
	pageCb.current = onPageChange;
	const totalCb = useRef(onTotalChange);
	totalCb.current = onTotalChange;
	const zoomCb = useRef(onZoomChange);
	zoomCb.current = onZoomChange;
	const ocrCb = useRef(onOcrJob);
	ocrCb.current = onOcrJob;
	const outlineCb = useRef(onOutlineChange);
	outlineCb.current = onOutlineChange;
	const initialPageRef = useRef(externalPage);

	pageNumRef.current = pageNum;
	viewModeRef.current = viewMode;
	zoomRef.current = zoom;
	scaleRef.current = scale;
	baseSizeRef.current = baseSize;

	const getPageEl = useCallback((n: number): HTMLElement | null => {
		const known = pageElsRef.current.get(n);
		if (known?.isConnected) return known;
		return stageRef.current?.querySelector<HTMLElement>(`.pdf-shell[data-page="${n}"]`) ?? null;
	}, []);

	const sizeOf = useCallback(
		(n: number): PageSize => sizesRef.current.get(n) ?? baseSizeRef.current ?? { width: 612, height: 792 },
		[],
	);

	/**
	 * Repaint the selection ourselves instead of relying on the browser's
	 * per-span ::selection paint. CJK PDFs have overlapping/split text-layer
	 * spans, so the native highlight shows uneven alpha and ragged blocks.
	 * We merge the range's client rects into one rounded rect per line, which
	 * also gives the selection a consistent 1px seam between lines.
	 */
	const syncSelectionOverlay = useCallback(() => {
		const stage = stageRef.current;
		const content = pagesContentRef.current;
		if (!stage || !content) return;
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
			selectionOverlayRef.current?.clear();
			return;
		}
		const range = sel.getRangeAt(0);
		if (!stage.contains(range.commonAncestorContainer)) {
			selectionOverlayRef.current?.clear();
			return;
		}
		const contentRect = content.getBoundingClientRect();
		const rects: SelectionRect[] = [];
		for (const r of Array.from(range.getClientRects())) {
			if (r.width < 1 || r.height < 1) continue;
			if (r.bottom < contentRect.top || r.top > contentRect.bottom) continue;
			const left = r.left - contentRect.left;
			const top = r.top - contentRect.top;
			const last = rects[rects.length - 1];
			const sameLine = last && Math.abs(last.top + last.height / 2 - (top + r.height / 2)) < Math.max(2, r.height * 0.4);
			const touches = last && left <= last.left + last.width + 6 && left + r.width >= last.left - 6;
			if (last && sameLine && touches) {
				const right = Math.max(last.left + last.width, left + r.width);
				const bottom = Math.max(last.top + last.height, top + r.height);
				last.left = Math.min(last.left, left);
				last.top = Math.min(last.top, top);
				last.width = right - last.left;
				last.height = bottom - last.top;
			} else {
				rects.push({ left, top, width: r.width, height: r.height });
			}
		}
		for (const rect of rects) {
			rect.top += 1;
			rect.height = Math.max(2, rect.height - 2);
		}
		selectionOverlayRef.current?.setRects(rects);
	}, []);

	const reportPageSize = useCallback((n: number, size: PageSize) => {
		const prev = sizesRef.current.get(n);
		if (prev && Math.abs(prev.width - size.width) < 0.01 && Math.abs(prev.height - size.height) < 0.01) return;
		sizesRef.current.set(n, size);
		bumpSizes();
	}, []);

	// ---------------------------------------------------------------- position

	const savePosition = useCallback(() => {
		savePdfLocation(docId, { page: pageNumRef.current, offset: offsetRef.current });
		if (lastApiPageRef.current !== pageNumRef.current) {
			lastApiPageRef.current = pageNumRef.current;
			window.api.saveReading?.(docId, { page: pageNumRef.current }).catch(() => {});
		}
	}, [docId]);

	const scheduleSave = useCallback(() => {
		if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current);
		saveTimerRef.current = window.setTimeout(() => {
			saveTimerRef.current = undefined;
			savePosition();
		}, 350);
	}, [savePosition]);

	const commitPage = useCallback(
		(n: number) => {
			const max = totalRef.current || n;
			const next = clamp(n, 1, max);
			if (next === pageNumRef.current) return;
			pageNumRef.current = next;
			setPageNum(next);
			pageCb.current?.(next);
			saveReadingPage(docId, next);
			offsetRef.current = 0;
			scheduleSave();
		},
		[docId, scheduleSave],
	);

	const capturePageAnchor = useCallback((): PageAnchor | null => {
		const stage = stageRef.current;
		const el = getPageEl(pageNumRef.current);
		if (!stage || !el) return null;
		const sr = stage.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		return {
			kind: "page",
			page: pageNumRef.current,
			ratio: clamp((sr.top - r.top) / Math.max(1, r.height), 0, 1),
		};
	}, [getPageEl]);

	const capturePointAnchor = useCallback(
		(clientX: number, clientY: number): Anchor | null => {
			const shell = (document.elementFromPoint(clientX, clientY)?.closest?.(".pdf-shell") as HTMLElement | null) ?? null;
			if (!shell) return capturePageAnchor();
			const r = shell.getBoundingClientRect();
			return {
				kind: "point",
				page: Number(shell.dataset.page),
				x: clamp((clientX - r.left) / Math.max(1, r.width), 0, 1),
				y: clamp((clientY - r.top) / Math.max(1, r.height), 0, 1),
				clientX,
				clientY,
			};
		},
		[capturePageAnchor],
	);

	const applyAnchor = useCallback(
		(a: Anchor) => {
			const stage = stageRef.current;
			const el = getPageEl(a.page);
			if (!stage || !el) return;
			const sr = stage.getBoundingClientRect();
			const r = el.getBoundingClientRect();
			if (a.kind === "page") {
				stage.scrollTop = Math.max(0, stage.scrollTop + (r.top - sr.top) + a.ratio * r.height - TOP_GAP);
				return;
			}
			stage.scrollLeft = Math.max(0, stage.scrollLeft + (r.left - sr.left) + a.x * r.width - (a.clientX - sr.left));
			stage.scrollTop = Math.max(0, stage.scrollTop + (r.top - sr.top) + a.y * r.height - (a.clientY - sr.top));
		},
		[getPageEl],
	);

	const jumpToPage = useCallback(
		(n: number, smooth = false) => {
			const target = clamp(n, 1, totalRef.current || n);
			const stage = stageRef.current;
			if (stage && viewModeRef.current === "continuous") {
				const el = getPageEl(target);
				if (el) {
					const sr = stage.getBoundingClientRect();
					const r = el.getBoundingClientRect();
					const top = stage.scrollTop + (r.top - sr.top) - TOP_GAP;
					// When zoomed past the viewport, keep the target page centred
					// horizontally instead of dumping the reader at its left margin.
					const left = stage.scrollLeft + (r.left - sr.left) - Math.max(0, (stage.clientWidth - r.width) / 2);
					stage.scrollTo({ top: Math.max(0, top), left: Math.max(0, left), behavior: smooth ? "smooth" : "auto" });
				}
			} else if (stage) {
				stage.scrollTop = 0;
				stage.scrollLeft = 0;
			}
			offsetRef.current = 0;
			pageNumRef.current = target;
			setPageNum(target);
			pageCb.current?.(target);
			saveReadingPage(docId, target);
			scheduleSave();
		},
		[docId, getPageEl, scheduleSave],
	);

	const updatePageFromScroll = useCallback(() => {
		if (viewModeRef.current !== "continuous") return;
		const stage = stageRef.current;
		if (!stage) return;
		const sr = stage.getBoundingClientRect();
		let best: { n: number; area: number; rect: DOMRect } | null = null;
		for (const n of visibleRef.current) {
			const el = pageElsRef.current.get(n);
			if (!el) continue;
			const r = el.getBoundingClientRect();
			const overlap = Math.min(r.bottom, sr.bottom) - Math.max(r.top, sr.top);
			if (overlap > 0 && (!best || overlap > best.area)) best = { n, area: overlap, rect: r };
		}
		if (!best) {
			const shell = document.elementFromPoint(sr.left + sr.width / 2, sr.top + 40)?.closest?.(".pdf-shell") as HTMLElement | null;
			const n = shell ? Number(shell.dataset.page) : 0;
			if (n) commitPage(n);
			return;
		}
		offsetRef.current = clamp((sr.top - best.rect.top) / Math.max(1, best.rect.height), 0, 1);
		commitPage(best.n);
		scheduleSave();
	}, [commitPage, scheduleSave]);

	const handleScroll = useCallback(() => {
		if (scrollRafRef.current) return;
		scrollRafRef.current = requestAnimationFrame(() => {
			scrollRafRef.current = 0;
			updatePageFromScroll();
		});
	}, [updatePageFromScroll]);

	// ------------------------------------------------------------------ zoom

	const recomputeScale = useCallback(() => {
		const stage = stageRef.current;
		const base = baseSizeRef.current;
		if (!stage || !base) return;
		const mode = zoomRef.current.mode;
		if (mode === "custom") {
			const next = clampScale(zoomRef.current.scale);
			if (Math.abs(scaleRef.current - next) < 0.001) return;
			if (viewModeRef.current === "continuous") pendingAnchorRef.current = capturePageAnchor();
			scaleRef.current = next;
			setScale(next);
			return;
		}
		// Paged mode fits the page that is actually on screen; continuous mode
		// uses page 1 so the column width doesn't wobble while skipping pages.
		const size = viewModeRef.current === "paged" ? sizeOf(pageNumRef.current) : base;
		const next = fitScale(size, stage, mode);
		if (Math.abs(scaleRef.current - next) < 0.005) return;
		if (viewModeRef.current === "continuous") pendingAnchorRef.current = capturePageAnchor();
		scaleRef.current = next;
		setScale(next);
	}, [capturePageAnchor, sizeOf]);

	const applyCustomScale = useCallback(
		(next: number, anchor?: Anchor | null) => {
			const value = clampScale(next);
			if (zoomRef.current.mode === "custom" && Math.abs(zoomRef.current.scale - value) < 0.001) return;
			if (viewModeRef.current === "continuous") pendingAnchorRef.current = anchor ?? capturePageAnchor();
			const z: ZoomState = { mode: "custom", scale: value };
			zoomRef.current = z;
			setZoom(z);
			saveZoom(z);
			scaleRef.current = value;
			setScale(value);
		},
		[capturePageAnchor],
	);

	const applyFit = useCallback(
		(mode: Exclude<ZoomMode, "custom">) => {
			if (zoomRef.current.mode === mode) {
				recomputeScale();
				return;
			}
			if (viewModeRef.current === "continuous") pendingAnchorRef.current = capturePageAnchor();
			const z: ZoomState = { ...zoomRef.current, mode };
			zoomRef.current = z;
			setZoom(z);
			saveZoom(z);
			recomputeScale();
		},
		[capturePageAnchor, recomputeScale],
	);

	// OCR is a secondary action; keeping it in a popover keeps the reading
	// toolbar on one row even with both sidebars open.
	useEffect(() => {
		if (!ocrMenuOpen) return;
		const onDoc = (e: MouseEvent) => {
			if (ocrMenuRef.current && !ocrMenuRef.current.contains(e.target as Node)) setOcrMenuOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOcrMenuOpen(false);
		};
		document.addEventListener("mousedown", onDoc);
		window.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDoc);
			window.removeEventListener("keydown", onKey);
		};
	}, [ocrMenuOpen]);

	const applyViewMode = useCallback(
		(mode: ViewMode) => {
			if (mode === viewModeRef.current) return;
			modeJumpRef.current = true;
			pendingAnchorRef.current = null;
			viewModeRef.current = mode;
			setViewMode(mode);
			saveViewMode(mode);
		},
		[],
	);

	useLayoutEffect(() => {
		const a = pendingAnchorRef.current;
		if (!a) return;
		pendingAnchorRef.current = null;
		applyAnchor(a);
	}, [scale, applyAnchor]);

	// Recompute when fit mode, the stage size, or a page measurement changes.
	useEffect(() => {
		recomputeScale();
	}, [recomputeScale, viewMode, zoom, baseSize, pageNum, sizeVersion]);

	useEffect(() => {
		const stage = stageRef.current;
		if (!stage) return;
		let raf = 0;
		const ro = new ResizeObserver(() => {
			if (raf) cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				raf = 0;
				recomputeScale();
			});
		});
		ro.observe(stage);
		return () => {
			ro.disconnect();
			if (raf) cancelAnimationFrame(raf);
		};
	}, [recomputeScale]);

	// Zoom with Ctrl/⌘ + wheel, anchored at the pointer.
	useEffect(() => {
		const stage = stageRef.current;
		if (!stage) return;
		const onWheel = (e: WheelEvent) => {
			if (!(e.ctrlKey || e.metaKey)) return;
			e.preventDefault();
			const anchor = capturePointAnchor(e.clientX, e.clientY);
			applyCustomScale(scaleRef.current * Math.exp(-e.deltaY * 0.0015), anchor);
		};
		stage.addEventListener("wheel", onWheel, { passive: false });
		return () => stage.removeEventListener("wheel", onWheel);
	}, [applyCustomScale, capturePointAnchor]);

	// ------------------------------------------------------- document loading

	useEffect(() => {
		let cancelled = false;
		let loadingTask: pdfjs.PDFDocumentLoadingTask | null = null;
		setLoading(true);
		setLoadError(null);
		setPdf(null);
		setTotal(0);
		totalRef.current = 0;
		setBaseSize(null);
		baseSizeRef.current = null;
		sizesRef.current.clear();
		pageElsRef.current.clear();
		activeRef.current = new Set();
		visibleRef.current = new Set();
		setActivePages(new Set());
		setOutline([]);
		outlineCb.current?.([]);
		setSelectionMenu(null);
		restoreRef.current = null;
		initializedRef.current = false;
		lastApiPageRef.current = 0;

		(async () => {
			try {
				const path = await window.api.getDocPath(docId);
				if (!path) throw new Error("找不到该文档的原始文件");
				const data = await window.api.readFile?.(path);
				if (cancelled) return;
				loadingTask = data ? pdfjs.getDocument({ data }) : pdfjs.getDocument(path);
				const doc = await loadingTask.promise;
				if (cancelled) return;

				const firstPage = await doc.getPage(1);
				if (cancelled) return;
				const vp = firstPage.getViewport({ scale: 1 });
				const base = { width: vp.width, height: vp.height };
				const count = doc.numPages;
				let saved = loadPdfLocation(docId);
				if (!saved) {
					// Fall back to doc.json's lastPage (e.g. localStorage was cleared).
					const stored = await Promise.resolve(window.api.getReading?.(docId)).catch(() => null);
					if (cancelled) return;
					if (typeof stored?.page === "number" && stored.page >= 1) saved = { page: stored.page, offset: 0 };
				}
				const restorePage = clamp(saved?.page ?? initialPageRef.current ?? 1, 1, count);
				// Fit-page shows the whole page, so a mid-page offset from a
				// previous fit-width session would start the view above the page top.
				const restoreOffset = zoomRef.current.mode === "fit-page" ? 0 : (saved?.offset ?? 0);

				sizesRef.current.set(1, base);
				baseSizeRef.current = base;
				totalRef.current = count;
				pageNumRef.current = restorePage;
				offsetRef.current = restoreOffset;
				restoreRef.current = { page: restorePage, offset: restoreOffset };

				const stage = stageRef.current;
				const mode = zoomRef.current;
				const initialScale = stage
					? mode.mode === "custom"
						? clampScale(mode.scale)
						: fitScale(base, stage, mode.mode)
					: 1;
				scaleRef.current = initialScale;

				setBaseSize(base);
				setTotal(count);
				setPageNum(restorePage);
				setScale(initialScale);
				setPdf(doc);
				setLoading(false);
				totalCb.current?.(count);
				pageCb.current?.(restorePage);
				saveReadingPage(docId, restorePage);

				buildOutline(doc)
					.then((items) => {
						if (cancelled) return;
						setOutline(items);
						outlineCb.current?.(items);
					})
					.catch(() => {});
			} catch (e) {
				if (cancelled) return;
				console.error("[pdf] load failed", e);
				setLoadError(e instanceof Error ? e.message : String(e));
				setLoading(false);
				totalCb.current?.(0);
			}
		})();

		return () => {
			cancelled = true;
			if (saveTimerRef.current !== undefined) {
				window.clearTimeout(saveTimerRef.current);
				saveTimerRef.current = undefined;
			}
			// Flush the last position even if the user closes the tab immediately.
			if (pageNumRef.current > 0) savePdfLocation(docId, { page: pageNumRef.current, offset: offsetRef.current });
			loadingTask?.destroy().catch(() => {});
		};
	}, [docId]);

	// Restore the exact reading position once the page shells are laid out.
	useLayoutEffect(() => {
		const saved = restoreRef.current;
		if (!saved || !pdf || total === 0) return;
		restoreRef.current = null;
		const stage = stageRef.current;
		if (stage) {
			if (viewModeRef.current === "continuous") {
				const el = getPageEl(saved.page);
				if (el) {
					const sr = stage.getBoundingClientRect();
					const r = el.getBoundingClientRect();
					const pageTop = stage.scrollTop + (r.top - sr.top);
					// Mid-page positions restore exactly from the stage top; a page
					// start keeps a small gap above the sheet instead of butting
					// against the toolbar.
					const top = pageTop + (saved.offset > 0 ? saved.offset * r.height : -STAGE_PAD);
					stage.scrollTop = Math.max(0, top);
					stage.scrollLeft = Math.max(0, stage.scrollLeft + (r.left - sr.left) - Math.max(0, (stage.clientWidth - r.width) / 2));
				}
			} else {
				stage.scrollTop = 0;
				stage.scrollLeft = 0;
			}
		}
		initializedRef.current = true;
		pageNumRef.current = saved.page;
		setPageNum(saved.page);
		pageCb.current?.(saved.page);
	}, [pdf, total, getPageEl]);

	// Index the page shells so anchoring/jumping has stable DOM references.
	useLayoutEffect(() => {
		const stage = stageRef.current;
		if (!stage) return;
		const map = new Map<number, HTMLElement>();
		stage.querySelectorAll<HTMLElement>(".pdf-shell[data-page]").forEach((el) => {
			map.set(Number(el.dataset.page), el);
		});
		pageElsRef.current = map;
	}, [pdf, total, viewMode]);

	// Switch between continuous and paged without losing the current page.
	useLayoutEffect(() => {
		if (!modeJumpRef.current) return;
		modeJumpRef.current = false;
		if (viewMode === "continuous") {
			jumpToPage(pageNumRef.current);
		} else {
			const stage = stageRef.current;
			if (stage) {
				stage.scrollTop = 0;
				stage.scrollLeft = 0;
			}
		}
	}, [viewMode, jumpToPage]);

	// Paged mode opens each page at its top-left, never midway down the page.
	useLayoutEffect(() => {
		if (viewMode !== "paged") return;
		const stage = stageRef.current;
		if (stage) {
			stage.scrollTop = 0;
			stage.scrollLeft = 0;
		}
	}, [pageNum, viewMode]);

	// Track which pages are on screen (for page numbering) and which are near
	// enough to render (active window).
	useEffect(() => {
		if (!pdf || total === 0 || viewMode !== "continuous") return;
		const stage = stageRef.current;
		if (!stage) return;
		activeRef.current = new Set([pageNumRef.current]);
		visibleRef.current = new Set();
		setActivePages(new Set(activeRef.current));

		const activeIo = new IntersectionObserver(
			(entries) => {
				let changed = false;
				for (const entry of entries) {
					const n = Number((entry.target as HTMLElement).dataset.page);
					if (!Number.isFinite(n)) continue;
					if (entry.isIntersecting) {
						if (!activeRef.current.has(n)) {
							activeRef.current.add(n);
							changed = true;
						}
					} else if (activeRef.current.delete(n)) {
						changed = true;
					}
				}
				if (changed) setActivePages(new Set(activeRef.current));
			},
			{ root: stage, rootMargin: `${ACTIVE_MARGIN}px 0px`, threshold: 0 },
		);
		const visibleIo = new IntersectionObserver(
			(entries) => {
				let changed = false;
				for (const entry of entries) {
					const n = Number((entry.target as HTMLElement).dataset.page);
					if (!Number.isFinite(n)) continue;
					if (entry.isIntersecting) {
						if (!visibleRef.current.has(n)) {
							visibleRef.current.add(n);
							changed = true;
						}
					} else if (visibleRef.current.delete(n)) {
						changed = true;
					}
				}
				if (changed) updatePageFromScroll();
			},
			{ root: stage, threshold: 0 },
		);
		stage.querySelectorAll<HTMLElement>(".pdf-shell[data-page]").forEach((el) => {
			activeIo.observe(el);
			visibleIo.observe(el);
		});
		return () => {
			activeIo.disconnect();
			visibleIo.disconnect();
		};
	}, [pdf, total, viewMode, updatePageFromScroll]);

	// Refresh the current page's exact size (mixed-size PDFs) and scanned flag.
	useEffect(() => {
		if (!pdf || total === 0) return;
		let cancelled = false;
		pdf.getPage(pageNum)
			.then((p) => {
				if (cancelled) return;
				const vp = p.getViewport({ scale: 1 });
				reportPageSize(pageNum, { width: vp.width, height: vp.height });
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [pdf, pageNum, total, reportPageSize]);

	useEffect(() => {
		if (!pdf || total === 0) return;
		let cancelled = false;
		setScanned(false);
		pdf.getPage(pageNum)
			.then((p) => p.getTextContent())
			.then((tc) => {
				if (!cancelled) setScanned(tc.items.length === 0);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [pdf, pageNum, total]);

	// Respond to page jumps from the shell (search hits, annotations, outline).
	useEffect(() => {
		if (!pdf || externalPage === undefined) return;
		if (!initializedRef.current) return;
		if (externalPage === pageNumRef.current) return;
		jumpToPage(externalPage);
	}, [externalPage, pdf, jumpToPage]);

	// Resolution changes when the window moves between displays.
	useEffect(() => {
		const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
		const onChange = () => setDpr(window.devicePixelRatio || 1);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, [dpr]);

	// ---------------------------------------------------------------- OCR

	const ocrPage = useCallback(
		async (n: number): Promise<string> => {
			if (!pdf) return "";
			const page = await pdf.getPage(n);
			const viewport = page.getViewport({ scale: 2 });
			const canvas = document.createElement("canvas");
			canvas.width = viewport.width;
			canvas.height = viewport.height;
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("无法创建画布上下文");
			await page.render({ canvas, canvasContext: ctx, viewport }).promise;
			const text = await ocrCanvas(canvas, ocrLang, undefined, (progress, status) =>
				setOcrJob((j) => (j ? { ...j, page: n, progress, status } : j)),
			);
			if (text) await window.api.saveOcr(docId, n, text);
			return text;
		},
		[pdf, ocrLang, docId],
	);

	const ocrCurrentPage = async () => {
		if (ocrJob?.running) return;
		setOcrJob({ running: true, page: pageNumRef.current, total, progress: 0, status: "启动 OCR" });
		try {
			await ocrPage(pageNumRef.current);
		} catch (e) {
			console.error("[ocr] page failed", e);
			setOcrJob({ running: false, page: pageNumRef.current, total, progress: 1, status: `OCR 失败: ${e instanceof Error ? e.message : String(e)}` });
			setTimeout(() => setOcrJob(null), 4000);
			return;
		}
		setOcrJob(null);
	};

	const ocrWholeDoc = async () => {
		if (ocrJob?.running || !pdf) return;
		cancelOcr.current = false;
		setOcrJob({ running: true, page: 1, total, progress: 0, status: "启动 OCR" });
		try {
			for (let i = 1; i <= total; i++) {
				if (cancelOcr.current) break;
				setOcrJob({ running: true, page: i, total, progress: (i - 1) / total, status: "识别中" });
				await ocrPage(i);
			}
		} catch (e) {
			console.error("[ocr] book failed", e);
		}
		setOcrJob(null);
	};

	// ------------------------------------------------------- keyboard / zoom

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (ignoreReaderKey(e)) return;
			if (e.key === "Escape") {
				setSelectionMenu(null);
				setActiveAnnId(null);
				window.getSelection()?.removeAllRanges();
				return;
			}
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			if (!pdf) return;
			const stage = stageRef.current;
			if (!stage) return;
			const pageHeight = stage.clientHeight;
			if (e.key === "+" || e.key === "=") {
				e.preventDefault();
				applyCustomScale(scaleRef.current + 0.15);
				return;
			}
			if (e.key === "-") {
				e.preventDefault();
				applyCustomScale(scaleRef.current - 0.15);
				return;
			}
			if (e.key === "0") {
				e.preventDefault();
				applyFit("fit-width");
				return;
			}
			if (e.key === "9") {
				e.preventDefault();
				applyFit("fit-page");
				return;
			}
			if (viewModeRef.current === "paged") {
				if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) {
					e.preventDefault();
					jumpToPage(pageNumRef.current + 1);
				} else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) {
					e.preventDefault();
					jumpToPage(pageNumRef.current - 1);
				} else if (e.key === "Home") {
					e.preventDefault();
					jumpToPage(1);
				} else if (e.key === "End") {
					e.preventDefault();
					jumpToPage(totalRef.current);
				}
				return;
			}
			// Continuous mode: let the keys scroll like a document reader.
			if (e.key === "ArrowDown") {
				e.preventDefault();
				stage.scrollBy({ top: 84, behavior: "auto" });
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				stage.scrollBy({ top: -84, behavior: "auto" });
			} else if (e.key === " " || e.key === "PageDown") {
				e.preventDefault();
				const dir = e.key === " " && e.shiftKey ? -1 : 1;
				stage.scrollBy({ top: dir * pageHeight * 0.9, behavior: "auto" });
			} else if (e.key === "PageUp") {
				e.preventDefault();
				stage.scrollBy({ top: -pageHeight * 0.9, behavior: "auto" });
			} else if (e.key === "Home") {
				e.preventDefault();
				stage.scrollTop = 0;
			} else if (e.key === "End") {
				e.preventDefault();
				stage.scrollTop = stage.scrollHeight;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [pdf, applyCustomScale, applyFit, jumpToPage]);

	// -------------------------------------------------------- text selection

	/** Read the current DOM selection and place the highlight/quote bubble. */
	const showSelectionMenu = useCallback(() => {
		const stage = stageRef.current;
		if (!stage) return;
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
			setSelectionMenu(null);
			return;
		}
		const text = sel.toString().trim();
		if (!text) {
			setSelectionMenu(null);
			return;
		}
		let shell: HTMLElement | null = null;
		let rects: DOMRect[] = [];
		try {
			const range = sel.getRangeAt(0);
			const node = range.commonAncestorContainer;
			const el = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement) as Element | null;
			shell = (el?.closest?.(".pdf-shell") as HTMLElement | null) ?? null;
			rects = Array.from(range.getClientRects());
		} catch {
			return;
		}
		if (!shell || !stage.contains(shell)) {
			setSelectionMenu(null);
			return;
		}
		const pageNumber = Number(shell.dataset.page);
		const shellRect = shell.getBoundingClientRect();
		// Merge the range's client rects into one box per line. The union still
		// positions the bubble/OCR box; `lines` becomes the highlight geometry.
		const lines: { left: number; top: number; right: number; bottom: number }[] = [];
		for (const r of rects) {
			if (r.width < 1 || r.height < 1) continue;
			if (r.right < shellRect.left || r.left > shellRect.right || r.bottom < shellRect.top || r.top > shellRect.bottom) continue;
			const box = {
				left: Math.max(r.left, shellRect.left),
				top: Math.max(r.top, shellRect.top),
				right: Math.min(r.right, shellRect.right),
				bottom: Math.min(r.bottom, shellRect.bottom),
			};
			if (box.right <= box.left || box.bottom <= box.top) continue;
			const last = lines[lines.length - 1];
			const sameLine = last && Math.abs((last.top + last.bottom) / 2 - (box.top + box.bottom) / 2) < Math.max(3, (box.bottom - box.top) * 0.5);
			const touches = last && box.left <= last.right + 8 && box.right >= last.left - 8;
			if (last && sameLine && touches) {
				last.left = Math.min(last.left, box.left);
				last.top = Math.min(last.top, box.top);
				last.right = Math.max(last.right, box.right);
				last.bottom = Math.max(last.bottom, box.bottom);
			} else {
				lines.push(box);
			}
		}
		if (lines.length === 0) {
			setSelectionMenu(null);
			return;
		}
		const left = Math.min(...lines.map((l) => l.left));
		const top = Math.min(...lines.map((l) => l.top));
		const right = Math.max(...lines.map((l) => l.right));
		const bottom = Math.max(...lines.map((l) => l.bottom));
		const area = areaRef.current?.getBoundingClientRect();
		const localTop = top - (area?.top ?? 0);
		const localCenter = left + (right - left) / 2 - (area?.left ?? 0);
		const areaWidth = area?.width ?? 600;
		setActiveAnnId(null);
		setCopied(false);
		setSelectionMenu({
			text,
			page: pageNumber,
			rect: {
				x: (left - shellRect.left) / Math.max(1, shellRect.width),
				y: (top - shellRect.top) / Math.max(1, shellRect.height),
				w: (right - left) / Math.max(1, shellRect.width),
				h: (bottom - top) / Math.max(1, shellRect.height),
			},
			rects: lines.map((l) => ({
				x: (l.left - shellRect.left) / Math.max(1, shellRect.width),
				y: (l.top - shellRect.top) / Math.max(1, shellRect.height),
				w: (l.right - l.left) / Math.max(1, shellRect.width),
				h: (l.bottom - l.top) / Math.max(1, shellRect.height),
			})),
			x: clamp(localCenter, 110, Math.max(110, areaWidth - 110)),
			y: localTop,
			below: localTop < 90,
		});
	}, []);

	useEffect(() => {
		const stage = stageRef.current;
		if (!stage) return;
		const onUp = (e: MouseEvent) => {
			if (e.button !== 0 || e.altKey || e.metaKey || e.ctrlKey) return;
			const target = e.target as HTMLElement | null;
			if (target?.closest?.("[data-ann], [data-toolbar], button, input, textarea, select, .pdf-sel-menu")) return;
			// Let the browser settle the selection first (double-click / drag).
			window.setTimeout(showSelectionMenu, 0);
		};
		stage.addEventListener("mouseup", onUp);
		return () => stage.removeEventListener("mouseup", onUp);
	}, [showSelectionMenu]);

	// A double-click selects a whole paragraph in the page; refresh the bubble
	// with that new range instead of the word the browser picked.
	const handleParagraphSelected = useCallback(() => {
		window.setTimeout(showSelectionMenu, 0);
	}, [showSelectionMenu]);

	// Keep the custom selection overlay in sync while dragging / extending.
	useEffect(() => {
		if (!pdf) return;
		let raf = 0;
		const schedule = () => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				syncSelectionOverlay();
			});
		};
		document.addEventListener("selectionchange", schedule);
		document.addEventListener("mouseup", schedule);
		window.addEventListener("resize", schedule);
		return () => {
			document.removeEventListener("selectionchange", schedule);
			document.removeEventListener("mouseup", schedule);
			window.removeEventListener("resize", schedule);
			if (raf) cancelAnimationFrame(raf);
			selectionOverlayRef.current?.clear();
		};
	}, [pdf, syncSelectionOverlay]);

	// A re-render at a new scale invalidates the old client rects.
	useEffect(() => {
		selectionOverlayRef.current?.clear();
	}, [scale, viewMode]);

	// Dismiss the selection bubble when clicking elsewhere or scrolling.
	useEffect(() => {
		if (!selectionMenu) return;
		const onDown = (e: MouseEvent) => {
			if ((e.target as HTMLElement | null)?.closest?.(".pdf-sel-menu")) return;
			setSelectionMenu(null);
		};
		const onScroll = () => setSelectionMenu(null);
		document.addEventListener("mousedown", onDown);
		const stage = stageRef.current;
		stage?.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			document.removeEventListener("mousedown", onDown);
			stage?.removeEventListener("scroll", onScroll);
		};
	}, [selectionMenu]);

	useEffect(() => {
		setSelectionMenu(null);
		setActiveAnnId(null);
		setCopied(false);
	}, [pageNum, viewMode]);

	useEffect(() => {
		if (!copied) return;
		const t = window.setTimeout(() => setCopied(false), 1200);
		return () => window.clearTimeout(t);
	}, [copied]);

	const createHighlight = () => {
		if (!selectionMenu || !onAnnotationCreate) return;
		onAnnotationCreate({
			id: crypto.randomUUID(),
			page: selectionMenu.page,
			type: "highlight",
			rect: selectionMenu.rect,
			rects: selectionMenu.rects.length > 1 ? selectionMenu.rects : undefined,
			text: selectionMenu.text,
			color: "#ffeb3b61",
		});
		window.getSelection()?.removeAllRanges();
		setSelectionMenu(null);
	};

	const quoteSelection = () => {
		if (!selectionMenu) return;
		onTextSelected(selectionMenu.text, selectionMenu.page, selectionMenu.rect);
		window.getSelection()?.removeAllRanges();
		setSelectionMenu(null);
	};

	const copySelection = async () => {
		if (!selectionMenu) return;
		const target = selectionMenu;
		try {
			await navigator.clipboard.writeText(selectionMenu.text);
			setCopied(true);
		} catch (e) {
			console.error("[pdf] copy failed", e);
		}
		window.getSelection()?.removeAllRanges();
		window.setTimeout(() => {
			setCopied(false);
			setSelectionMenu((m) => (m === target ? null : m));
		}, 900);
	};

	// ------------------------------------------------------------- reporting

	useEffect(() => {
		zoomCb.current?.(scale);
	}, [scale]);
	useEffect(() => {
		totalCb.current?.(total);
	}, [total]);
	useEffect(() => {
		ocrCb.current?.(ocrJob ? { running: ocrJob.running, page: ocrJob.page, total: ocrJob.total, progress: ocrJob.progress } : null);
	}, [ocrJob]);
	// Clear the status bar's OCR indicator when the reader is closed/switched.
	useEffect(() => () => { ocrCb.current?.(null); }, []);

	// ---------------------------------------------------------------- render

	const activeAnn = annotations.find((a) => a.id === activeAnnId) ?? null;

	// Close the highlight bar when its annotation disappears or the user clicks
	// elsewhere. The EPUB viewer uses the same interaction model.
	useEffect(() => {
		if (activeAnnId && !annotations.some((a) => a.id === activeAnnId)) setActiveAnnId(null);
	}, [annotations, activeAnnId]);

	useEffect(() => {
		if (!activeAnnId) return;
		const onDown = (e: MouseEvent) => {
			const t = e.target as HTMLElement | null;
			if (t?.closest?.("[data-ann], [data-toolbar], .reader-ann-bar, .pdf-sel-menu")) return;
			setActiveAnnId(null);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [activeAnnId]);

	const pageList = useMemo(() => Array.from({ length: total }, (_, i) => i + 1), [total]);
	const zoomLabel = `${Math.round(scale * 100)}%`;
	const progress = total > 1 ? ((clamp(pageNum, 1, total) - 1) / (total - 1)) * 100 : 0;

	const renderPdfPage = (n: number, size: PageSize, active: boolean, isCurrent: boolean) => (
		<div
			key={n}
			className="pdf-shell"
			data-page={n}
			style={{ width: `${Math.max(1, size.width * scale)}px`, height: `${Math.max(1, size.height * scale)}px` }}
		>
			<PdfPage
				pdf={pdf!}
				pageNumber={n}
				scale={scale}
				dpr={dpr}
				active={active}
				isCurrent={isCurrent}
				annotations={annotations}
				ocrLang={ocrLang}
				onAnnotationCreate={onAnnotationCreate}
				onAnnotationUpdate={onAnnotationUpdate}
				onAnnotationSelect={(a) => setActiveAnnId(a.id)}
				activeAnnotationId={activeAnnId}
				onRectSelect={onRectSelect}
				onSelectionChanged={handleParagraphSelected}
				onBaseSize={reportPageSize}
			/>
			{viewMode === "continuous" && <span className="pdf-page-label">{n}</span>}
		</div>
	);

	return (
		<div ref={areaRef} className="editor-area">
			<div className="editor-toolbar pdf-toolbar">
				<div className="toolbar-group">
					<button type="button" className="icon-btn pdf-jump-edge" onClick={() => jumpToPage(1)} disabled={!pdf || pageNum <= 1} title="首页 (Home)">
						⇤
					</button>
					<button type="button" className="icon-btn" onClick={() => jumpToPage(pageNum - 1)} disabled={!pdf || pageNum <= 1} title="上一页">
						<Icon name="chevronLeft" size={14} />
					</button>
					<span className="pdf-page-field">
						<PageNumberInput page={pageNum} total={total} disabled={!pdf} onCommit={(n) => jumpToPage(n)} />
						<span className="pdf-page-total">/ {total || "–"}</span>
					</span>
					<button type="button" className="icon-btn" onClick={() => jumpToPage(pageNum + 1)} disabled={!pdf || pageNum >= total} title="下一页">
						<Icon name="chevronRight" size={14} />
					</button>
					<button type="button" className="icon-btn pdf-jump-edge" onClick={() => jumpToPage(total)} disabled={!pdf || pageNum >= total} title="末页 (End)">
						⇥
					</button>
				</div>

				<div className="toolbar-group" role="group" aria-label="阅读模式">
					<button
						type="button"
						className={`icon-btn${viewMode === "continuous" ? " active" : ""}`}
						onClick={() => applyViewMode("continuous")}
						title="连续滚动（适合长文档）"
						aria-pressed={viewMode === "continuous"}
						style={{ width: "auto", padding: "0 8px" }}
					>
						连续
					</button>
					<button
						type="button"
						className={`icon-btn${viewMode === "paged" ? " active" : ""}`}
						onClick={() => applyViewMode("paged")}
						title="单页翻页"
						aria-pressed={viewMode === "paged"}
						style={{ width: "auto", padding: "0 8px" }}
					>
						单页
					</button>
				</div>

				<div className="toolbar-group" role="group" aria-label="缩放">
					<button type="button" className="icon-btn" onClick={() => applyCustomScale(scale - 0.15)} disabled={!pdf} title="缩小 (-)">
						－
					</button>
					<span className="pdf-zoom-label" title={`当前缩放 ${Math.round(scale * 100)}%（${zoom.mode === "fit-width" ? "适应宽度" : zoom.mode === "fit-page" ? "适应页面" : "自定义"}）`}>
						{zoomLabel}
					</span>
					<button type="button" className="icon-btn" onClick={() => applyCustomScale(scale + 0.15)} disabled={!pdf} title="放大 (+)">
						＋
					</button>
					<button
						type="button"
						className={`icon-btn${zoom.mode === "fit-width" ? " active" : ""}`}
						onClick={() => applyFit("fit-width")}
						title="适应宽度 (0)"
						aria-pressed={zoom.mode === "fit-width"}
						style={{ width: "auto", padding: "0 8px" }}
					>
						适宽
					</button>
					<button
						type="button"
						className={`icon-btn${zoom.mode === "fit-page" ? " active" : ""}`}
						onClick={() => applyFit("fit-page")}
						title="适应页面 (9)"
						aria-pressed={zoom.mode === "fit-page"}
						style={{ width: "auto", padding: "0 8px" }}
					>
						适页
					</button>
				</div>

				<div className="toolbar-sep" />

				<span className="pdf-ocr-wrap" ref={ocrMenuRef}>
					<button type="button" className="icon-btn" onClick={() => setOcrMenuOpen((v) => !v)} disabled={!pdf} title="OCR（扫描版文字识别）" style={{ width: "auto", padding: "0 8px" }}>
						OCR{ocrJob?.running && <span className="pdf-ocr-dot" />}
					</button>
					{ocrMenuOpen && (
						<div className="pdf-ocr-menu" data-toolbar>
							<button type="button" onClick={() => { setOcrMenuOpen(false); void ocrCurrentPage(); }} disabled={!pdf || !!ocrJob?.running}>
								识别本页
							</button>
							<button type="button" onClick={() => { setOcrMenuOpen(false); if (ocrJob?.running) cancelOcr.current = true; else void ocrWholeDoc(); }} disabled={!pdf}>
								{ocrJob?.running ? "停止识别" : "识别全书"}
							</button>
							<div className="pdf-ocr-menu-hint">识别结果缓存，供 AI 检索</div>
						</div>
					)}
				</span>
				{scanned && !ocrJob?.running && (
					<span className="toolbar-badge" title="该页没有文本层，可用 OCR 识别">
						扫描版
					</span>
				)}
				{ocrJob?.running && (
					<span className="toolbar-muted" title={ocrJob.status}>
						{ocrJob.page}/{ocrJob.total}
					</span>
				)}

				<span style={{ flex: 1 }} />
				{outline.length > 0 && onOpenOutline && (
					<button type="button" className="icon-btn" onClick={onOpenOutline} title="打开目录侧栏" aria-label="打开目录侧栏">
						<Icon name="toc" size={14} />
					</button>
				)}
			</div>

			<div className="pdf-reading-progress" aria-hidden="true">
				<span style={{ width: `${progress}%` }} />
			</div>

			<div
				ref={stageRef}
				className={`pdf-stage ${viewMode}`}
				tabIndex={0}
				role="region"
				aria-label="PDF 阅读区"
				onScroll={handleScroll}
			>
				{loading && !pdf ? (
					<div className="pdf-stage-message">
						<span className="pdf-spinner" />
						正在加载 PDF…
					</div>
				) : loadError ? (
					<div className="pdf-stage-message error">
						<div>
							<strong>PDF 加载失败</strong>
							<div className="pdf-stage-error-detail">{loadError}</div>
						</div>
					</div>
				) : pdf && viewMode === "continuous" ? (
					<div className="pdf-pages" ref={pagesContentRef}>
						{pageList.map((n) => renderPdfPage(n, sizeOf(n), activePages.has(n) || n === pageNum, n === pageNum))}
						<PdfSelectionOverlay ref={selectionOverlayRef} />
					</div>
				) : pdf ? (
					<div className="pdf-paged-inner" ref={pagesContentRef}>
						{renderPdfPage(pageNum, sizeOf(pageNum), true, true)}
						<PdfSelectionOverlay ref={selectionOverlayRef} />
					</div>
				) : null}
			</div>

			{selectionMenu && (
				<div
					className={`pdf-sel-menu${selectionMenu.below ? " below" : ""}`}
					data-toolbar
					style={{ left: selectionMenu.x, top: selectionMenu.y }}
					onMouseDown={(e) => e.preventDefault()}
				>
					<button type="button" className="primary" onClick={createHighlight} disabled={!onAnnotationCreate}>
						<Icon name="annotations" size={12} /> 高亮标注
					</button>
					<button type="button" onClick={quoteSelection}>
						<Icon name="chat" size={12} /> 引用提问
					</button>
					<button type="button" onClick={copySelection}>
						{copied ? "已复制" : "复制"}
					</button>
					<button type="button" onClick={() => { setSelectionMenu(null); window.getSelection()?.removeAllRanges(); }} title="取消">
						✕
					</button>
				</div>
			)}

			{activeAnn && !selectionMenu && (
				<div className="reader-ann-bar" data-toolbar>
					<span className="reader-ann-text">{activeAnn.text?.trim().slice(0, 40) || "（无文本）"}</span>
					<button
						type="button"
						onClick={() => {
							onTextSelected(activeAnn.text ?? "", activeAnn.page);
							setActiveAnnId(null);
						}}
					>
						<Icon name="chat" size={12} /> 引用
					</button>
					<button
						type="button"
						className="danger"
						onClick={() => {
							onAnnotationDelete?.(activeAnn.id);
							setActiveAnnId(null);
						}}
					>
						删除
					</button>
					<button type="button" onClick={() => setActiveAnnId(null)} title="取消">
						✕
					</button>
				</div>
			)}
		</div>
	);
}

function PageNumberInput({ page, total, disabled, onCommit }: { page: number; total: number; disabled: boolean; onCommit: (n: number) => void }) {
	const [draft, setDraft] = useState(String(page));
	const [editing, setEditing] = useState(false);
	useEffect(() => {
		if (!editing) setDraft(String(page));
	}, [page, editing]);
	const commit = () => {
		const n = Number.parseInt(draft, 10);
		if (Number.isFinite(n)) onCommit(n);
		setEditing(false);
	};
	return (
		<input
			className="pdf-page-input"
			value={editing ? draft : String(page)}
			onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
			onFocus={() => {
				setEditing(true);
				setDraft(String(page));
			}}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					e.currentTarget.blur();
				} else if (e.key === "Escape") {
					setDraft(String(page));
					setEditing(false);
					e.currentTarget.blur();
				}
			}}
			inputMode="numeric"
			aria-label={`页码，共 ${total || "未知"} 页`}
			disabled={disabled}
		/>
	);
}

/**
 * Paints the merged per-line selection rects. Kept in its own component so a
 * live drag repaints only this layer, not the (possibly 1500-page) shell list.
 */
const PdfSelectionOverlay = forwardRef<SelectionOverlayHandle>(function PdfSelectionOverlay(_props, ref) {
	const [rects, setRects] = useState<SelectionRect[]>([]);
	useImperativeHandle(
		ref,
		() => ({
			setRects,
			clear: () => setRects((prev) => (prev.length === 0 ? prev : [])),
		}),
		[],
	);
	if (rects.length === 0) return null;
	return (
		<div className="pdf-selection-layer" aria-hidden="true">
			{rects.map((r, i) => (
				<div
					key={i}
					className="pdf-selection-rect"
					style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
				/>
			))}
		</div>
	);
});
