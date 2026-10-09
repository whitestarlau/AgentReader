import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ipcMain } from "electron";
import { getDocDir } from "./paths.ts";
import { editTranscript } from "./transcript.ts";

/**
 * Conversation index + per-conversation JSONL transcripts under
 * `library/{docId}/conversations.json` and `library/{docId}/chats/*.jsonl`.
 */

export function conversationsFile(docId: string) {
	return join(getDocDir(docId), "conversations.json");
}

export function chatFile(docId: string, convId: string) {
	return join(getDocDir(docId), "chats", `${convId}.jsonl`);
}

export function ensureConversations(docId: string) {
	const dir = getDocDir(docId);
	const convFile = conversationsFile(docId);
	const chatsDir = join(dir, "chats");
	mkdirSync(chatsDir, { recursive: true });
	if (!existsSync(convFile)) {
		const oldPath = join(dir, "chats.jsonl");
		if (existsSync(oldPath)) {
			const id = randomUUID();
			const oldContent = readFileSync(oldPath, "utf-8");
			writeFileSync(join(chatsDir, `${id}.jsonl`), oldContent);
			writeFileSync(
				convFile,
				JSON.stringify(
					[{ id, title: "默认对话", createdAt: Date.now(), updatedAt: Date.now() }],
					null,
					2,
				),
			);
			unlinkSync(oldPath);
			return [{ id, title: "默认对话", createdAt: Date.now(), updatedAt: Date.now() }];
		}
		writeFileSync(convFile, JSON.stringify([], null, 2));
		return [];
	}
	return JSON.parse(readFileSync(convFile, "utf-8"));
}

export function saveConversations(docId: string, list: unknown) {
	writeFileSync(conversationsFile(docId), JSON.stringify(list, null, 2));
}

/** Append one transcript entry with a stable id; returns the stored entry id. */
export function appendChatEntry(
	docId: string,
	convId: string,
	entry: Record<string, unknown>,
): { id: string; timestamp: number } {
	const p = chatFile(docId, convId);
	mkdirSync(join(getDocDir(docId), "chats"), { recursive: true });
	const full = { id: randomUUID(), timestamp: Date.now(), ...entry };
	appendFileSync(p, `${JSON.stringify(full)}\n`);
	const list = ensureConversations(docId);
	const conv = list.find((c: { id: string }) => c.id === convId);
	if (conv) {
		conv.updatedAt = Date.now();
		saveConversations(docId, list);
	}
	return { id: full.id as string, timestamp: full.timestamp as number };
}

export function registerConversationIpc() {
	ipcMain.handle("conversations:list", (_e, docId: string) => ensureConversations(docId));
	ipcMain.handle("conversations:create", (_e, docId: string, title?: string) => {
		const list = ensureConversations(docId);
		const conv = {
			id: randomUUID(),
			title: title || `对话 ${list.length + 1}`,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		list.unshift(conv);
		saveConversations(docId, list);
		writeFileSync(chatFile(docId, conv.id), "");
		return conv;
	});
	ipcMain.handle("conversations:delete", (_e, docId: string, convId: string) => {
		const list = ensureConversations(docId);
		const next = list.filter((c: { id: string }) => c.id !== convId);
		saveConversations(docId, next);
		const p = chatFile(docId, convId);
		if (existsSync(p)) rmSync(p, { force: true });
		return next;
	});
	ipcMain.handle("conversations:rename", (_e, docId: string, convId: string, title: string) => {
		const list = ensureConversations(docId);
		const conv = list.find((c: { id: string }) => c.id === convId);
		if (conv) {
			conv.title = title;
			conv.updatedAt = Date.now();
			saveConversations(docId, list);
		}
		return conv;
	});

	ipcMain.handle("chat:list", (_e, docId: string, convId?: string) => {
		if (!convId) {
			const list = ensureConversations(docId);
			if (list.length === 0) return [];
			convId = list[0].id;
		}
		const p = chatFile(docId, convId as string);
		if (!existsSync(p)) return [];
		const raw = readFileSync(p, "utf-8").trim();
		if (!raw) return [];
		return raw
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	});

	ipcMain.handle("chat:append", (_e, docId: string, convId: string, entry: unknown) => {
		if (!convId) return;
		const stored = appendChatEntry(docId, convId, (entry as Record<string, unknown>) ?? {});
		const list = ensureConversations(docId);
		const conv = list.find((c: { id: string }) => c.id === convId);
		if (conv && (!conv.title || conv.title.startsWith("对话 "))) {
			const firstText = (entry as { content?: string })?.content?.slice(0, 20);
			if (firstText) {
				conv.title = firstText;
				saveConversations(docId, list);
			}
		}
		return stored;
	});

	ipcMain.handle(
		"chat:edit",
		(_e, docId: string, convId: string, messageId: string, content: string) => {
			const result = editTranscript(chatFile(docId, convId), messageId, content);
			if (result.ok) {
				const list = ensureConversations(docId);
				const conv = list.find((c: { id: string }) => c.id === convId);
				if (conv) {
					conv.updatedAt = Date.now();
					saveConversations(docId, list);
				}
			}
			return result;
		},
	);
}
