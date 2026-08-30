import { createWorker, type Worker as OcrWorker } from "tesseract.js";

export type OcrProgress = (progress: number, status: string) => void;
export type OcrRect = { left: number; top: number; width: number; height: number };

let workerPromise: Promise<OcrWorker> | null = null;
let workerLang = "";
let progressCb: OcrProgress | null = null;

function loadWorker(lang: string): Promise<OcrWorker> {
	if (workerPromise && workerLang === lang) return workerPromise;
	const previous = workerPromise;
	if (previous) {
		previous.then((w) => w.terminate().catch(() => {})).catch(() => {});
	}
	workerLang = lang;
	workerPromise = createWorker(lang, undefined, {
		logger: (m: { progress: number; status: string }) => progressCb?.(m.progress, m.status),
	}).catch((e) => {
		workerPromise = null;
		workerLang = "";
		throw e;
	});
	return workerPromise;
}

/**
 * Recognize text from a rendered page canvas. When `rect` (canvas pixel space) is
 * provided, only that region is recognized, which is much faster and more accurate
 * than OCR-ing the whole page and slicing afterwards.
 */
export async function ocrCanvas(
	canvas: HTMLCanvasElement,
	lang: string,
	rect?: OcrRect,
	onProgress?: OcrProgress,
): Promise<string> {
	if (canvas.width === 0 || canvas.height === 0) return "";
	progressCb = onProgress ?? null;
	const worker = await loadWorker(lang);
	const options = rect
		? {
				rectangle: {
					left: Math.max(0, Math.round(rect.left)),
					top: Math.max(0, Math.round(rect.top)),
					width: Math.max(1, Math.round(rect.width)),
					height: Math.max(1, Math.round(rect.height)),
				},
			}
		: undefined;
	try {
		const result = await worker.recognize(canvas, options);
		return result.data.text
			.replace(/[ \t]+/g, " ")
			.replace(/\n{2,}/g, "\n")
			.trim();
	} finally {
		progressCb = null;
	}
}

export async function disposeOcr(): Promise<void> {
	if (!workerPromise) return;
	const w = await workerPromise.catch(() => null);
	await w?.terminate().catch(() => {});
	workerPromise = null;
	workerLang = "";
}
