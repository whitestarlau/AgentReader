import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DocPort } from "./engine.ts";
import type { DocState } from "./merge-records.ts";

/**
 * 「书库目录 ↔ 同步状态」的映射。
 *
 * 本机一本书散落在五个文件里（`doc.json` / `annotations.json` / `reader-chapter.json` /
 * `conversations.json` / `chats/*.jsonl`），而同步体是**一个** `DocState`。这个模块就是
 * 两者之间的翻译层 —— 它不做合并，只做「读出 / 写回」，保证：
 * - 写回时**保留机器相关字段**（`importedAt`、`originalPath`、`hash`），只覆盖同步字段；
 * - 不存在 doc.json 的目录不算一本书（跳过，绝不误删）。
 *
 * 目录来源可注入（`dirOf`），所以能用临时目录单测。
 */

function readJson(file: string): unknown {
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf-8"));
	} catch {
		return undefined;
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const rows = (value: unknown): Record<string, unknown>[] =>
	Array.isArray(value)
		? value.filter(
				(row): row is Record<string, unknown> =>
					isRecord(row) && typeof (row as { id?: unknown }).id === "string",
			)
		: [];

function readChatRows(file: string): Record<string, unknown>[] {
	if (!existsSync(file)) return [];
	try {
		return readFileSync(file, "utf-8")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line) as unknown;
				} catch {
					return undefined;
				}
			})
			.filter(
				(row): row is Record<string, unknown> =>
					isRecord(row) && typeof (row as { id?: unknown }).id === "string",
			);
	} catch {
		return [];
	}
}

export function createDocPort(opts: {
	dirOf: (docId: string) => string;
	/** 书库根下的书籍 id 列表（由调用方提供，避免把书库根目录结构写进这个模块） */
	listDocIds: () => string[];
}): DocPort {
	const fileIn = (docId: string, name: string) => join(opts.dirOf(docId), name);

	return {
		list() {
			// 只有存在 doc.json 的目录才算一本书：半成品目录、缓存目录都不参与同步
			return opts.listDocIds().filter((docId) => existsSync(fileIn(docId, "doc.json")));
		},

		read(docId) {
			const dir = opts.dirOf(docId);
			const meta = readJson(join(dir, "doc.json"));
			if (!isRecord(meta)) return null;

			const annotations = rows(readJson(join(dir, "annotations.json")));
			const chapterRaw = readJson(join(dir, "reader-chapter.json"));
			const chapter = isRecord(chapterRaw) ? chapterRaw : {};
			const conversations = rows(readJson(join(dir, "conversations.json")));

			const chatDir = join(dir, "chats");
			const chats: Record<string, Record<string, unknown>[]> = {};
			if (existsSync(chatDir)) {
				for (const name of readdirSync(chatDir)) {
					if (!name.endsWith(".jsonl") || name.startsWith(".")) continue;
					const convId = name.slice(0, -".jsonl".length);
					const rowsInFile = readChatRows(join(chatDir, name));
					if (rowsInFile.length > 0) chats[convId] = rowsInFile;
				}
			}

			return {
				schema: 1,
				docId,
				title: typeof meta.title === "string" ? meta.title : "",
				ext: typeof meta.ext === "string" ? meta.ext : "pdf",
				position: {
					page: typeof meta.lastPage === "number" ? meta.lastPage : null,
					location: typeof meta.lastLocation === "string" ? meta.lastLocation : null,
					at: typeof meta.positionUpdatedAt === "number" ? meta.positionUpdatedAt : 0,
					dev: typeof meta.positionDevice === "string" ? meta.positionDevice : "",
				},
				chapter: {
					value: typeof chapter.chapter === "number" ? chapter.chapter : null,
					at: typeof chapter.at === "number" ? chapter.at : 0,
					dev: typeof chapter.dev === "string" ? chapter.dev : "",
				},
				annotations,
				conversations,
				chats,
			} satisfies DocState;
		},

		remove(docId) {
			// 按云端墓碑删除本机副本：目录整个删掉，缓存由调用方清理
			const dir = opts.dirOf(docId);
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		},

		write(docId, state) {
			const dir = opts.dirOf(docId);
			mkdirSync(dir, { recursive: true });

			// doc.json：逐字段覆盖同步字段，其余（importedAt / originalPath / hash）原样保留
			const meta = readJson(join(dir, "doc.json"));
			const nextMeta: Record<string, unknown> = isRecord(meta) ? { ...meta } : {};
			nextMeta.id = docId;
			if (state.title) nextMeta.title = state.title;
			if (state.ext) nextMeta.ext = state.ext;
			if (state.position.page !== null) nextMeta.lastPage = state.position.page;
			if (state.position.location !== null) nextMeta.lastLocation = state.position.location;
			nextMeta.positionUpdatedAt = state.position.at;
			nextMeta.positionDevice = state.position.dev;
			writeJson(join(dir, "doc.json"), nextMeta);

			writeJson(join(dir, "annotations.json"), state.annotations);
			writeJson(join(dir, "reader-chapter.json"), {
				chapter: state.chapter.value ?? 1,
				at: state.chapter.at,
				dev: state.chapter.dev,
			});
			writeJson(join(dir, "conversations.json"), state.conversations);

			const chatDir = join(dir, "chats");
			mkdirSync(chatDir, { recursive: true });
			for (const [convId, messages] of Object.entries(state.chats)) {
				writeFileSync(
					join(chatDir, `${convId}.jsonl`),
					messages.length ? `${messages.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
				);
			}
		},
	};
}

function writeJson(file: string, data: unknown): void {
	writeFileSync(file, JSON.stringify(data, null, 2));
}
