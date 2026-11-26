import type { StoredConflict } from "./conflicts.ts";
import type { DocPort } from "./engine.ts";
import type { Stamp } from "./types.ts";

/**
 * 「用户在冲突面板里选了哪一边」的落地逻辑。
 *
 * 抽成纯函数是为了可测：它要处理四种形态（记录 / 消息行 / 位置 / 章节）与两种选择
 * （改值 / 删除），而且消息行必须写回**正确的对话**——这些都是靠肉眼最容易漏的地方。
 */

/** 把用户的选择应用到本机设置：`undefined` 表示「这一边把它删了」。 */
export function applySettingsChoice(
	raw: Record<string, string>,
	key: string,
	value: string | undefined,
): Record<string, string> {
	const next = { ...raw };
	if (value === undefined) delete next[key];
	else next[key] = value;
	return next;
}

/**
 * 把用户的选择应用到某本书。
 * 选择的值会带上**新的时间戳**：否则下一轮合并还会把它判成「又冲突一次」。
 */
export function applyDocChoice(opts: {
	port: DocPort;
	conflict: StoredConflict;
	value: string | undefined;
	stamp: Stamp;
}): boolean {
	const docId = opts.conflict.docId;
	if (!docId) return false;
	const state = opts.port.read(docId);
	if (!state) return false;

	const parsed =
		opts.value === undefined ? undefined : (JSON.parse(opts.value) as Record<string, unknown>);
	const stamped = parsed
		? { ...parsed, updatedAt: opts.stamp.at, deviceId: opts.stamp.dev }
		: undefined;

	const replaceIn = (rows: Record<string, unknown>[]): Record<string, unknown>[] => {
		const rest = rows.filter((row) => row.id !== opts.conflict.key);
		return stamped ? [...rest, stamped] : rest;
	};

	switch (opts.conflict.kind) {
		case "annotation":
			state.annotations = replaceIn(state.annotations);
			break;
		case "conversation":
			state.conversations = replaceIn(state.conversations);
			break;
		case "chat": {
			const convId = opts.conflict.convId ?? "";
			if (!convId) return false;
			const next = replaceIn(state.chats[convId] ?? []);
			if (next.length > 0) state.chats[convId] = next;
			else delete state.chats[convId];
			break;
		}
		case "position": {
			const value = parsed as { page?: unknown; location?: unknown } | undefined;
			state.position = {
				page: typeof value?.page === "number" ? value.page : null,
				location: typeof value?.location === "string" ? value.location : null,
				at: opts.stamp.at,
				dev: opts.stamp.dev,
			};
			break;
		}
		case "chapter": {
			const value = parsed as { value?: unknown } | undefined;
			state.chapter = {
				value: typeof value?.value === "number" ? value.value : null,
				at: opts.stamp.at,
				dev: opts.stamp.dev,
			};
			break;
		}
		default:
			return false;
	}

	opts.port.write(docId, state);
	return true;
}
