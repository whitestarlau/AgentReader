import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ipcMain } from "electron";
import { getDocDir } from "./paths.ts";

/**
 * Everything about extracting a document's text: the lazy per-page/per-chapter
 * cache, the OCR fallback, and the EPUB/PDF parsers behind `getDocText`.
 */

export type DocText = {
	/** First pages/chapters extracted eagerly, for the system prompt and current hint. */
	pages: string[];
	/** Real page/chapter count of the whole document (not capped by `pages.length`). */
	numPages: number;
	/** What one unit of `numPages`/`getPage` means: EPUB resolves by chapter,
	 *  PDF by physical page. (The UI never claims these are screen pages.) */
	unit: "page" | "chapter";
	/** EPUB only: label for each chapter, index 0 = first chapter. */
	chapterLabels?: string[];
	toc: { label: string; href: string }[];
	title: string;
	ext: string;
	isScanned: boolean;
	ocrCount: number;
	/** Reads any page/chapter by number, extracting (and caching) on demand. */
	getPage: (n: number) => Promise<string>;
};

const docTextCache = new Map<string, DocText>();
const rawPageCache = new Map<string, Map<number, string>>();

/** How many pages to extract up-front; the rest are lazily extracted by tools. */
const EAGER_PAGES = 80;

type PdfDocLike = {
	numPages: number;
	getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: { str?: string }[] }> }>;
	destroy?: () => Promise<void>;
};
const pdfDocCache = new Map<string, Promise<PdfDocLike>>();

function getPdfDoc(docId: string): Promise<PdfDocLike> {
	const cached = pdfDocCache.get(docId);
	if (cached) return cached;
	const p = (async () => {
		const dir = getDocDir(docId);
		const meta = JSON.parse(readFileSync(join(dir, "doc.json"), "utf-8"));
		const buf = readFileSync(join(dir, `original.${meta.ext}`));
		const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
			getDocument: (opts: { data: Uint8Array }) => { promise: Promise<PdfDocLike> };
		};
		return pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
	})().catch((e) => {
		pdfDocCache.delete(docId);
		throw e;
	});
	pdfDocCache.set(docId, p);
	return p;
}

/** Embedded (non-OCR) text of one page, cached per document. */
async function getRawPage(docId: string, pageNo: number): Promise<string> {
	const pages = rawPageCache.get(docId) ?? new Map<number, string>();
	rawPageCache.set(docId, pages);
	const hit = pages.get(pageNo);
	if (hit !== undefined) return hit;
	let text = "";
	try {
		const doc = await getPdfDoc(docId);
		const page = await doc.getPage(pageNo);
		const content = await page.getTextContent();
		text = content.items
			.map((it) => it.str ?? "")
			.join(" ")
			.slice(0, 4000);
	} catch (e) {
		console.error("[docText] page error", pageNo, e);
	}
	pages.set(pageNo, text);
	return text;
}

// --- OCR cache (second track for scanned pages) ---

function ocrFile(docId: string) {
	return join(getDocDir(docId), "ocr.json");
}
const ocrCache = new Map<string, Record<string, string>>();
export function readOcr(docId: string): Record<string, string> {
	const cached = ocrCache.get(docId);
	if (cached) return cached;
	const p = ocrFile(docId);
	let data: Record<string, string> = {};
	if (existsSync(p)) {
		try {
			data = JSON.parse(readFileSync(p, "utf-8"));
		} catch {
			data = {};
		}
	}
	ocrCache.set(docId, data);
	return data;
}
function writeOcr(docId: string, page: number, text: string) {
	const data = readOcr(docId);
	data[String(page)] = text;
	writeFileSync(ocrFile(docId), JSON.stringify(data, null, 2));
	// Force the assembled view (pages[] / isScanned / ocrCount) to be rebuilt lazily.
	docTextCache.delete(docId);
}

/** Second track: fall back to OCR wherever the embedded text layer is empty. */
function withOcr(docId: string, pageNo: number, raw: string): string {
	if (raw.trim()) return raw;
	return readOcr(docId)[String(pageNo)] ?? raw;
}

// --- EPUB label helpers ---

/** Collapse "." / ".." segments in a zip path (no leading slash expected). */
function normalizeZipPath(p: string): string {
	const out: string[] = [];
	for (const part of p.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return out.join("/");
}

function dirOfZipPath(p: string): string {
	const i = p.lastIndexOf("/");
	return i >= 0 ? p.slice(0, i) : "";
}

function decodeXmlEntities(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
	return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function getDocText(docId: string): Promise<DocText> {
	const cached = docTextCache.get(docId);
	if (cached !== undefined) return cached;
	const dir = getDocDir(docId);
	const meta = JSON.parse(readFileSync(join(dir, "doc.json"), "utf-8"));
	const ext = meta.ext as string;

	if (ext === "epub") {
		try {
			const JSZip = (await import("jszip")).default;
			const buf = readFileSync(join(dir, `original.${ext}`));
			const zip = await JSZip.loadAsync(buf);
			const containerXml = await zip.file("META-INF/container.xml")?.async("string");
			const rootfileMatch = containerXml?.match(/full-path="([^"]+)"/);
			const opfPath = rootfileMatch ? rootfileMatch[1] : "OEBPS/content.opf";
			const opfText = (await zip.file(opfPath)?.async("string")) ?? "";
			const baseDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

			// Manifest metadata, keyed by id. Attributes can appear in any order, so
			// each is read independently. (The previous NCX regex required media-type
			// before href, which calibre/EPUB2 files rarely use — so the TOC was never
			// found and chapters fell back to file names like "index_split_047".)
			const itemMeta = new Map<string, { href: string; type: string; properties: string }>();
			for (const m of opfText.matchAll(/<item\b[^>]*>/g)) {
				const tag = m[0];
				const id = tag.match(/\bid="([^"]+)"/)?.[1];
				const href = tag.match(/\bhref="([^"]+)"/)?.[1];
				if (!id || !href) continue;
				itemMeta.set(id, {
					href,
					type: tag.match(/\bmedia-type="([^"]+)"/)?.[1] ?? "",
					properties: tag.match(/\bproperties="([^"]+)"/)?.[1] ?? "",
				});
			}
			const spineHrefs = [...opfText.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)]
				.map((m) => itemMeta.get(m[1])?.href)
				.filter((h): h is string => !!h);
			const spineFull = spineHrefs.map((h) => normalizeZipPath(baseDir + h));

			// Extract text for every spine document. Keep the full text (not truncated)
			// so global character offsets are exact and monotonic across the book.
			// Also remember an in-document heading/title as a label fallback.
			const chapters: string[] = [];
			const fallbackLabels: string[] = [];
			for (const href of spineHrefs) {
				const content = (await zip.file(baseDir + href)?.async("string")) ?? "";
				const text = content
					.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
					.replace(/<[^>]+>/g, " ")
					.replace(/\s+/g, " ")
					.trim();
				chapters.push(text);
				const heading = content.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1];
				const title = content.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
				fallbackLabels.push(
					stripTags(decodeXmlEntities(heading ?? "")) || stripTags(decodeXmlEntities(title ?? "")),
				);
			}

			// Navigation document: NCX (EPUB2) or an XHTML nav doc (EPUB3). Prefer the
			// spine's `toc` reference, then the NCX media-type, then properties="nav".
			const spineTocId = opfText.match(/<spine\b[^>]*\btoc="([^"]+)"/)?.[1];
			const ncxItem = [...itemMeta.values()].find((it) => it.type === "application/x-dtbncx+xml");
			const navDocItem = [...itemMeta.values()].find((it) => /\bnav\b/.test(it.properties));
			const navHref = (spineTocId && itemMeta.get(spineTocId)?.href) || ncxItem?.href || navDocItem?.href;

			// Navigation entries as { label, src } in reading order. For NCX we pair
			// each navLabel with the next content src; nested navPoints are emitted
			// parent-first, which is exactly reading order.
			const navLabelByFull = new Map<string, string>();
			const navItems: { label: string; src: string }[] = [];
			if (navHref) {
				const navFull = normalizeZipPath(baseDir + navHref);
				const navDir = dirOfZipPath(navFull);
				const navDirPrefix = navDir ? `${navDir}/` : "";
				const navText = (await zip.file(navFull)?.async("string")) ?? "";
				if (/<navPoint\b/i.test(navText)) {
					const re =
						/<navLabel\b[^>]*>\s*<text\b[^>]*>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*\bsrc="([^"]+)"/gi;
					for (const m of navText.matchAll(re)) {
						const label = stripTags(decodeXmlEntities(m[1]));
						if (label) navItems.push({ label, src: m[2] });
					}
				} else {
					const navBlock =
						navText.match(/<nav\b[^>]*\b(?:epub:)?type="toc"[^>]*>[\s\S]*?<\/nav>/i)?.[0] ?? navText;
					for (const m of navBlock.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
						const label = stripTags(decodeXmlEntities(m[2]));
						if (label) navItems.push({ label, src: m[1] });
					}
				}
				// Map the first nav entry landing in each spine file to that file's
				// label. A spine file may contain several sections; the earliest wins.
				for (const it of navItems) {
					let src = it.src.split("#")[0];
					try { src = decodeURIComponent(src); } catch {}
					const full = normalizeZipPath(navDirPrefix + src);
					if (!navLabelByFull.has(full)) navLabelByFull.set(full, it.label);
				}
			}
			const toc = navItems.map((n) => ({ label: n.label, href: n.src }));
			const chapterLabels = spineFull.map((full, i) => {
				const nav = navLabelByFull.get(full);
				if (nav) return nav;
				if (fallbackLabels[i]) return fallbackLabels[i];
				return spineHrefs[i].split("/").pop()?.replace(/\.[^.]+$/, "") || `第 ${i + 1} 章`;
			});

			const result: DocText = {
				pages: chapters.slice(0, EAGER_PAGES),
				numPages: chapters.length,
				unit: "chapter",
				chapterLabels,
				toc,
				title: meta.title,
				ext,
				isScanned: false,
				ocrCount: 0,
				getPage: async (n) => chapters[Math.max(1, Math.min(chapters.length, n)) - 1] ?? "",
			};
			docTextCache.set(docId, result);
			return result;
		} catch (e) {
			console.error("[docText] epub error", e);
		}
	}

	try {
		const doc = await getPdfDoc(docId);
		const numPages = doc.numPages;
		const pages: string[] = [];
		let hasTextLayer = false;
		for (let i = 1; i <= Math.min(numPages, EAGER_PAGES); i++) {
			const raw = await getRawPage(docId, i);
			if (raw.trim()) hasTextLayer = true;
			pages.push(withOcr(docId, i, raw));
		}
		const result: DocText = {
			pages,
			numPages,
			unit: "page",
			toc: [],
			title: meta.title,
			ext,
			isScanned: numPages > 0 && !hasTextLayer,
			ocrCount: Object.keys(readOcr(docId)).length,
			getPage: async (n) => {
				const p = Math.max(1, Math.min(numPages, n));
				return withOcr(docId, p, await getRawPage(docId, p));
			},
		};
		docTextCache.set(docId, result);
		return result;
	} catch (e) {
		console.error("[docText] pdf error", e);
	}
	const fallback: DocText = {
		pages: [],
		numPages: 0,
		unit: "page",
		toc: [],
		title: meta.title,
		ext,
		isScanned: false,
		ocrCount: 0,
		getPage: async () => "",
	};
	docTextCache.set(docId, fallback);
	return fallback;
}

/** Release all in-memory caches for a document (used when it's deleted). */
export function clearDocCaches(docId: string) {
	const pdf = pdfDocCache.get(docId);
	if (pdf) {
		pdfDocCache.delete(docId);
		pdf.then((d) => d.destroy?.()).catch(() => {});
	}
	docTextCache.delete(docId);
	rawPageCache.delete(docId);
	ocrCache.delete(docId);
}

export function registerDocTextIpc() {
	ipcMain.handle("doc:ocr:get", (_e, docId: string) => readOcr(docId));
	ipcMain.handle("doc:ocr:save", (_e, docId: string, page: number, text: string) => writeOcr(docId, page, text));

	// Outline used by the renderer (e.g. the chat "@" mention picker): chapter
	// labels for EPUB, or just the unit/page count for PDF. Reuses the cached
	// getDocText() so it stays consistent with the AI tools.
	ipcMain.handle("doc:outline", async (_e, docId: string) => {
		const d = await getDocText(docId).catch(() => null);
		if (!d) return { unit: "page" as const, numPages: 0, chapterLabels: [] as string[], toc: [] as { label: string; href: string }[] };
		return { unit: d.unit, numPages: d.numPages, chapterLabels: d.chapterLabels ?? [], toc: d.toc };
	});

	ipcMain.handle("doc:path", (_e, docId: string) => {
		const dir = getDocDir(docId);
		if (!existsSync(join(dir, "doc.json"))) return null;
		const meta = JSON.parse(readFileSync(join(dir, "doc.json"), "utf-8"));
		return join(dir, `original.${meta.ext}`);
	});

	ipcMain.handle("doc:read", (_e, path: string) => {
		return readFileSync(path);
	});
}
