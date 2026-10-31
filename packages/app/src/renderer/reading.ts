/**
 * Per-document reading position, persisted in localStorage so a document
 * reopens where the reader left off. EPUB stores a section href + in-section
 * scroll offset; PDF stores the (1-based) page number. Failures are ignored
 * (e.g. disabled storage).
 */

function pageKey(docId: string) {
	return `reading.page.${docId}`;
}
function pdfKey(docId: string) {
	return `reading.pdf.${docId}`;
}
function cfiKey(docId: string) {
	return `reading.cfi.${docId}`;
}
function locKey(docId: string) {
	return `reading.loc.${docId}`;
}

/**
 * PDF reading position. `offset` is the fraction of the page that had been
 * scrolled past (0 = page top, 1 = page bottom), so continuous mode can resume
 * mid-page even when the window/zoom changed since the last session.
 */
export type PdfLocation = { page: number; offset: number };

export function loadPdfLocation(docId: string): PdfLocation | null {
	try {
		const raw = localStorage.getItem(pdfKey(docId));
		if (raw) {
			const o = JSON.parse(raw) as { page?: unknown; offset?: unknown };
			const page = typeof o.page === "number" && Number.isFinite(o.page) ? Math.floor(o.page) : 0;
			const offset = typeof o.offset === "number" && Number.isFinite(o.offset) ? o.offset : 0;
			if (page >= 1) return { page, offset: Math.min(1, Math.max(0, offset)) };
		}
	} catch {
		// fall through to the legacy page-only location
	}
	const legacy = loadReadingPage(docId);
	return legacy ? { page: legacy, offset: 0 } : null;
}

export function savePdfLocation(docId: string, loc: PdfLocation) {
	try {
		if (loc.page < 1) return;
		localStorage.setItem(
			pdfKey(docId),
			JSON.stringify({
				t: "pdf",
				page: Math.floor(loc.page),
				offset: Math.min(1, Math.max(0, loc.offset)),
			}),
		);
	} catch {}
}

/**
 * EPUB location. Stored instead of a raw CFI because epub.js paginated mode
 * maps a CFI back to a different page than the one it was read from
 * (currentLocation().start.cfi re-displayed lands one page earlier), which
 * made the reader resume / re-layout at the wrong spot. href + scroll offset
 * round-trips exactly.
 */
export type EpubLocation = { href: string; offset: number };

/** Parse a serialized location. Accepts the new JSON form and plain CFIs. */
export function parseEpubLocation(raw: string | null | undefined): EpubLocation | null {
	if (!raw) return null;
	const s = raw.trim();
	if (s.startsWith("{")) {
		try {
			const o = JSON.parse(s) as { href?: unknown; offset?: unknown };
			if (
				typeof o.href === "string" &&
				o.href &&
				typeof o.offset === "number" &&
				Number.isFinite(o.offset)
			) {
				return { href: o.href, offset: Math.max(0, Math.floor(o.offset)) };
			}
		} catch {}
		return null;
	}
	return null;
}

export function serializeEpubLocation(loc: EpubLocation): string {
	return JSON.stringify({ t: "epub", href: loc.href, offset: Math.max(0, Math.floor(loc.offset)) });
}

export function loadReadingLoc(docId: string): EpubLocation | null {
	try {
		return parseEpubLocation(localStorage.getItem(locKey(docId)));
	} catch {
		return null;
	}
}

export function saveReadingLoc(docId: string, loc: EpubLocation) {
	try {
		if (loc.href) localStorage.setItem(locKey(docId), serializeEpubLocation(loc));
	} catch {}
}

export function loadReadingPage(docId: string): number | null {
	try {
		const raw = localStorage.getItem(pageKey(docId));
		if (!raw) return null;
		const n = Number(raw);
		return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
	} catch {
		return null;
	}
}

export function saveReadingPage(docId: string, page: number) {
	try {
		if (page >= 1) localStorage.setItem(pageKey(docId), String(Math.floor(page)));
	} catch {}
}

export function loadReadingCfi(docId: string): string | null {
	try {
		return localStorage.getItem(cfiKey(docId));
	} catch {
		return null;
	}
}

export function saveReadingCfi(docId: string, cfi: string) {
	try {
		if (cfi) localStorage.setItem(cfiKey(docId), cfi);
	} catch {}
}
