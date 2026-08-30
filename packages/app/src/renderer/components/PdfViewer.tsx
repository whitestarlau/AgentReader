import { useEffect, useRef, useState, useCallback } from "react";
import * as pdfjs from "pdfjs-dist";
import { AnnotationLayer, type Annotation } from "./AnnotationLayer.tsx";
import { Icon } from "./Icons.tsx";
import { ocrCanvas } from "../ocr.ts";
import { loadReadingPage, saveReadingPage } from "../reading.ts";
import type { SelectionKind } from "../selection.ts";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

const MIN_SCALE = 0.6;
const MAX_SCALE = 3;
const STAGE_CHROME = 44 * 2 + 48; // side page-nav buttons + .document-stage horizontal padding
const SCALE_STORAGE_KEY = "pdfViewer.scaleMode";

type ScaleMode = { mode: "fit-width" } | { mode: "fixed"; scale: number };

function loadScaleMode(): ScaleMode {
	try {
		const raw = localStorage.getItem(SCALE_STORAGE_KEY);
		if (raw === "fit-width") return { mode: "fit-width" };
		if (raw) {
			const scale = Number(raw);
			if (Number.isFinite(scale)) return { mode: "fixed", scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)) };
		}
	} catch {
		// ignore storage failures (e.g. disabled localStorage)
	}
	return { mode: "fit-width" };
}

function saveScaleMode(next: ScaleMode) {
	try {
		localStorage.setItem(SCALE_STORAGE_KEY, next.mode === "fit-width" ? "fit-width" : String(next.scale));
	} catch {
		// ignore storage failures
	}
}

type RectSelectKind = Extract<SelectionKind, "rect" | "ocr">;

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
};

export function PdfViewer({ docId, page: externalPage, onPageChange, onTextSelected, onRectSelect, annotations = [], onAnnotationCreate, onAnnotationUpdate, onAnnotationDelete, ocrLang = "chi_sim+eng", onZoomChange, onOcrJob, onTotalChange }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
	const [pageNum, setPageNum] = useState(externalPage ?? 1);
	const [scaleMode, setScaleMode] = useState<ScaleMode>(loadScaleMode);
	const [scale, setScale] = useState(scaleMode.mode === "fixed" ? scaleMode.scale : 1);
	const [total, setTotal] = useState(0);
	const [scanned, setScanned] = useState(false);
	// Backing-store pixel ratio. Keeping the canvas at device resolution is what
	// makes pages look crisp on HiDPI/Retina screens instead of being upscaled.
	const [dpr, setDpr] = useState(() => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1));
	const [ocrJob, setOcrJob] = useState<{ running: boolean; page: number; total: number; progress: number; status: string } | null>(null);
	const cancelOcr = useRef(false);
	const pageRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (externalPage !== undefined && externalPage !== pageNum) setPageNum(externalPage);
	}, [externalPage]);

	const setPage = (updater: number | ((n: number) => number)) => {
		setPageNum((prev) => {
			const next = typeof updater === "function" ? (updater as (n: number) => number)(prev) : updater;
			const clamped = Math.min(total || next, Math.max(1, next));
			onPageChange?.(clamped);
			saveReadingPage(docId, clamped);
			return clamped;
		});
	};

	useEffect(() => {
		let cancelled = false;
		(async () => {
			const path = await window.api.getDocPath(docId);
			if (!path) return;
			const data = await window.api.readFile?.(path) ?? null;
			const loadingTask = data ? pdfjs.getDocument({ data }) : pdfjs.getDocument(path);
			const doc = await loadingTask.promise;
			if (cancelled) return;
			setPdf(doc);
			setTotal(doc.numPages);
			// Resume the last read page for this document; fall back to the
			// caller-provided page, then to the first page.
			const saved = loadReadingPage(docId);
			const restore = saved ?? externalPage ?? 1;
			const clamped = Math.min(doc.numPages, Math.max(1, restore));
			setPageNum(clamped);
			onPageChange?.(clamped);
		})();
		return () => { cancelled = true; };
	}, [docId]);

	const renderPage = useCallback(async () => {
		if (!pdf || !pageRef.current) return;
		const page = await pdf.getPage(pageNum);
		const viewport = page.getViewport({ scale });
		const canvas = pageRef.current.querySelector("canvas") as HTMLCanvasElement;
		if (!canvas) return;
		// The viewport is in CSS pixels; enlarge the backing store by the device
		// pixel ratio and let the render transform map layout → device pixels.
		// CSS width/height stay in CSS pixels so layout and hit-testing are unchanged.
		const outputScale = dpr || 1;
		canvas.width = Math.floor(viewport.width * outputScale);
		canvas.height = Math.floor(viewport.height * outputScale);
		canvas.style.width = `${Math.floor(viewport.width)}px`;
		canvas.style.height = `${Math.floor(viewport.height)}px`;
		const ctx = canvas.getContext("2d")!;
		const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
		await page.render({ canvas, canvasContext: ctx, viewport, transform }).promise;

		const textLayer = pageRef.current.querySelector(".textLayer") as HTMLDivElement;
		if (textLayer) {
			textLayer.textContent = "";
			textLayer.style.width = `${viewport.width}px`;
			textLayer.style.height = `${viewport.height}px`;
			// TextLayer sizes its spans with these CSS vars (pdf.js v5 API).
			textLayer.style.setProperty("--total-scale-factor", String(scale));
			textLayer.style.setProperty("--scale-round-x", "1px");
			textLayer.style.setProperty("--scale-round-y", "1px");
			const textContent = await page.getTextContent();
			setScanned(textContent.items.length === 0);
			const layer = new pdfjs.TextLayer({ textContentSource: textContent, container: textLayer, viewport });
			await layer.render();
		}
	}, [pdf, pageNum, scale, dpr]);

	// Moving the window between displays can change devicePixelRatio without a
	// resize event, so watch for a resolution change and re-render at the new ratio.
	useEffect(() => {
		const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
		const onChange = () => setDpr(window.devicePixelRatio || 1);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, [dpr]);

	// OCR a single page canvas and persist it so the RAG tools can use it.
	const ocrPage = useCallback(
		async (n: number): Promise<string> => {
			if (!pdf) return "";
			const page = await pdf.getPage(n);
			const viewport = page.getViewport({ scale: 2 });
			const canvas = document.createElement("canvas");
			canvas.width = viewport.width;
			canvas.height = viewport.height;
			const ctx = canvas.getContext("2d")!;
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
		setOcrJob({ running: true, page: pageNum, total, progress: 0, status: "启动 OCR" });
		try {
			await ocrPage(pageNum);
		} catch (e) {
			console.error("[ocr] page failed", e);
			setOcrJob({ running: false, page: pageNum, total, progress: 1, status: `OCR 失败: ${e instanceof Error ? e.message : String(e)}` });
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

	useEffect(() => { renderPage(); }, [renderPage]);

	// When in fit-width mode, derive the scale from the page's intrinsic width
	// and the available stage width. Recompute on container resize.
	useEffect(() => {
		if (scaleMode.mode !== "fit-width" || !pdf) return;
		let cancelled = false;
		const compute = async () => {
			const el = containerRef.current;
			if (!el) return;
			const page = await pdf.getPage(pageNum);
			if (cancelled) return;
			const base = page.getViewport({ scale: 1 }).width;
			const avail = Math.max(120, el.clientWidth - STAGE_CHROME);
			const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, avail / base));
			setScale((prev) => (Math.abs(prev - next) < 0.005 ? prev : next));
		};
		compute();
		const ro = new ResizeObserver(compute);
		if (containerRef.current) ro.observe(containerRef.current);
		return () => { cancelled = true; ro.disconnect(); };
	}, [scaleMode, pdf, pageNum]);

	// User-driven zoom switches from fit-width to a fixed, persisted scale.
	const applyFixedScale = useCallback((next: number | ((s: number) => number)) => {
		setScaleMode((mode) => {
			const base = mode.mode === "fixed" ? mode.scale : scale;
			const value = typeof next === "function" ? next(base) : next;
			const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
			const fixed: ScaleMode = { mode: "fixed", scale: clamped };
			saveScaleMode(fixed);
			return fixed;
		});
		setScale((prev) => {
			const value = typeof next === "function" ? next(prev) : next;
			return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
		});
	}, [scale]);

	const fitWidth = useCallback(() => {
		const next: ScaleMode = { mode: "fit-width" };
		saveScaleMode(next);
		setScaleMode(next);
	}, []);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const handler = () => {
			const sel = window.getSelection();
			const text = sel?.toString().trim();
			if (!text || !pageRef.current) return;
			try {
				const range = sel!.getRangeAt(0);
				const rect = range.getBoundingClientRect();
				const pageRect = pageRef.current.getBoundingClientRect();
				const norm = {
					x: (rect.left - pageRect.left) / pageRect.width,
					y: (rect.top - pageRect.top) / pageRect.height,
					w: rect.width / pageRect.width,
					h: rect.height / pageRect.height,
				};
				onTextSelected(text, pageNum, norm);
			} catch {
				onTextSelected(text, pageNum);
			}
		};
		el.addEventListener("mouseup", handler);
		return () => el.removeEventListener("mouseup", handler);
	}, [pageNum, onTextSelected]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement) return;
			if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " " || e.key === "PageDown") {
				e.preventDefault();
				setPage((n) => Math.min(total, n + 1));
			} else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") {
				e.preventDefault();
				setPage((n) => Math.max(1, n - 1));
			} else if (e.key === "Home") {
				e.preventDefault();
				setPage(1);
			} else if (e.key === "End") {
				e.preventDefault();
				setPage(total);
			} else if (e.key === "+" || e.key === "=") applyFixedScale((s) => s + 0.2);
			else if (e.key === "-") applyFixedScale((s) => s - 0.2);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [total, applyFixedScale]);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				applyFixedScale((s) => s - e.deltaY * 0.001);
			}
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [applyFixedScale]);

	// Report reader state up to the status bar without re-subscribing every render.
	const zoomCb = useRef(onZoomChange);
	zoomCb.current = onZoomChange;
	const ocrCb = useRef(onOcrJob);
	ocrCb.current = onOcrJob;
	const totalCb = useRef(onTotalChange);
	totalCb.current = onTotalChange;
	useEffect(() => {
		zoomCb.current?.(scale);
	}, [scale]);
	useEffect(() => {
		totalCb.current?.(total);
	}, [total]);
	useEffect(() => {
		ocrCb.current?.(ocrJob ? { running: ocrJob.running, page: ocrJob.page, total: ocrJob.total, progress: ocrJob.progress } : null);
	}, [ocrJob]);

	if (!pdf)
		return (
			<div className="document-stage" style={{ alignItems: "center", justifyContent: "center" }}>
				<span className="toolbar-muted">加载中…</span>
			</div>
		);

	return (
		<div ref={containerRef} tabIndex={0} className="editor-area" style={{ outline: "none" }}>
			<div className="editor-toolbar">
				<div className="toolbar-group">
					<button type="button" className="icon-btn" onClick={() => setPage(1)} disabled={pageNum <= 1} title="首页">
						⇤
					</button>
					<button type="button" className="icon-btn" onClick={() => setPage((n) => Math.max(1, n - 1))} disabled={pageNum <= 1} title="上一页">
						<Icon name="chevronLeft" size={14} />
					</button>
					<span style={{ display: "flex", alignItems: "center", gap: 4, padding: "0 4px", fontSize: 12 }}>
						<input
							value={pageNum}
							onChange={(e) => {
								const v = Number(e.target.value);
								if (v >= 1 && v <= total) setPage(v);
							}}
							aria-label="页码"
						/>
						<span style={{ color: "var(--vscode-fg-dim)" }}>/ {total}</span>
					</span>
					<button type="button" className="icon-btn" onClick={() => setPage((n) => Math.min(total, n + 1))} disabled={pageNum >= total} title="下一页">
						<Icon name="chevronRight" size={14} />
					</button>
					<button type="button" className="icon-btn" onClick={() => setPage(total)} disabled={pageNum >= total} title="末页">
						⇥
					</button>
				</div>

				<div className="toolbar-group">
					<button type="button" className="icon-btn" onClick={() => applyFixedScale((s) => s - 0.2)} title="缩小">
						－
					</button>
					<span className="toolbar-muted" style={{ minWidth: 40, textAlign: "center" }}>
						{scaleMode.mode === "fit-width" ? "适应宽度" : `${Math.round(scale * 100)}%`}
					</span>
					<button type="button" className="icon-btn" onClick={() => applyFixedScale((s) => s + 0.2)} title="放大">
						＋
					</button>
					<button
						type="button"
						className="icon-btn"
						onClick={fitWidth}
						title="适应宽度"
						style={{ width: "auto", padding: "0 8px", color: scaleMode.mode === "fit-width" ? "var(--vscode-accent)" : undefined }}
					>
						适应宽度
					</button>
				</div>

				<div className="toolbar-sep" />

				<button type="button" className="icon-btn" onClick={ocrCurrentPage} disabled={!!ocrJob?.running} title="识别当前页文字（扫描版）" style={{ width: "auto", padding: "0 8px" }}>
					OCR 本页
				</button>
				<button type="button" className="icon-btn" onClick={() => (ocrJob?.running ? (cancelOcr.current = true) : ocrWholeDoc())} title="逐页识别整本书并缓存，供 AI 检索" style={{ width: "auto", padding: "0 8px" }}>
					{ocrJob?.running ? "停止" : "OCR 全书"}
				</button>

				{scanned && !ocrJob?.running && (
					<span className="toolbar-badge" title="该页没有文本层，可能为扫描版">
						扫描版 · 可 OCR
					</span>
				)}
				{ocrJob && (
					<>
						<div className="progress" title={ocrJob.status}>
							<span style={{ width: `${Math.round(ocrJob.progress * 100)}%` }} />
						</div>
						<span className="toolbar-muted">
							{ocrJob.page}/{ocrJob.total}
						</span>
					</>
				)}
			</div>
			<div className="document-stage" style={{ padding: 24 }}>
				<button type="button" className="page-nav" onClick={() => setPage((n) => Math.max(1, n - 1))} disabled={pageNum <= 1}>
					{pageNum > 1 ? "‹" : ""}
				</button>
				<div ref={pageRef} className="page-shell">
					<canvas style={{ display: "block" }} />
					<div className="textLayer" style={{ position: "absolute", inset: 0, overflow: "hidden", lineHeight: 1 }} />
					{onAnnotationCreate && onAnnotationDelete && (
						<AnnotationLayer
							annotations={annotations}
							page={pageNum}
							onCreate={onAnnotationCreate}
							onUpdate={onAnnotationUpdate ?? (() => {})}
							onDelete={onAnnotationDelete}
							onRectSelect={onRectSelect ?? (() => {})}
							ocrLang={ocrLang}
						/>
					)}
				</div>
				<button type="button" className="page-nav" onClick={() => setPage((n) => Math.min(total, n + 1))} disabled={pageNum >= total}>
					{pageNum < total ? "›" : ""}
				</button>
			</div>
		</div>
	);
}
