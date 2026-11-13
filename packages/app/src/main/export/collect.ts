import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExportBundle, ExportConversation, TranscriptRow } from "../../shared/chat-export.ts";
import { stripExt } from "../../shared/chat-export.ts";
import { chatFile, ensureConversations } from "../conversations.ts";
import { getDocDir } from "../paths.ts";

/** `doc.json` is written by `library:import`; other fields are tolerated. */
export type DocMeta = {
	id: string;
	title: string;
	ext: string;
	hash?: string;
	[key: string]: unknown;
};

type ConversationIndexRow = {
	id: string;
	title?: string;
	createdAt?: number;
	updatedAt?: number;
};

export function readDocMeta(docId: string): DocMeta {
	const path = join(getDocDir(docId), "doc.json");
	if (!existsSync(path)) throw new Error("文档不存在或已被删除");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		throw new Error("文档元数据损坏（doc.json）");
	}
	if (!parsed || typeof parsed !== "object") throw new Error("文档元数据损坏（doc.json）");
	const meta = parsed as DocMeta;
	if (typeof meta.title !== "string" || typeof meta.ext !== "string") {
		throw new Error("文档元数据缺少标题或类型");
	}
	return meta;
}

/**
 * Read the current conversation from disk into the export bundle. Only the
 * selected conversation is exported; `conversations.json` is the authority for
 * ids and titles, so a stale renderer id can never escape the chats directory.
 */
export function collectBundle(doc: DocMeta, convId: string, appVersion: string): ExportBundle {
	let list: ConversationIndexRow[];
	try {
		list = ensureConversations(doc.id) as ConversationIndexRow[];
	} catch {
		throw new Error("对话索引损坏（conversations.json）");
	}
	const conv = list.find((item) => item.id === convId);
	if (!conv) throw new Error("对话不存在或已被删除");

	const conversation: ExportConversation = {
		id: conv.id,
		title: conv.title || "未命名对话",
		createdAt: conv.createdAt,
		updatedAt: conv.updatedAt,
		messages: readTranscriptLenient(chatFile(doc.id, conv.id)),
	};

	return {
		format: "agentreader.conversation-export",
		version: 1,
		exportedAt: new Date().toISOString(),
		generator: { app: "AgentReader", version: appVersion },
		scope: "current",
		document: {
			id: doc.id,
			title: doc.title,
			name: stripExt(doc.title),
			ext: doc.ext,
			...(doc.hash ? { hash: doc.hash } : {}),
		},
		conversations: [conversation],
	};
}

/**
 * Export is best-effort: one malformed JSONL line (e.g. a partially flushed
 * append) must not make the whole conversation unexportable. `chat:edit` keeps
 * using the strict reader in `transcript.ts`.
 */
export function readTranscriptLenient(path: string): TranscriptRow[] {
	if (!existsSync(path)) return [];
	const rows: TranscriptRow[] = [];
	for (const [index, line] of readFileSync(path, "utf-8").split("\n").entries()) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				rows.push(parsed as TranscriptRow);
			}
		} catch {
			console.warn(`[export] skip malformed transcript line ${index + 1}: ${path}`);
		}
	}
	return rows;
}
