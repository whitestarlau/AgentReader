import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type TranscriptRow = {
	id?: string;
	role?: string;
	content?: string;
	[key: string]: unknown;
};

export function readTranscript(path: string): TranscriptRow[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TranscriptRow);
}

export function writeTranscript(path: string, rows: TranscriptRow[]): void {
	writeFileSync(path, rows.length ? `${rows.map((r) => JSON.stringify(r)).join("\n")}\n` : "");
}

/** Replace a user turn and drop everything after it (so the reply can be regenerated). */
export function editTranscript(
	path: string,
	messageId: string,
	content: string,
): { ok: boolean; error?: string; rows?: TranscriptRow[] } {
	if (!existsSync(path)) return { ok: false, error: "对话不存在" };
	const rows = readTranscript(path);
	const idx = rows.findIndex((r) => r.id === messageId);
	if (idx < 0) return { ok: false, error: "未找到该消息" };
	if (rows[idx].role !== "user") return { ok: false, error: "只能编辑用户消息" };
	rows[idx] = { ...rows[idx], content, editedAt: Date.now() };
	const kept = rows.slice(0, idx + 1);
	writeTranscript(path, kept);
	return { ok: true, rows: kept };
}
