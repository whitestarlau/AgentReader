import { compareStamps } from "./clock.ts";
import type { Stamp } from "./types.ts";

/**
 * 一本书的同步状态（对应远端 `state/{docId}.json`）。
 *
 * 对话正文内联在 `chats` 里：每本书一次 GET/PUT 就能拿到「位置 + 标注 + 对话」全部内容，
 * 请求数从「1 + N」降到「1」——这是坚果云 600 请求 / 30 分钟配额下最关键的一条。
 */
export type DocState = {
	schema: 1;
	docId: string;
	/** 远端每次写入 +1；只用于「要不要拉」的判断，不参与合并 */
	rev?: number;
	title: string;
	ext: string;
	position: { page: number | null; location: string | null; at: number; dev: string };
	chapter: { value: number | null; at: number; dev: string };
	annotations: Record<string, unknown>[];
	conversations: Record<string, unknown>[];
	/** convId → 该对话的消息行（每行自带 id + timestamp） */
	chats: Record<string, Record<string, unknown>[]>;
};

export type DocConflict = {
	docId: string;
	kind: "annotation" | "conversation" | "chat" | "position" | "chapter";
	/** 记录 id；位置/章节用 kind 本身作为 key */
	key: string;
	/** 仅消息行冲突需要：这条消息属于哪个对话 */
	convId?: string;
	local?: string;
	remote?: string;
};

export type IdRecord = { id: string };

export function emptyDocState(docId: string, title = "", ext = "pdf"): DocState {
	return {
		schema: 1,
		docId,
		title,
		ext,
		position: { page: null, location: null, at: 0, dev: "" },
		chapter: { value: null, at: 0, dev: "" },
		annotations: [],
		conversations: [],
		chats: {},
	};
}

const canon = (value: unknown): string => JSON.stringify(value ?? null);

const idOf = (record: Record<string, unknown>): string =>
	typeof record.id === "string" ? record.id : "";

/** 记录的兜底时间戳：标注用 `updatedAt`，对话行用 `timestamp`；都没有就按 0 处理。 */
export function recordStamp(record: Record<string, unknown>): Stamp {
	const at =
		typeof record.updatedAt === "number"
			? record.updatedAt
			: typeof record.timestamp === "number"
				? record.timestamp
				: 0;
	const dev =
		typeof record.deviceId === "string"
			? record.deviceId
			: typeof record.dev === "string"
				? record.dev
				: "";
	return { at, dev };
}

function sortById<T extends Record<string, unknown>>(rows: T[]): T[] {
	return [...rows].sort((a, b) => idOf(a).localeCompare(idOf(b)));
}

/**
 * 记录级三方合并（标注 / 对话索引 / 消息行共用）。
 *
 * 与设置的 key 级合并是同一张判定表，只是「一条记录」= 一个 id + 它整份 JSON。
 * 删除由「基线里有、现在没有」推导，不需要墓碑。
 */
function mergeRecords(
	base: Record<string, unknown>[] | undefined,
	local: Record<string, unknown>[],
	remote: Record<string, unknown>[],
	kind: DocConflict["kind"],
	docId: string,
	conflicts: DocConflict[],
	options: { unionWithoutBase?: boolean; convId?: string } = {},
): Record<string, unknown>[] {
	const asMap = (rows: Record<string, unknown>[] | undefined) => {
		const map = new Map<string, Record<string, unknown>>();
		for (const row of rows ?? []) {
			const id = idOf(row);
			if (id) map.set(id, row);
		}
		return map;
	};
	const baseMap = asMap(base);
	const localMap = asMap(local);
	const remoteMap = asMap(remote);
	const ids = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
	const out: Record<string, unknown>[] = [];

	for (const id of ids) {
		const baseValue = baseMap.get(id);
		const localValue = localMap.get(id);
		const remoteValue = remoteMap.get(id);

		if (canon(localValue) === canon(remoteValue)) {
			if (localValue) out.push(localValue);
			continue;
		}
		if (base && canon(localValue) === canon(baseValue)) {
			if (remoteValue) out.push(remoteValue);
			continue;
		}
		if (base && canon(remoteValue) === canon(baseValue)) {
			if (localValue) out.push(localValue);
			continue;
		}
		// 没有基线：新增互不相干，求并集（两端各加一条标注是常态，不该报冲突）
		if (!base && options.unionWithoutBase !== false && (!localValue || !remoteValue)) {
			const kept = localValue ?? remoteValue;
			if (kept) out.push(kept);
			continue;
		}
		// 一侧删除、一侧改过：保留内容，报冲突
		if (!localValue || !remoteValue) {
			const kept = localValue ?? remoteValue;
			if (kept) out.push(kept);
			conflicts.push({
				docId,
				kind,
				key: id,
				convId: options.convId,
				local: localValue ? canon(localValue) : undefined,
				remote: remoteValue ? canon(remoteValue) : undefined,
			});
			continue;
		}
		// 两侧都改：按 (updatedAt, deviceId) 全序取大，戳相同则用内容做末位键
		const localStamp = recordStamp(localValue);
		const remoteStamp = recordStamp(remoteValue);
		const order = compareStamps(localStamp, remoteStamp);
		const winner =
			order !== 0
				? order > 0
					? localValue
					: remoteValue
				: canon(localValue) > canon(remoteValue)
					? localValue
					: remoteValue;
		out.push(winner);
		conflicts.push({
			docId,
			kind,
			key: id,
			convId: options.convId,
			local: canon(localValue),
			remote: canon(remoteValue),
		});
	}

	return sortById(out);
}

/** 单值三方合并（阅读位置 / EPUB 章节）。 */
function mergeScalar<T extends { at: number; dev: string }>(
	base: T | undefined,
	local: T,
	remote: T,
	equal: (a: T, b: T) => boolean,
	docId: string,
	kind: "position" | "chapter",
	conflicts: DocConflict[],
): T {
	// 值相同也要挑一个确定的戳：否则 canonical 结果会随拉取方向变化
	if (equal(local, remote)) return compareStamps(local, remote) >= 0 ? local : remote;
	if (base && equal(local, base)) return remote;
	if (base && equal(remote, base)) return local;

	// 无基线或两侧都改：按 (at, dev) 取更晚的；相同则取远端（acceptRemote 的默认倾向）
	const order = compareStamps(local, remote);
	const winner = order !== 0 ? (order > 0 ? local : remote) : remote;
	if (base || order === 0) {
		conflicts.push({
			docId,
			kind,
			key: kind,
			local: canon(local),
			remote: canon(remote),
		});
	}
	return winner;
}

const samePosition = (a: DocState["position"], b: DocState["position"]) =>
	a.page === b.page && a.location === b.location;

export function mergeDocState(
	base: DocState | undefined,
	local: DocState,
	remote: DocState,
): { state: DocState; conflicts: DocConflict[] } {
	const conflicts: DocConflict[] = [];
	const docId = local.docId;

	const annotations = mergeRecords(
		base?.annotations,
		local.annotations,
		remote.annotations,
		"annotation",
		docId,
		conflicts,
	);
	const conversations = mergeRecords(
		base?.conversations,
		local.conversations,
		remote.conversations,
		"conversation",
		docId,
		conflicts,
	);

	const convIds = new Set([
		...Object.keys(local.chats),
		...Object.keys(remote.chats),
		...Object.keys(base?.chats ?? {}),
	]);
	const chats: Record<string, Record<string, unknown>[]> = {};
	for (const convId of convIds) {
		const merged = mergeRecords(
			base?.chats[convId],
			local.chats[convId] ?? [],
			remote.chats[convId] ?? [],
			"chat",
			docId,
			conflicts,
			{ convId },
		);
		if (merged.length > 0) chats[convId] = merged;
	}

	const position = mergeScalar(
		base?.position,
		local.position,
		remote.position,
		samePosition,
		docId,
		"position",
		conflicts,
	);
	const chapter = mergeScalar(
		base?.chapter,
		local.chapter,
		remote.chapter,
		(a, b) => a.value === b.value,
		docId,
		"chapter",
		conflicts,
	);

	return {
		state: {
			schema: 1,
			docId,
			// 标题与扩展名不是并发编辑的对象：远端有就用远端，否则本机
			title: remote.title || local.title,
			ext: remote.ext || local.ext,
			position,
			chapter,
			annotations,
			conversations,
			chats,
		},
		conflicts,
	};
}

/** 用于比较「两侧是否已经一致」，忽略 rev 这类元数据。 */
export function canonicalDocState(state: DocState): string {
	return JSON.stringify({
		docId: state.docId,
		title: state.title,
		ext: state.ext,
		position: state.position,
		chapter: state.chapter,
		annotations: sortById(state.annotations),
		conversations: sortById(state.conversations),
		chats: Object.keys(state.chats)
			.sort()
			.map((convId) => [convId, sortById(state.chats[convId] ?? [])]),
	});
}
