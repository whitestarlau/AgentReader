/**
 * Pure helpers shared by the export IPC (main) and the export dialog (renderer).
 *
 * Nothing here may import `electron` or `node:fs`: the renderer bundles this
 * module too. Keep it to data shapes, prompt parsing, filenames and formatting.
 */

export type ExportFormat = "md" | "html" | "json";

export type ExportOptions = {
	format: ExportFormat;
	/** Include the citation blocks stored at the top of a user message. */
	includeRefs: boolean;
	/** Include model reasoning items from `timeline`. */
	includeReasoning: boolean;
	/** Include tool names and their JSON arguments. */
	includeTools: boolean;
	/** Include (truncated) tool results. */
	includeToolResults: boolean;
	/** Open the saved file with the system default application. */
	openAfter: boolean;
};

export type ExportRequest = {
	docId: string;
	convId: string;
	options?: Partial<ExportOptions>;
};

export type ExportResult =
	| {
			ok: true;
			path: string;
			format: ExportFormat;
			bytes: number;
			messages: number;
	  }
	| { ok: false; canceled?: true; error?: string };

export type ExportTimelineItem =
	| { kind: "reasoning"; content: string }
	| {
			kind: "tool";
			id?: string;
			name: string;
			args: string;
			result?: string;
			pending?: boolean;
	  };

/** One raw JSONL row. Fields stay loose so old transcripts remain exportable. */
export type TranscriptRow = {
	id?: string;
	timestamp?: number;
	role?: string;
	content?: string;
	timeline?: ExportTimelineItem[];
	notice?: string;
	[key: string]: unknown;
};

export type ExportConversation = {
	id: string;
	title: string;
	createdAt?: number;
	updatedAt?: number;
	messages: TranscriptRow[];
};

export type ExportBundle = {
	format: "agentreader.conversation-export";
	version: 1;
	exportedAt: string;
	generator: { app: "AgentReader"; version: string };
	scope: "current";
	document: {
		id: string;
		/** Original filename, extension included. */
		title: string;
		/** Display title, extension removed. */
		name: string;
		ext: string;
		hash?: string;
	};
	conversations: ExportConversation[];
};

export type RefBlock = { header: string; body: string };

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
	format: "md",
	includeRefs: true,
	includeReasoning: false,
	includeTools: true,
	includeToolResults: false,
	openAfter: false,
};

export function isExportFormat(value: unknown): value is ExportFormat {
	return value === "md" || value === "html" || value === "json";
}

/** Clamp untrusted renderer input to the supported shape and defaults. */
export function normalizeExportOptions(input?: Partial<ExportOptions>): ExportOptions {
	return {
		format: isExportFormat(input?.format) ? input.format : DEFAULT_EXPORT_OPTIONS.format,
		includeRefs: input?.includeRefs !== false,
		includeReasoning: input?.includeReasoning === true,
		includeTools: input?.includeTools !== false,
		includeToolResults: input?.includeToolResults === true,
		openAfter: input?.openAfter === true,
	};
}

/**
 * Split a persisted user message into citation blocks and the actual question.
 * Mirrors the renderer's `ChatPanel.parseUserPrompt()` exactly: the prompt sent
 * to the model is `【引用…】\n<body>\n\n【问题】\n<question>`.
 */
export function parseUserPrompt(content: string): { refs: RefBlock[]; question: string } {
	const text = normalizeNewlines(String(content ?? ""));
	const marker = "\n\n【问题】\n";
	const qi = text.indexOf(marker);
	if (qi < 0) return { refs: [], question: text };

	const refsPart = text.slice(0, qi);
	const question = text.slice(qi + marker.length);
	const refs: RefBlock[] = [];
	for (const chunk of refsPart.split(/\n\n(?=【引用)/)) {
		const nl = chunk.indexOf("\n");
		const header = (nl >= 0 ? chunk.slice(0, nl) : chunk).trim();
		const body = nl >= 0 ? chunk.slice(nl + 1).replace(/\s+$/, "") : "";
		if (header.startsWith("【引用")) refs.push({ header, body });
	}
	return { refs, question };
}

/** `【引用文本 · 第 12 页】` -> `引用文本 · 第 12 页` for display headings. */
export function refTitle(header: string): string {
	return oneLine(header)
		.replace(/^【|】$/g, "")
		.trim();
}

export function oneLine(value: string): string {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Valid YAML double-quoted scalar (JSON strings are valid YAML strings). */
export function yamlString(value: string): string {
	return JSON.stringify(oneLine(value));
}

export function stripExt(filename: string): string {
	const i = filename.lastIndexOf(".");
	return i > 0 ? filename.slice(0, i) : filename;
}

export function normalizeNewlines(value: string): string {
	return String(value ?? "").replace(/\r\n?/g, "\n");
}

/** Local `YYYY-MM-DD HH:mm`; empty for missing/invalid timestamps. */
export function formatLocal(ts?: number): string {
	if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
		d.getMinutes(),
	)}`;
}

/** Local `HH:mm`; empty for missing/invalid timestamps. */
export function formatTime(ts?: number): string {
	if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `2026-11-03T22:11:32+08:00` (local offset), used in Markdown frontmatter. */
export function formatIsoWithOffset(date = new Date()): string {
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const abs = Math.abs(offset);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
		date.getHours(),
	)}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(
		abs % 60,
	)}`;
}

/** File-friendly timestamp, e.g. `20261103-2211`. */
export function formatFileStamp(date = new Date()): string {
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
		date.getHours(),
	)}${pad(date.getMinutes())}`;
}

/**
 * Choose a code-fence longer than any backtick run in `text`, so embedded
 * Markdown samples cannot close the fence early.
 */
export function fence(text: string, lang = "text"): string {
	const runs = String(text ?? "").match(/`+/g) ?? [];
	let size = 3;
	for (const run of runs) size = Math.max(size, run.length + 1);
	const marker = "`".repeat(size);
	return `${marker}${lang}\n${normalizeNewlines(text).replace(/\s+$/, "")}\n${marker}`;
}

/** Timeline items selected by the user's include-* options. */
export function visibleTimelineItems(
	timeline: ExportTimelineItem[] | undefined,
	opts: Pick<ExportOptions, "includeReasoning" | "includeTools">,
): ExportTimelineItem[] {
	return (Array.isArray(timeline) ? timeline : []).filter((item) => {
		if (item.kind === "reasoning") return opts.includeReasoning;
		return opts.includeTools;
	});
}

/** Pretty-print tool JSON arguments; fall back to raw text when invalid. */
export function prettyToolArgs(args: string | undefined): { text: string; lang: "json" | "text" } {
	const raw = String(args ?? "").trim();
	if (!raw) return { text: "", lang: "text" };
	try {
		return { text: JSON.stringify(JSON.parse(raw), null, 2), lang: "json" };
	} catch {
		return { text: raw, lang: "text" };
	}
}

/** Truncate long tool output for Markdown/HTML; JSON keeps the original. */
export function clipText(text: string, max = 4000): string {
	const value = String(text ?? "");
	if (value.length <= max) return value;
	return `${value.slice(0, max)}\n…（已截断，原长 ${value.length} 字符）`;
}

export function extForFormat(format: ExportFormat): string {
	return format;
}

export function formatFromPath(path: string): ExportFormat | null {
	const match = /\.([a-z0-9]+)$/i.exec(path);
	switch (match?.[1]?.toLowerCase()) {
		case "md":
		case "markdown":
			return "md";
		case "html":
		case "htm":
			return "html";
		case "json":
			return "json";
		default:
			return null;
	}
}

/** Keep a recognised extension; otherwise append the requested one. */
export function ensureExtension(path: string, format: ExportFormat): string {
	const current = formatFromPath(path);
	if (current === format) return path;
	if (current) {
		return path.replace(/\.(md|markdown|html|htm|json)$/i, `.${extForFormat(format)}`);
	}
	return `${path}.${extForFormat(format)}`;
}

/**
 * Cross-platform filename sanitizer.
 *
 * - removes C0 controls and the characters illegal on Windows/macOS;
 * - folds whitespace, trims leading/trailing dots/spaces;
 * - prefixes Windows reserved device names;
 * - truncates by UTF-8 bytes, not characters: CJK is 3 bytes, so a "120
 *   character" cap would exceed APFS' 255-byte filename limit.
 */
export function sanitizeFilename(name: string, maxBytes = 180): string {
	let value = [...String(name ?? "").normalize("NFC")]
		.filter((char) => {
			const code = char.codePointAt(0) ?? 0;
			return code >= 0x20 && code !== 0x7f;
		})
		.join("")
		.replace(/[\\/:*?"<>|]/g, "-")
		.replace(/\s+/g, " ")
		.replace(/-{2,}/g, "-")
		.replace(/^[.\s]+|[.\s]+$/g, "");

	if (!value) value = "conversation";
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = `_${value}`;

	value = truncateUtf8(value, maxBytes).replace(/[.\s]+$/g, "");
	return value || "conversation";
}

/** `AgentReader-<doc>-<conversation>-<stamp>.<ext>` */
export function defaultExportFileName(
	docTitle: string,
	conversationTitle: string,
	format: ExportFormat,
	date = new Date(),
): string {
	const ext = extForFormat(format);
	const stamp = formatFileStamp(date);
	const raw = `AgentReader-${stripExt(docTitle)}-${conversationTitle || "对话"}-${stamp}`;
	// Reserve room for the dot and extension so the whole component stays <= 180 bytes.
	const name = sanitizeFilename(raw, Math.max(32, 180 - ext.length - 1));
	return `${name}.${ext}`;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function truncateUtf8(value: string, maxBytes: number): string {
	const encoder = new TextEncoder();
	if (encoder.encode(value).length <= maxBytes) return value;
	let out = "";
	let bytes = 0;
	for (const char of value) {
		const size = encoder.encode(char).length;
		if (bytes + size > maxBytes) break;
		out += char;
		bytes += size;
	}
	return out;
}
