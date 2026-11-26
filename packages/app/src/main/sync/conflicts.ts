import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DocConflict } from "./merge-records.ts";
import type { Conflict } from "./types.ts";

/**
 * 待处理的冲突仓库。
 *
 * 为什么需要它：合并只是「选出赢家」，但用户有权利把输掉的值拿回来。要支持「选边」，
 * 就必须把**双方的值**存下来 —— 否则下一次同步一收敛，输掉的那份就永久消失了。
 *
 * 每次同步成功后整体重写：某条冲突如果在新一轮里自然消失（对方也改成了同一个值），
 * 它就不该继续挂在界面上。
 */

export type ConflictScope = "settings" | "doc";

export type StoredConflict = {
	/** `settings:<key>` 或 `doc:<docId>:<kind>:<key>` */
	id: string;
	scope: ConflictScope;
	kind: DocConflict["kind"] | "settings";
	docId?: string;
	key: string;
	convId?: string;
	/** 人类可读的标签，例如「OCR 语言」「《xxx》的标注」 */
	label: string;
	local?: string;
	remote?: string;
	at: number;
};

export type ConflictStore = {
	read(): StoredConflict[];
	write(list: StoredConflict[]): void;
	/** 只保留本次同步仍然存在的冲突（顺带清掉已经自然收敛的） */
	replaceWith(list: StoredConflict[]): void;
};

const SETTINGS_LABELS: Record<string, string> = {
	ocrLang: "OCR 语言",
	agentMaxTurns: "对话最大轮数",
	webSearchEnabled: "联网搜索开关",
	webSearchBackend: "联网搜索后端",
	webSearchMaxResults: "联网搜索条数",
	skillsExecutionEnabled: "技能执行开关",
	ttsEngine: "朗读引擎",
	ttsModel: "朗读模型",
	ttsLang: "朗读语言",
	ttsRate: "朗读语速",
	ttsMaxChars: "单次朗读字数",
	ttsCacheMb: "朗读缓存上限",
	ttsEndpoint: "朗读服务地址",
	theme: "主题",
};

export function settingsLabel(key: string): string {
	if (SETTINGS_LABELS[key]) return SETTINGS_LABELS[key];
	if (key.startsWith("ttsVoice:")) return `朗读音色（${key.slice("ttsVoice:".length)}）`;
	return key;
}

export function conflictId(conflict: Omit<StoredConflict, "id">): string {
	if (conflict.scope === "settings") return `settings:${conflict.key}`;
	return `doc:${conflict.docId ?? ""}:${conflict.kind}:${conflict.convId ?? ""}:${conflict.key}`;
}

/** 把一次同步的冲突转成可持久化、可展示的条目。 */
export function toStoredConflicts(input: {
	settings: Conflict[];
	docs: DocConflict[];
	titleOf: (docId: string) => string;
	now?: number;
}): StoredConflict[] {
	const at = input.now ?? Date.now();
	const out: StoredConflict[] = [];
	for (const conflict of input.settings) {
		const base = {
			scope: "settings" as const,
			kind: "settings" as const,
			key: conflict.key,
			label: settingsLabel(conflict.key),
			local: conflict.local,
			remote: conflict.remote,
			at,
		};
		out.push({ ...base, id: conflictId(base) });
	}
	for (const conflict of input.docs) {
		const title = input.titleOf(conflict.docId) || conflict.docId;
		const base = {
			scope: "doc" as const,
			kind: conflict.kind,
			docId: conflict.docId,
			key: conflict.key,
			convId: conflict.convId,
			label: `${title} · ${kindLabel(conflict.kind)}`,
			local: conflict.local,
			remote: conflict.remote,
			at,
		};
		out.push({ ...base, id: conflictId(base) });
	}
	return out;
}

function kindLabel(kind: DocConflict["kind"]): string {
	switch (kind) {
		case "annotation":
			return "标注";
		case "conversation":
			return "对话";
		case "chat":
			return "对话消息";
		case "position":
			return "阅读位置";
		case "chapter":
			return "当前章节";
	}
}

export function createConflictStore(file: string): ConflictStore {
	const read = (): StoredConflict[] => {
		if (!existsSync(file)) return [];
		try {
			const parsed = JSON.parse(readFileSync(file, "utf-8"));
			if (!Array.isArray(parsed)) return [];
			return parsed.filter(
				(entry): entry is StoredConflict =>
					typeof entry === "object" &&
					entry !== null &&
					typeof (entry as StoredConflict).id === "string" &&
					((entry as StoredConflict).scope === "settings" ||
						(entry as StoredConflict).scope === "doc"),
			);
		} catch {
			return [];
		}
	};
	const write = (list: StoredConflict[]): void => {
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, JSON.stringify(list, null, 2));
		renameSync(tmp, file);
	};
	return {
		read,
		write,
		replaceWith(list) {
			write(list);
		},
	};
}
