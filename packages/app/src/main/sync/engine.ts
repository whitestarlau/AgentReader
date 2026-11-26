import { type SyncBackend, SyncError } from "./backend.ts";
import {
	canonicalDocState,
	type DocConflict,
	type DocState,
	emptyDocState,
	mergeDocState,
} from "./merge-records.ts";
import { mergeSettings } from "./merge-settings.ts";
import { applyMergedSettings, sanitizeSettingsState } from "./sanitize.ts";
import type { Conflict, SettingsState, Stamp } from "./types.ts";

/**
 * 同步引擎：pull → merge → 落盘 → 推进基线 → push → 写后回读。
 *
 * 这一层刻意不认识任何具体后端，也不认识 electron：
 * - 后端通过 `SyncBackend` 注入（本地文件夹 / WebDAV / 将来的 Gist）；
 * - 本机设置通过 `SettingsPort` 注入（真实实现包装 settings.ts）；
 * - 本机书库通过 `DocPort` 注入（真实实现读 library/ 下的五个文件）；
 * - 基线与索引通过 `EngineStorage` 注入（真实实现落 `{userData}/sync/`）。
 *
 * 于是「两台机器」可以在一个进程里用两个目录 + 内存端口完整模拟出来。
 */

export const SETTINGS_PATH = "settings/state.json";
export const STATE_DIR = "state";

export type SettingsPort = {
	/** 本机原始设置（含本机专属 key）与每个 key 的戳。 */
	read(): { values: Record<string, string>; stamps: Record<string, Stamp> };
	/** 应用合并结果：覆盖而非替换（调用方负责保留本机专属 key）。 */
	write(values: Record<string, string>, stamps: Record<string, Stamp>): void;
};

/** 一本书在本机的读写口。`read` 返回 null 表示这本书已不在本机。 */
export type DocPort = {
	list(): string[];
	read(docId: string): DocState | null;
	write(docId: string, state: DocState): void;
};

export type DocIndexEntry = { rev: number; etag?: string };

export type SyncIndex = {
	settingsRev: number;
	docs: Record<string, DocIndexEntry>;
};

export type EngineStorage = {
	readBase(): SettingsState | undefined;
	writeBase(state: SettingsState): void;
	readDocBase?(docId: string): DocState | undefined;
	writeDocBase?(docId: string, state: DocState): void;
	/** 删除某本书的基线（删书时调用，避免下次重新导入拿到过期基线）。 */
	deleteDocBase?(docId: string): void;
	readIndex(): SyncIndex;
	writeIndex(index: SyncIndex): void;
};

export type SyncReport = {
	pulled: boolean;
	pushed: boolean;
	conflicts: Conflict[];
	/** 书库层的冲突（标注 / 对话 / 位置），与设置冲突分开，方便界面分组呈现 */
	docConflicts: DocConflict[];
	/** 本次同步发起的后端调用次数，用于核对坚果云 600/30min 的配额。 */
	requests: number;
};

const emptyState = (): SettingsState => ({ schema: 1, values: {}, mtimes: {}, tombstones: {} });

const sameValues = (a: SettingsState, b: SettingsState): boolean => {
	const keys = new Set([...Object.keys(a.values), ...Object.keys(b.values)]);
	for (const key of keys) if (a.values[key] !== b.values[key]) return false;
	const tomb = new Set([...Object.keys(a.tombstones), ...Object.keys(b.tombstones)]);
	for (const key of tomb)
		if (Boolean(a.tombstones[key]) !== Boolean(b.tombstones[key])) return false;
	return true;
};

type RemoteFile = SettingsState & { rev?: number; updatedAt?: number };

function parseRemote(buffer: Buffer): { state: SettingsState; rev: number } {
	let raw: unknown;
	try {
		raw = JSON.parse(buffer.toString("utf-8"));
	} catch {
		throw new SyncError("server", 500, false, "远端的 settings/state.json 不是合法 JSON");
	}
	const file = (typeof raw === "object" && raw !== null ? raw : {}) as RemoteFile;
	const state = sanitizeSettingsState({
		schema: 1,
		values: isStringMap(file.values) ? file.values : {},
		mtimes: isStampMap(file.mtimes) ? file.mtimes : {},
		tombstones: isStampMap(file.tombstones) ? file.tombstones : {},
	}).state;
	return { state, rev: typeof file.rev === "number" && file.rev > 0 ? file.rev : 0 };
}

const isStringMap = (v: unknown): v is Record<string, string> =>
	typeof v === "object" && v !== null && Object.values(v).every((x) => typeof x === "string");

const isStampMap = (v: unknown): v is Record<string, Stamp> =>
	typeof v === "object" &&
	v !== null &&
	Object.values(v).every((s) => typeof s === "object" && s !== null && "at" in s && "dev" in s);

function serializeSettings(state: SettingsState, rev: number): Buffer {
	const file: RemoteFile = {
		schema: 1,
		rev,
		updatedAt: Date.now(),
		values: state.values,
		mtimes: state.mtimes,
		tombstones: state.tombstones,
	};
	return Buffer.from(JSON.stringify(file, null, 2), "utf-8");
}

const sortEntries = (map: Record<string, string>): Array<[string, string]> =>
	Object.keys(map)
		.sort()
		.map((key) => [key, map[key]]);

const statePath = (docId: string): string => `${STATE_DIR}/${docId}.json`;

export type Engine = {
	/**
	 * 一次完整同步。`dirtyDocs` 是本机刚改过的书：即便远端 etag 没变也要重新合并并推送。
	 * 失败时抛 SyncError，调用方按 `retryable` 决定退避还是停手。
	 */
	sync(options?: { dirtyDocs?: string[] }): Promise<SyncReport>;
};

export function createEngine(deps: {
	backend: SyncBackend;
	settings: SettingsPort;
	storage: EngineStorage;
	docs?: DocPort;
	settingsPath?: string;
}): Engine {
	const path = deps.settingsPath ?? SETTINGS_PATH;
	let requests = 0;

	const call = async <T>(run: () => Promise<T>): Promise<T> => {
		requests += 1;
		return run();
	};

	const readRemote = async (): Promise<{ state: SettingsState; rev: number }> => {
		const buffer = await call(() => deps.backend.get(path));
		if (!buffer) return { state: emptyState(), rev: 0 };
		return parseRemote(buffer);
	};

	// ---------------------------------------------------------------- 设置

	async function syncSettings(): Promise<{
		pulled: boolean;
		pushed: boolean;
		conflicts: Conflict[];
	}> {
		let remote = await readRemote();

		const localRaw = deps.settings.read();
		const localState = sanitizeSettingsState({
			schema: 1,
			values: localRaw.values,
			mtimes: localRaw.stamps,
			tombstones: {},
		}).state;

		const base = deps.storage.readBase();
		const merged = mergeSettings(base, localState, remote.state);

		// 1) 落盘到本机：覆盖而非替换，本机专属 key 原样保留
		const nextValues = applyMergedSettings(localRaw.values, merged.state);
		const changedLocally =
			JSON.stringify(sortEntries(nextValues)) !== JSON.stringify(sortEntries(localRaw.values));
		if (changedLocally) deps.settings.write(nextValues, merged.state.mtimes);

		// 2) 基线只在 pull 成功并落盘后推进（否则三方合并会退化成覆盖式同步）
		let baseline = merged.state;
		deps.storage.writeBase(baseline);

		// 3) 是否需要推：只看值与墓碑，不看时间戳
		if (sameValues(merged.state, remote.state)) {
			const index = deps.storage.readIndex();
			deps.storage.writeIndex({ ...index, settingsRev: remote.rev });
			return { pulled: changedLocally, pushed: false, conflicts: merged.conflicts };
		}

		let state = merged.state;
		for (let attempt = 0; attempt < 3; attempt++) {
			const rev = remote.rev + 1;
			const payload = serializeSettings(state, rev);
			await call(() => deps.backend.put(path, payload));

			// 写后回读：没有 If-Match 的后端靠这一步发现被别的设备覆盖
			const verify = await call(() => deps.backend.get(path));
			if (verify && verify.toString("utf-8") === payload.toString("utf-8")) {
				baseline = state;
				deps.storage.writeBase(baseline);
				const index = deps.storage.readIndex();
				deps.storage.writeIndex({ ...index, settingsRev: rev });
				return { pulled: changedLocally, pushed: true, conflicts: merged.conflicts };
			}

			remote = await readRemote();
			state = mergeSettings(state, state, remote.state).state;
			deps.storage.writeBase(state);
		}

		throw new SyncError(
			"conflict",
			412,
			true,
			"推送后回读校验连续失败，远端可能被其他设备持续修改",
		);
	}

	// ---------------------------------------------------------------- 书库

	async function syncDocs(dirtyDocs: string[]): Promise<{
		pulled: boolean;
		pushed: boolean;
		docConflicts: DocConflict[];
	}> {
		const port = deps.docs;
		if (!port || !deps.storage.readDocBase || !deps.storage.writeDocBase) {
			return { pulled: false, pushed: false, docConflicts: [] };
		}

		const dirty = new Set(dirtyDocs);
		let pulled = false;
		let pushed = false;
		const docConflicts: DocConflict[] = [];

		// 远端目录清单就是索引：一次 list 拿到全部书的 (size, mtime, etag)，
		// 比额外维护一份 manifest.json 少一个「可能落后」的状态源。
		const remoteEntries = new Map<string, { path: string; etag?: string }>();
		for (const entry of await call(() => deps.backend.list(STATE_DIR))) {
			if (entry.isDir) continue;
			const match = /^state\/([^/]+)\.json$/.exec(entry.path);
			if (match)
				remoteEntries.set(decodeURIComponent(match[1]), { path: entry.path, etag: entry.etag });
		}

		const ids = new Set([...port.list(), ...remoteEntries.keys()]);
		const index = deps.storage.readIndex();

		for (const docId of ids) {
			const local = port.read(docId);
			// 本地没有这本书：不删云端（计划 §4.0-D：误删后重新导入同一文件能续上笔记）
			if (!local) continue;

			const entry = remoteEntries.get(docId);
			const known = index.docs[docId];
			const remoteUnchanged = Boolean(entry && known?.etag && known.etag === entry.etag);
			if (remoteUnchanged && !dirty.has(docId)) continue;

			let remote: DocState;
			if (entry && remoteUnchanged) {
				// 远端没变：基线就是远端的最新副本，省一次 GET
				remote = deps.storage.readDocBase(docId) ?? emptyDocState(docId, local.title, local.ext);
			} else if (entry) {
				const buffer = await call(() => deps.backend.get(entry.path));
				remote = buffer
					? normalizeDoc(buffer, docId)
					: emptyDocState(docId, local.title, local.ext);
			} else {
				remote = emptyDocState(docId, local.title, local.ext);
			}

			const base = deps.storage.readDocBase(docId);
			const merged = mergeDocState(base, local, remote);
			docConflicts.push(...merged.conflicts);

			if (canonicalDocState(merged.state) !== canonicalDocState(local)) {
				port.write(docId, merged.state);
				pulled = true;
			}
			deps.storage.writeDocBase(docId, merged.state);

			const remoteCanonical = canonicalDocState(remote);
			if (canonicalDocState(merged.state) === remoteCanonical) {
				index.docs[docId] = { rev: remote.rev ?? known?.rev ?? 0, etag: entry?.etag };
				continue;
			}

			const rev = (remote.rev ?? known?.rev ?? 0) + 1;
			const payload = serializeDoc(merged.state, rev);
			await call(() => deps.backend.put(statePath(docId), payload));
			const verify = await call(() => deps.backend.get(statePath(docId)));
			if (!verify || verify.toString("utf-8") !== payload.toString("utf-8")) {
				throw new SyncError(
					"conflict",
					412,
					true,
					`《${merged.state.title || docId}》推送后回读校验失败，远端可能被其他设备修改`,
				);
			}
			const pushedState = { ...merged.state, rev };
			deps.storage.writeDocBase(docId, pushedState);
			index.docs[docId] = { rev, etag: undefined };
			pushed = true;
		}

		deps.storage.writeIndex({ ...index });
		return { pulled, pushed, docConflicts };
	}

	return {
		async sync(options): Promise<SyncReport> {
			requests = 0;
			const settings = await syncSettings();
			const docs = await syncDocs(options?.dirtyDocs ?? []);
			return {
				pulled: settings.pulled || docs.pulled,
				pushed: settings.pushed || docs.pushed,
				conflicts: settings.conflicts,
				docConflicts: docs.docConflicts,
				requests,
			};
		},
	};
}

/** 远端 `state/{docId}.json` 的解析：坏字段一律降级为空状态，绝不让一本书卡住整轮同步。 */
export function normalizeDoc(buffer: Buffer, docId: string): DocState {
	let raw: unknown;
	try {
		raw = JSON.parse(buffer.toString("utf-8"));
	} catch {
		throw new SyncError("server", 500, false, `远端的 state/${docId}.json 不是合法 JSON`);
	}
	const file = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<DocState> & {
		rev?: number;
	};
	const rows = (value: unknown): Record<string, unknown>[] =>
		Array.isArray(value)
			? value.filter(
					(row): row is Record<string, unknown> =>
						typeof row === "object" &&
						row !== null &&
						typeof (row as { id?: unknown }).id === "string",
				)
			: [];
	const position = file.position;
	const chapter = file.chapter;
	const chats: Record<string, Record<string, unknown>[]> = {};
	if (file.chats && typeof file.chats === "object") {
		for (const [convId, value] of Object.entries(file.chats)) chats[convId] = rows(value);
	}
	return {
		schema: 1,
		docId,
		rev: typeof file.rev === "number" ? file.rev : 0,
		title: typeof file.title === "string" ? file.title : "",
		ext: typeof file.ext === "string" ? file.ext : "pdf",
		position:
			position && typeof position === "object"
				? {
						page: typeof position.page === "number" ? position.page : null,
						location: typeof position.location === "string" ? position.location : null,
						at: typeof position.at === "number" ? position.at : 0,
						dev: typeof position.dev === "string" ? position.dev : "",
					}
				: { page: null, location: null, at: 0, dev: "" },
		chapter:
			chapter && typeof chapter === "object"
				? {
						value: typeof chapter.value === "number" ? chapter.value : null,
						at: typeof chapter.at === "number" ? chapter.at : 0,
						dev: typeof chapter.dev === "string" ? chapter.dev : "",
					}
				: { value: null, at: 0, dev: "" },
		annotations: rows(file.annotations),
		conversations: rows(file.conversations),
		chats,
	};
}

/** 远端 `state/{docId}.json` 的序列化（对话内联，每本书一个对象）。 */
export function serializeDoc(state: DocState, rev: number): Buffer {
	const file = { ...state, rev, updatedAt: Date.now() };
	return Buffer.from(JSON.stringify(file, null, 2), "utf-8");
}
