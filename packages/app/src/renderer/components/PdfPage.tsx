import { memo, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { AnnotationLayer, type Annotation } from "./AnnotationLayer.tsx";
import type { SelectionKind } from "../selection.ts";
import { installParagraphSelection } from "../pdf-paragraph.ts";

export type RectSelectKind = Extract<SelectionKind, "rect" | "ocr">;

type PageSize = { width: number; height: number };

type Props = {
	pdf: pdfjs.PDFDocumentProxy;
	pageNumber: number;
	/** CSS-pixel scale (1 = PDF's natural 72dpi size). */
	scale: number;
	dpr: number;
	/** Only pages near the viewport are allowed to hold a canvas. */
	active: boolean;
	isCurrent: boolean;
	annotations: Annotation[];
	ocrLang: string;
	onAnnotationCreate?: (a: Annotation) => void;
	onAnnotationUpdate?: (id: string, patch: Partial<Annotation>) => void;
	onAnnotationDelete?: (id: string) => void;
	onRectSelect?: (text: string, page: number, kind: RectSelectKind) => void;
	onQuote?: (a: Annotation) => void;
	/** Called after double-click selects a whole paragraph (to show the menu). */
	onSelectionChanged?: () => void;
	onBaseSize?: (pageNumber: number, size: PageSize) => void;
};

type Status = "idle" | "rendering" | "ready" | "error";

/**
 * One rendered PDF page. In continuous mode many of these are mounted but only
 * the `active` ones (viewport + overscan) own a canvas; scrolled-away pages
 * release their backing store so reading a long document doesn't accumulate
 * tens of megabytes per page. Rendering is cancelled when the page scrolls
 * away or the scale changes, which also prevents the "Cannot use the same
 * canvas during multiple render() operations" race the old viewer hit while
 * dragging the sidebar.
 */
export const PdfPage = memo(function PdfPage({
	pdf,
	pageNumber,
	scale,
	dpr,
	active,
	isCurrent,
	annotations,
	ocrLang,
	onAnnotationCreate,
	onAnnotationUpdate,
	onAnnotationDelete,
	onRectSelect,
	onQuote,
	onSelectionChanged,
	onBaseSize,
}: Props) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const textRef = useRef<HTMLDivElement>(null);
	const [status, setStatus] = useState<Status>("idle");
	const [error, setError] = useState<string | null>(null);
	const [slow, setSlow] = useState(false);
	// Callbacks are read through refs so a parent re-render doesn't restart the
	// (expensive) canvas/text-layer render.
	const sizeCb = useRef(onBaseSize);
	sizeCb.current = onBaseSize;
	const selectCb = useRef(onSelectionChanged);
	selectCb.current = onSelectionChanged;

	useEffect(() => {
		if (!active) {
			setSlow(false);
			return;
		}
		setSlow(false);
		const timer = window.setTimeout(() => setSlow(true), 260);
		return () => window.clearTimeout(timer);
	}, [active, pageNumber, scale]);

	useEffect(() => {
		if (!active) return;
		const canvas = canvasRef.current;
		const text = textRef.current;
		if (!canvas || !text) return;

		let cancelled = false;
		let renderTask: pdfjs.RenderTask | null = null;
		let textLayer: pdfjs.TextLayer | null = null;
		let disposeParagraph: (() => void) | null = null;
		setStatus("rendering");
		setError(null);

		(async () => {
			try {
				const page = await pdf.getPage(pageNumber);
				if (cancelled) return;
				const viewport = page.getViewport({ scale });
				// Cache the natural size so the placeholder can be laid out at the
				// right aspect ratio as soon as the page is measured.
				sizeCb.current?.(pageNumber, { width: viewport.width / scale, height: viewport.height / scale });

				const outputScale = dpr || 1;
				canvas.width = Math.floor(viewport.width * outputScale);
				canvas.height = Math.floor(viewport.height * outputScale);
				canvas.style.width = `${viewport.width}px`;
				canvas.style.height = `${viewport.height}px`;
				const ctx = canvas.getContext("2d");
				if (!ctx) throw new Error("无法创建画布上下文");
				const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
				renderTask = page.render({ canvas, canvasContext: ctx, viewport, transform });
				await renderTask.promise;
				if (cancelled) return;

				text.textContent = "";
				text.style.width = `${viewport.width}px`;
				text.style.height = `${viewport.height}px`;
				// TextLayer positions its spans via these CSS vars (pdf.js v5 API).
				text.style.setProperty("--total-scale-factor", String(scale));
				text.style.setProperty("--scale-round-x", "1px");
				text.style.setProperty("--scale-round-y", "1px");
				const textContent = await page.getTextContent();
				if (cancelled) return;
				textLayer = new pdfjs.TextLayer({ textContentSource: textContent, container: text, viewport });
				await textLayer.render();
				if (cancelled) return;
				// Double-click should select the whole visual paragraph rather
				// than a single glyph/word.
				disposeParagraph = installParagraphSelection(text, () => selectCb.current?.());
				setStatus("ready");
			} catch (e) {
				const name = (e as { name?: string } | null)?.name;
				if (cancelled || name === "RenderingCancelledException" || name === "AbortException") return;
				console.error("[pdf] render page failed", pageNumber, e);
				setError(e instanceof Error ? e.message : String(e));
				setStatus("error");
			}
		})();

		return () => {
			cancelled = true;
			disposeParagraph?.();
			try {
				renderTask?.cancel();
			} catch {}
			try {
				textLayer?.cancel();
			} catch {}
			// Drop the canvas backing store: an A4 page at 2x DPR is ~20MB, so
			// keeping every visited page alive would exhaust memory quickly.
			canvas.width = 0;
			canvas.height = 0;
			if (text) text.textContent = "";
		};
	}, [pdf, pageNumber, scale, dpr, active]);

	const overlaysEnabled = Boolean(onAnnotationCreate && onAnnotationDelete);

	return (
		<div className="pdf-page" data-page-content={pageNumber}>
			<div className="pdf-page-surface">
				<canvas ref={canvasRef} className="pdf-canvas" />
				<div ref={textRef} className="textLayer" />
			</div>
			{overlaysEnabled && (
				<AnnotationLayer
					annotations={annotations}
					page={pageNumber}
					ocrLang={ocrLang}
					onCreate={onAnnotationCreate!}
					onUpdate={onAnnotationUpdate ?? (() => {})}
					onDelete={onAnnotationDelete!}
					onRectSelect={onRectSelect ?? (() => {})}
					onQuote={onQuote}
					showHint={isCurrent}
				/>
			)}
			{slow && status === "rendering" && isCurrent && (
				<div className="pdf-page-loading" aria-hidden="true">
					<span className="pdf-spinner" />
					正在渲染…
				</div>
			)}
			{status === "error" && (
				<div className="pdf-page-error" title={error ?? ""}>
					页面渲染失败
				</div>
			)}
		</div>
	);
});
