import { useState, useRef, useEffect } from "react";
import { ocrCanvas } from "../ocr.ts";
import { MODIFIER_LABEL, type SelectionKind } from "../selection.ts";

export type AnnotationRect = { x: number; y: number; w: number; h: number };

export type Annotation = {
	id: string;
	page: number;
	type: "highlight" | "rect";
	rect: AnnotationRect;
	/** Per-line boxes for a multi-line text selection (PDF); `rect` is the union. */
	rects?: AnnotationRect[];
	text?: string;
	color: string;
	/** EPUB only: the epub.js CFI range this highlight is anchored to. */
	cfi?: string;
};

type Props = {
	annotations: Annotation[];
	onCreate: (a: Annotation) => void;
	onUpdate: (id: string, patch: Partial<Annotation>) => void;
	onRectSelect: (text: string, page: number, kind: Extract<SelectionKind, "rect" | "ocr">) => void;
	/** The viewer owns the active highlight bar; this is the highlighted id. */
	activeId?: string | null;
	onSelect?: (a: Annotation) => void;
	page: number;
	ocrLang: string;
	/** Only the page in the reading position shows the bottom hint strip. */
	showHint?: boolean;
};

/** Pull the textLayer spans that intersect a normalized rectangle. */
function extractTextInRect(
	textLayer: HTMLElement,
	rectNorm: Annotation["rect"],
	pageEl: HTMLElement,
): string {
	const pr = pageEl.getBoundingClientRect();
	if (pr.width === 0 || pr.height === 0) return "";
	const sel = {
		left: pr.left + rectNorm.x * pr.width,
		top: pr.top + rectNorm.y * pr.height,
		right: pr.left + (rectNorm.x + rectNorm.w) * pr.width,
		bottom: pr.top + (rectNorm.y + rectNorm.h) * pr.height,
	};
	const parts: string[] = [];
	for (const el of Array.from(textLayer.querySelectorAll<HTMLElement>("span"))) {
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) continue;
		if (r.right < sel.left || r.left > sel.right || r.bottom < sel.top || r.top > sel.bottom)
			continue;
		const t = el.textContent ?? "";
		if (t) parts.push(t);
	}
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function AnnotationLayer({
	annotations,
	onCreate,
	onUpdate,
	onRectSelect,
	activeId,
	onSelect,
	page,
	ocrLang,
	showHint = true,
}: Props) {
	const ref = useRef<HTMLDivElement>(null);
	const [drag, setDrag] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
	const [altDown, setAltDown] = useState(false);
	const [ocrState, setOcrState] = useState<{ progress: number; status: string } | null>(null);
	const start = useRef<{ x: number; y: number } | null>(null);

	// Track Alt/Meta so the overlay can stay transparent to native text selection
	// and only capture the pointer while a box-select is in progress.
	useEffect(() => {
		const down = (e: KeyboardEvent) => {
			if (e.altKey || e.metaKey) setAltDown(true);
		};
		const up = (e: KeyboardEvent) => {
			if (!e.altKey && !e.metaKey) setAltDown(false);
		};
		const blur = () => setAltDown(false);
		window.addEventListener("keydown", down);
		window.addEventListener("keyup", up);
		window.addEventListener("blur", blur);
		return () => {
			window.removeEventListener("keydown", down);
			window.removeEventListener("keyup", up);
			window.removeEventListener("blur", blur);
		};
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			if (drag) {
				start.current = null;
				setDrag(null);
			} else {
				window.getSelection()?.removeAllRanges();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [drag]);

	const pageAnns = annotations.filter((a) => a.page === page);

	const toNorm = (e: React.MouseEvent) => {
		const r = ref.current!.getBoundingClientRect();
		return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
	};

	const runOcr = async (a: Annotation) => {
		const pageEl = ref.current?.parentElement;
		const canvas = pageEl?.querySelector("canvas") as HTMLCanvasElement | null;
		if (!pageEl || !canvas || canvas.width === 0) return;
		const rectPx = {
			left: a.rect.x * canvas.width,
			top: a.rect.y * canvas.height,
			width: a.rect.w * canvas.width,
			height: a.rect.h * canvas.height,
		};
		setOcrState({ progress: 0, status: "启动 OCR" });
		try {
			const text = await ocrCanvas(canvas, ocrLang, rectPx, (progress, status) =>
				setOcrState({ progress, status }),
			);
			if (text) {
				onUpdate(a.id, { text });
				onRectSelect(text, a.page, "ocr");
			}
			setOcrState(null);
		} catch (e) {
			console.error("[ocr] rect failed", e);
			setOcrState({ progress: 1, status: `OCR 失败: ${e instanceof Error ? e.message : String(e)}` });
			setTimeout(() => setOcrState(null), 4000);
		}
	};

	return (
		<div
			ref={ref}
			style={{
				position: "absolute",
				inset: 0,
				cursor: altDown ? "crosshair" : "default",
				// Stay transparent while idle so PDF text underneath can still be selected natively.
				pointerEvents: altDown || drag ? "auto" : "none",
			}}
			onMouseDown={(e) => {
				if (e.button === 2) {
					start.current = null;
					setDrag(null);
					return;
				}
				if (e.altKey || e.metaKey) {
					e.preventDefault();
					start.current = toNorm(e);
					setDrag({ ...start.current, w: 0, h: 0 });
				}
			}}
			onContextMenu={(e) => {
				if (drag) {
					e.preventDefault();
					start.current = null;
					setDrag(null);
				}
			}}
			onMouseMove={(e) => {
				if (!start.current) return;
				const cur = toNorm(e);
				setDrag({
					x: Math.min(start.current.x, cur.x),
					y: Math.min(start.current.y, cur.y),
					w: Math.abs(cur.x - start.current.x),
					h: Math.abs(cur.y - start.current.y),
				});
			}}
			onMouseUp={() => {
				if (drag && drag.w > 0.02 && drag.h > 0.02) {
					const id = crypto.randomUUID();
					const pageEl = ref.current?.parentElement ?? null;
					const textLayer = pageEl?.querySelector<HTMLElement>(".textLayer") ?? null;
					const text = pageEl && textLayer ? extractTextInRect(textLayer, drag, pageEl) : "";
					const ann: Annotation = {
						id,
						page,
						type: "rect",
						rect: drag,
						text: text || undefined,
						color: "#ffeb3b61",
					};
					onCreate(ann);
					if (text) onRectSelect(text, page, "rect");
					else runOcr(ann);
				}
				start.current = null;
				setDrag(null);
			}}
			onMouseLeave={() => {
				if (start.current) {
					start.current = null;
					setDrag(null);
				}
			}}
		>
			{pageAnns.flatMap((a) =>
				(a.rects?.length ? a.rects : [a.rect]).map((box, i) => (
					<div
						key={`${a.id}:${i}`}
						data-ann={a.id}
						onClick={(e) => {
							e.stopPropagation();
							onSelect?.(a);
						}}
						title="点击查看操作"
						style={{
							position: "absolute",
							left: `${box.x * 100}%`,
							top: `${box.y * 100}%`,
							width: `${box.w * 100}%`,
							height: `${box.h * 100}%`,
							background: a.color === "#ffeb3b88" ? "#ffeb3b61" : a.color,
							mixBlendMode: "multiply",
							border: a.type === "rect" ? "2px solid #ff9800" : "none",
							pointerEvents: "auto",
							cursor: "pointer",
						}}
					/>
				)),
			)}
			{drag && (
				<div
					style={{
						position: "absolute",
						left: `${drag.x * 100}%`,
						top: `${drag.y * 100}%`,
						width: `${drag.w * 100}%`,
						height: `${drag.h * 100}%`,
						border: "2px dashed #ff9800",
						background: "#ffeb3b44",
						pointerEvents: "none",
					}}
				/>
			)}
			{ocrState && (
				<div
					data-toolbar
					style={{
						position: "absolute",
						bottom: 28,
						right: 4,
						fontSize: 11,
						background: "#000c",
						color: "#fff",
						padding: "4px 8px",
						borderRadius: 4,
						pointerEvents: "auto",
						maxWidth: 220,
					}}
				>
					框选 OCR {Math.round(ocrState.progress * 100)}% · {ocrState.status}
				</div>
			)}
			{showHint && !activeId && !drag && !ocrState && (
				<div style={{ position: "absolute", bottom: 4, right: 4, fontSize: 11, background: "#0008", color: "#fff", padding: "2px 6px", borderRadius: 4, pointerEvents: "none" }}>
					{MODIFIER_LABEL} 拖拽框选 · 双击选词 · 三击选段 · 点击标注可操作
				</div>
			)}
			{showHint && drag && (
				<div style={{ position: "absolute", bottom: 28, right: 4, fontSize: 11, background: "#000c", color: "#fff", padding: "4px 8px", borderRadius: 4, pointerEvents: "none" }}>
					松开创建 · Esc/右键取消
				</div>
			)}
		</div>
	);
}
