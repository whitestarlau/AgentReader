import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, clipboard, dialog, ipcMain, safeStorage, session, shell } from "electron";
import type {
	SyncConfigureInput,
	SyncConfigureResult,
	SyncFailure,
	SyncPresetInfo,
	SyncProbeResult,
	SyncResolveResult,
	SyncRunResult,
	SyncStatus,
	SyncStatusConflict,
} from "../../shared/sync-types.ts";
import { clearChapterCache } from "../doc-state.ts";
import { clearDocCaches, clearDocTitleCache, getDocTitle } from "../doc-text.ts";
import { ensureLibrary, getDocDir, libraryRoot } from "../paths.ts";
import { readRawSettings, writeRawSettings } from "../settings.ts";
import { createBackend, registerBackendFactory, type SyncBackend, SyncError } from "./backend.ts";
import { createLocalFolderBackend } from "./backends/local-folder.ts";
import { createWebdavBackend } from "./backends/webdav.ts";
import { type BookSync, createBookSync, docIdOf } from "./books.ts";
import { type Clock, createClock } from "./clock.ts";
import { type ConfigStore, createConfigStore, type SecretCodec } from "./config.ts";
import { createConflictStore, toStoredConflicts } from "./conflicts.ts";
import { buildInfinicloudUserRequest, normalizeEndpoint, parseInfinicloudUser } from "./connect.ts";
import { deleteBook } from "./delete.ts";
import { syncClock } from "./device.ts";
import { clearPending, markDocDirty, markSettingsDirty, onDirty, takePending } from "./dirty.ts";
import { createDocPort } from "./doc-port.ts";
import { createEngine, type Engine, normalizeDoc, type SettingsPort, STATE_DIR } from "./engine.ts";
import {
	syncBaseSettingsFile,
	syncConflictsFile,
	syncIndexFile,
	syncRoot,
	syncStampsFile,
	syncTombstonesFile,
} from "./paths.ts";
import { getWebdavPreset, WEBDAV_PRESETS } from "./presets.ts";
import { applyDocChoice, applySettingsChoice } from "./resolve.ts";
import { createSettingsPort, type StampRecord } from "./settings-port.ts";
import { createFileStorage } from "./storage.ts";
import { createTombstoneStore } from "./tombstones.ts";
import type { FailureCode } from "./types.ts";

/**
 * 同步的主进程装配层：把「引擎」「后端」「落盘」「去抖调度」「IPC」接起来。
 *
 * 这一层只做接线，不含业务判断 —— 合并、净化、请求语义都在可单测的模块里。
 */

const SETTINGS_DEBOUNCE_MS = 5_000;

export type { SyncStatus };

type Runtime = {
	store: ConfigStore;
	clock: Clock;
	port: SettingsPort;
	engine: Engine | null;
	docs: ReturnType<typeof createDocPort>;
	conflicts: ReturnType<typeof createConflictStore>;
	books: BookSync | null;
	backend: SyncBackend | null;
	storage: ReturnType<typeof createFileStorage>;
	tombstones: ReturnType<typeof createTombstoneStore>;
	/** 云端书的标题缓存：read state 一次就够，不必每次重读 */
	remoteTitles: Map<string, string>;
};

type ConfigureInput = SyncConfigureInput;

const TITLES: Partial<Record<FailureCode, string>> = {
	unauthorized: "账号或密码不对",
	forbidden: "没有权限",
	"not-found": "地址不对",
	conflict: "远端有并发修改",
	locked: "文件被锁定",
	"rate-limited": "请求太频繁",
	"locked-out": "账号被临时锁定",
	quota: "云端空间不足",
	server: "服务方返回错误",
	network: "连不上服务器",
	tls: "证书校验失败",
};

function toFailure(error: unknown): SyncFailure {
	if (error instanceof SyncError) {
		return {
			code: error.code,
			title: TITLES[error.code] ?? "同步失败",
			detail: error.message,
			retryable: error.retryable,
		};
	}
	return {
		code: "server",
		title: "同步失败",
		detail: error instanceof Error ? error.message : String(error),
		retryable: true,
	};
}

/** 注入给配置层的编码器：无系统钥匙串时降级为「仅 base64」并在状态里如实标注。 */
function systemCodec(): SecretCodec {
	return {
		get available() {
			return safeStorage.isEncryptionAvailable();
		},
		encrypt(plain) {
			if (!safeStorage.isEncryptionAvailable()) throw new Error("系统钥匙串不可用");
			return safeStorage.encryptString(plain).toString("base64");
		},
		decrypt(cipher) {
			return safeStorage.decryptString(Buffer.from(cipher, "base64"));
		},
	};
}

function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as T;
	} catch {
		return fallback;
	}
}

function writeJson(file: string, data: unknown): void {
	writeFileSync(file, JSON.stringify(data, null, 2));
}

let runtimeCache: Runtime | null = null;
/**
 * 下载护栏：同一本书在 10 分钟内被下载超过 3 次，说明打开流程/app 逻辑出问题了
 * （曾经真的发生过：一个闭包 bug 让「打开云端书」无限递归，一本书被下载几十次，
 * 免费网盘的下载流量直接被打穿）。这里宁可报错让人看见，也不让它继续烧流量。
 */
const downloadGuard = new Map<string, { count: number; since: number }>();
const DOWNLOAD_GUARD_WINDOW_MS = 10 * 60 * 1000;
const DOWNLOAD_GUARD_LIMIT = 3;
let timer: ReturnType<typeof setTimeout> | null = null;
let status: SyncStatus = {
	configured: false,
	backend: null,
	state: "off",
	scope: { settings: true, notes: true, books: false },
	deviceId: "",
	secretState: "none",
	pending: { settings: false, docs: [] },
	conflicts: [],
};

/**
 * 删除本机这本书的目录与相关缓存，并清掉同步基线。
 * 基线必须清：留着它，下次重新导入同一本书时三方合并会拿一份过期基线比对。
 */
function removeLocalDoc(docId: string): boolean {
	const dir = getDocDir(docId);
	clearDocCaches(docId);
	clearChapterCache(docId);
	clearDocTitleCache(docId);
	runtime().storage.deleteDocBase?.(docId);
	if (!existsSync(dir)) return false;
	rmSync(dir, { recursive: true, force: true });
	return true;
}

/** 本机原书路径：library/{docId}/original.{ext}。 */
function bookPathOf(docId: string): string | null {
	for (const ext of ["pdf", "epub"]) {
		const candidate = join(getDocDir(docId), `original.${ext}`);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function buildRuntime(): Runtime {
	const store = createConfigStore({ dir: syncRoot(), codec: systemCodec() });
	const config = store.read();
	const clock = createClock({ deviceId: config.deviceId });
	const port = createSettingsPort({
		clock,
		readValues: () => readRawSettings(),
		writeValues: (values) => writeRawSettings(values),
		readStamps: () => readJson<StampRecord>(syncStampsFile(), {}),
		writeStamps: (record) => writeJson(syncStampsFile(), record),
	});

	const storage = createFileStorage({
		baseFile: syncBaseSettingsFile(),
		indexFile: syncIndexFile(),
	});
	const conflicts = createConflictStore(syncConflictsFile());
	const tombstones = createTombstoneStore(syncTombstonesFile());

	// 书库侧的真实读写口：把 library/{docId}/ 下的五个文件映射成一份 DocState
	const docs = createDocPort({
		dirOf: getDocDir,
		listDocIds: () => {
			ensureLibrary();
			try {
				return readdirSync(libraryRoot());
			} catch {
				return [];
			}
		},
	});

	let engine: Engine | null = null;
	let books: BookSync | null = null;
	let backendRef: SyncBackend | null = null;
	if (config.backend) {
		const backend = createBackend(config.backend.id, {
			endpoint: config.backend.endpoint,
			account: config.backend.account,
			secret: store.readSecret() ?? "",
			rootName: config.backend.rootName,
			presetId: config.backend.presetId,
		});
		engine = createEngine({
			backend,
			settings: port,
			docs,
			storage,
		});
		books = createBookSync({ backend, pathOf: bookPathOf, titleOf: (docId) => getDocTitle(docId) });
		backendRef = backend;
	}

	status = {
		...status,
		configured: engine !== null,
		backend: config.backend
			? {
					id: config.backend.id,
					label: config.backend.label ?? config.backend.id,
					endpoint: config.backend.endpoint,
				}
			: null,
		scope: config.scope,
		deviceId: config.deviceId,
		state: engine ? (status.state === "syncing" ? "syncing" : "idle") : "off",
		secretState: store.secretState(),
		lastSyncAt: config.lastSyncAt,
	};
	return {
		store,
		clock,
		port,
		engine,
		docs,
		conflicts,
		books,
		backend: backendRef,
		storage,
		tombstones,
		remoteTitles: new Map(),
	};
}

function runtime(): Runtime {
	if (!runtimeCache) runtimeCache = buildRuntime();
	return runtimeCache;
}

/**
 * 对外暴露状态前先确保运行时已装配。
 *
 * 踩过的坑：`sync:status` 曾经直接返回模块里的初始 status，结果应用刚启动时
 * 渲染进程拿到的是「未配置」——状态栏的同步灯永远不亮，书架的同步徽标也永远不出现。
 * 用户只有先触发一次别的同步 IPC（比如打开设置页）才会恢复正常。
 */
function currentStatus(): SyncStatus {
	try {
		runtime();
	} catch {}
	return statusSnapshot();
}

function statusSnapshot(): SyncStatus {
	const pending = takePending();
	return {
		...status,
		pending: { settings: pending.settings, docs: pending.docs },
		conflicts: status.conflicts,
	};
}

function broadcast(): void {
	const win = BrowserWindow.getAllWindows()[0];
	if (win && !win.isDestroyed()) win.webContents.send("sync:status", statusSnapshot());
}

function scheduleFlush(delay = SETTINGS_DEBOUNCE_MS): void {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		timer = null;
		void runSync();
	}, delay);
}

type SyncOutcome = SyncRunResult;

async function runSync(): Promise<SyncOutcome> {
	const rt = runtime();
	if (!rt.engine) {
		return {
			ok: false,
			error: {
				code: "server",
				title: "尚未配置同步",
				detail: "先在「设置 → 同步」里选择一个云盘并连接。",
				retryable: false,
			},
		};
	}

	const snapshot = takePending();
	status = { ...status, state: "syncing" };
	broadcast();
	try {
		const report = await rt.engine.sync({ dirtyDocs: snapshot.docs });
		clearPending(snapshot);
		// 冲突必须落盘：合并只会「选出赢家」，输掉的值要给用户留一条拿回来的路
		rt.conflicts.replaceWith(
			toStoredConflicts({
				settings: report.conflicts,
				docs: report.docConflicts,
				titleOf: (docId) => rt.docs.read(docId)?.title ?? docId,
			}),
		);
		status = {
			...status,
			state: "idle",
			lastSyncAt: Date.now(),
			lastError: undefined,
			conflicts: rt.conflicts.read(),
		};
		rt.store.patch({ lastSyncAt: status.lastSyncAt });
		if (report.removedDocs.length > 0) {
			// 别的设备删过这些书，本地刚跟着删掉：让书架重新拉列表
			const win = BrowserWindow.getAllWindows()[0];
			if (win && !win.isDestroyed()) win.webContents.send("library:changed");
		}
		return { ok: true, report };
	} catch (error) {
		const failure = toFailure(error);
		status = { ...status, state: "error", lastError: failure };
		// 待处理项保留：拍一拍就重试，不丢改动。但不可重试的错误不再自动调度，
		// 避免把 429（Koofr 的账号锁定）打成「越重试锁得越久」。
		if (failure.retryable) scheduleFlush(30_000);
		return { ok: false, error: failure };
	} finally {
		broadcast();
	}
}

async function configure(input: ConfigureInput): Promise<SyncConfigureResult> {
	let endpoint = String(input?.endpoint ?? "").trim();
	const backendId = String(input?.backendId ?? "");
	const presetId = input?.presetId ? String(input.presetId) : undefined;
	const preset = presetId ? getWebdavPreset(presetId) : undefined;
	if (!backendId) {
		return {
			ok: false,
			error: { code: "server", title: "请选择云盘", detail: "", retryable: false },
		};
	}
	if (backendId === "webdav") {
		// 预设自带端点的服务（坚果云 / Koofr）不让用户手填，避免抄错
		if (preset?.endpoint) endpoint = preset.endpoint;
		const normalized = normalizeEndpoint(endpoint);
		if (!normalized.ok) {
			return {
				ok: false,
				error: {
					code: "server",
					title: "地址不可用",
					detail: normalized.message,
					retryable: false,
				},
			};
		}
		endpoint = normalized.url;
		if (!String(input.account ?? "").trim()) {
			return {
				ok: false,
				error: { code: "unauthorized", title: "请填写账号", detail: "", retryable: false },
			};
		}
		if (!String(input.secret ?? "")) {
			return {
				ok: false,
				error: {
					code: "unauthorized",
					title: "请填写应用密码",
					detail: "坚果云 / InfiniCLOUD / Koofr 的 WebDAV 不接受登录密码。",
					retryable: false,
				},
			};
		}
	}
	if (backendId === "local-folder") {
		if (!endpoint) {
			return {
				ok: false,
				error: { code: "server", title: "请选择同步目录", detail: "", retryable: false },
			};
		}
		try {
			mkdirSync(endpoint, { recursive: true });
		} catch (error) {
			return {
				ok: false,
				error: {
					code: "forbidden",
					title: "无法使用该目录",
					detail: error instanceof Error ? error.message : String(error),
					retryable: false,
				},
			};
		}
	}

	const store = runtime().store;
	const test = await testConnection({ ...input, backendId, endpoint });
	if (!test.ok) return test;

	store.patch({
		backend: {
			id: backendId,
			label: backendId === "local-folder" ? "本地文件夹" : (preset?.label ?? backendId),
			presetId,
			endpoint,
			account: String(input.account ?? ""),
			rootName: String(input.rootName ?? "AgentReader") || "AgentReader",
		},
		scope: { ...status.scope, ...(input.scope ?? {}) },
		enabled: true,
	});
	if (input.secret) store.writeSecret(String(input.secret));

	runtimeCache = null;
	runtime();
	await runSync();
	return { ok: true, status: currentStatus() };
}

async function testConnection(input: ConfigureInput): Promise<SyncConfigureResult> {
	try {
		const backend = createBackend(input.backendId, {
			endpoint: String(input.endpoint ?? ""),
			account: String(input.account ?? ""),
			secret: String(input.secret ?? ""),
			rootName: String(input.rootName ?? "AgentReader"),
		});
		const result = await backend.test();
		if (!result.ok) return { ok: false, error: result.error };
		return { ok: true, status: currentStatus() };
	} catch (error) {
		return { ok: false, error: toFailure(error) };
	}
}

/** 把用户的选择写回本机，再用一次同步把它推到云端。 */
async function resolveConflict(id: string, choice: "local" | "remote"): Promise<SyncResolveResult> {
	const rt = runtime();
	const conflict = rt.conflicts.read().find((entry) => entry.id === id);
	if (!conflict) {
		return {
			ok: false,
			error: { code: "not-found", title: "这条冲突已经不在了", detail: "", retryable: false },
		};
	}
	const value = choice === "local" ? conflict.local : conflict.remote;

	if (conflict.scope === "settings") {
		writeRawSettings(applySettingsChoice(readRawSettings(), conflict.key, value));
		markSettingsDirty();
	} else {
		applyDocChoice({ port: rt.docs, conflict, value, stamp: syncClock().next() });
		markDocDirty(conflict.docId ?? "");
	}

	rt.conflicts.write(rt.conflicts.read().filter((entry) => entry.id !== id));
	await runSync();
	return { ok: true, status: statusSnapshot() };
}

/**
 * 内嵌登录窗：这不是「替用户登录」，而是「替用户打开正确的页面」。
 *
 * 安全边界（计划 §3.4）：
 * - 独立且**不持久**的分区：关闭即 `clearStorageData`，不把网盘 cookie 留在应用里；
 * - 不注入脚本、不读页面内容，登录态不回流主进程；
 * - 导航白名单：只允许预设相关的域，其他链接一律交给系统浏览器；
 * - `window.open` 同样外抛，避免弹出无头窗口。
 */
async function openLoginWindow(label: string, url: string, allowlist: string[]): Promise<void> {
	const partitionName = "sync-login";
	const win = new BrowserWindow({
		width: 920,
		height: 760,
		title: `登录 · ${label}`,
		autoHideMenuBar: true,
		webPreferences: {
			partition: partitionName,
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	});
	const isAllowed = (candidate: string): boolean => {
		try {
			const host = new URL(candidate).hostname;
			return allowlist.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
		} catch {
			return false;
		}
	};
	win.webContents.setWindowOpenHandler(({ url: opened }) => {
		if (isAllowed(opened)) void win.loadURL(opened);
		else void shell.openExternal(opened);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (event, navigationUrl) => {
		if (isAllowed(navigationUrl)) return;
		event.preventDefault();
		void shell.openExternal(navigationUrl);
	});
	win.on("closed", () => {
		void session.fromPartition(partitionName).clearStorageData();
	});
	await win.loadURL(url);
}

/** 由预设的端点与帮助页反推允许的域（含子域）。 */
function allowedHosts(endpoint?: string | null, helpUrl?: string): string[] {
	const hosts = new Set<string>([
		"jianguoyun.com",
		"infinicloud.com",
		"teracloud.jp",
		"koofr.eu",
		"koofr.net",
	]);
	for (const raw of [endpoint, helpUrl]) {
		if (!raw) continue;
		try {
			const host = new URL(raw).hostname;
			const parts = host.split(".");
			// 取最后两段作为可注册域：dav.jianguoyun.com → jianguoyun.com
			hosts.add(parts.slice(-2).join("."));
		} catch {}
	}
	return [...hosts];
}

export function registerSyncIpc(): void {
	registerBackendFactory("local-folder", (config) =>
		createLocalFolderBackend({ root: config.endpoint }),
	);
	registerBackendFactory("webdav", (config) =>
		createWebdavBackend({ config, presetId: config.presetId }),
	);

	ipcMain.handle("sync:status", () => currentStatus());
	ipcMain.handle("sync:now", () => runSync());
	ipcMain.handle("sync:conflicts", (): SyncStatusConflict[] => runtime().conflicts.read());
	// 书库每本书的权威同步状态：本地有原书 / 云端有原书 / 笔记推过没有。
	// 之前界面靠「远端书目 + 索引 + 待推送」三处自己拼，任一处时序落后就会显示错。
	ipcMain.handle("sync:library-state", async () => {
		const rt = runtime();
		const localIds = new Set(rt.docs.list());
		const indexIds = new Set(Object.keys(rt.storage.readIndex().docs));
		const remoteIds = new Set<string>();
		if (rt.books) {
			try {
				for (const book of await rt.books.remoteBooks()) remoteIds.add(book.docId);
			} catch {}
		}
		const all = new Set([...localIds, ...remoteIds, ...indexIds]);
		return [...all].map((docId) => ({
			docId,
			localOriginal: localIds.has(docId),
			remoteOriginal: remoteIds.has(docId),
			notesSynced: indexIds.has(docId),
		}));
	});
	ipcMain.handle("sync:book:delete", async (_e, docId: string, scope?: "everywhere" | "local") => {
		const rt = runtime();
		const id = String(docId ?? "");
		try {
			// 「删除」默认连云端一起删；只有用户明确选「仅移除本地文件」才保留云端
			const result = await deleteBook({
				docId: id,
				scope: scope === "local" ? "local" : "everywhere",
				backend: rt.backend,
				books: rt.books,
				storage: rt.storage,
				removeLocal: () => removeLocalDoc(id),
				tombstones: rt.tombstones,
				stamp: syncClock().next(),
			});
			rt.remoteTitles.delete(id);
			return {
				ok: true,
				removedRemote: result.removedRemote.length,
				removedLocal: result.removedLocal,
			};
		} catch (error) {
			return { ok: false, error: toFailure(error) };
		}
	});
	// 被同步引擎推过的书（index 里有记录）——书架据此显示「已同步」
	ipcMain.handle("sync:doc-index", () => Object.keys(runtime().storage.readIndex().docs));
	ipcMain.handle("sync:remote-library", async () => {
		const rt = runtime();
		if (!rt.books || !rt.backend) return [];
		let books: Awaited<ReturnType<BookSync["remoteBooks"]>> = [];
		try {
			books = await rt.books.remoteBooks();
		} catch {
			return [];
		}
		const localIds = new Set(rt.docs.list());
		const out: Array<{ docId: string; title: string; ext: string; size: number; local: boolean }> =
			[];
		for (const book of books) {
			let title = rt.remoteTitles.get(book.docId) ?? "";
			if (!title) {
				try {
					const buffer = await rt.backend.get(`state/${book.docId}.json`);
					if (buffer) title = normalizeDoc(buffer, book.docId).title;
				} catch {}
				if (title) rt.remoteTitles.set(book.docId, title);
			}
			out.push({
				docId: book.docId,
				title: title || `${book.docId.slice(0, 8)}.${book.ext}`,
				ext: book.ext,
				size: book.size,
				local: localIds.has(book.docId),
			});
		}
		return out;
	});
	ipcMain.handle("sync:books:list", async () => {
		const rt = runtime();
		if (!rt.books) return { ok: true, remote: [] };
		try {
			return { ok: true, remote: await rt.books.remoteBooks() };
		} catch (error) {
			return { ok: false, error: toFailure(error), remote: [] };
		}
	});
	ipcMain.handle("sync:book:upload", async (_e, docId: string) => {
		const rt = runtime();
		if (!rt.books) {
			return {
				ok: false,
				error: { code: "server", title: "尚未配置同步", detail: "", retryable: false },
			};
		}
		try {
			const result = await rt.books.upload(String(docId ?? ""));
			return { ok: true, bytes: result.bytes };
		} catch (error) {
			return { ok: false, error: toFailure(error) };
		}
	});
	ipcMain.handle("sync:book:download", async (_e, docId: string) => {
		const rt = runtime();
		if (!rt.books) {
			return {
				ok: false,
				error: { code: "server", title: "尚未配置同步", detail: "", retryable: false },
			};
		}
		const id = String(docId ?? "");
		try {
			// 兜底：本地已经有这本书且内容校验通过，直接返回，绝不再下一次整本书。
			// 界面侧的「本地优先」判断是主防线，这里是第二道——流量是按 GB 计费的，不能只靠一处。
			const existingPath = bookPathOf(id);
			if (existingPath) {
				const existing = readFileSync(existingPath);
				if (docIdOf(existing) === id) {
					// 没走网络，不算一次下载
					return { ok: true, bytes: existing.length, alreadyLocal: true };
				}
			}

			const guard = downloadGuard.get(id);
			const now = Date.now();
			const attempts = guard && now - guard.since < DOWNLOAD_GUARD_WINDOW_MS ? guard.count : 0;
			if (attempts >= DOWNLOAD_GUARD_LIMIT) {
				return {
					ok: false,
					error: {
						code: "rate-limited",
						title: "重复下载被拦截",
						detail:
							"这本书在 10 分钟内已被下载多次，为避免继续消耗网盘流量已暂停。请重启应用后再试；如果反复出现请反馈。",
						retryable: false,
					},
				};
			}
			downloadGuard.set(id, {
				count: attempts + 1,
				since: guard && now - guard.since < DOWNLOAD_GUARD_WINDOW_MS ? guard.since : now,
			});

			// 云端 state 里的标题最准（文件名可能被用户改过）；其次用文件名里的书名
			let remoteTitle: string | undefined;
			if (rt.backend) {
				try {
					const stateBuffer = await rt.backend.get(`${STATE_DIR}/${id}.json`);
					if (stateBuffer) remoteTitle = normalizeDoc(stateBuffer, id).title || undefined;
				} catch {}
			}
			const result = await rt.books.download(id, (data, ext) => {
				// 云端才有的书：在这里补一个完整的书库条目，之后与本地导入的书完全等价
				const dir = getDocDir(id);
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, `original.${ext}`), data);
				const metaPath = join(dir, "doc.json");
				if (!existsSync(metaPath)) {
					const fallbackTitle = remoteTitle || result.title || `${id}.${ext}`;
					writeFileSync(
						metaPath,
						JSON.stringify(
							{
								id,
								title: fallbackTitle,
								ext,
								hash: id,
								importedAt: Date.now(),
								originalPath: "",
								fromSync: true,
							},
							null,
							2,
						),
					);
				}
				if (!existsSync(join(dir, "annotations.json"))) {
					writeFileSync(join(dir, "annotations.json"), "[]");
				}
			});
			markDocDirty(id);
			return { ok: true, bytes: result.bytes, ext: result.ext };
		} catch (error) {
			return { ok: false, error: toFailure(error) };
		}
	});
	ipcMain.handle(
		"sync:resolve",
		(_e, id: string, choice: "local" | "remote"): Promise<SyncResolveResult> =>
			resolveConflict(String(id ?? ""), choice === "remote" ? "remote" : "local"),
	);
	ipcMain.handle("sync:configure", (_e, input: ConfigureInput) => configure(input));
	ipcMain.handle("sync:test", (_e, input: ConfigureInput) =>
		testConnection({
			...input,
			backendId: String(input?.backendId ?? ""),
			endpoint: String(input?.endpoint ?? ""),
		}),
	);
	ipcMain.handle("sync:disconnect", () => {
		const store = runtime().store;
		store.patch({ backend: null, enabled: false });
		store.writeSecret(null);
		runtimeCache = null;
		runtime();
		status = { ...status, state: "off", configured: false, backend: null, lastError: undefined };
		broadcast();
		return currentStatus();
	});
	ipcMain.handle("sync:presets", (): SyncPresetInfo[] =>
		WEBDAV_PRESETS.map((preset) => ({
			id: preset.id,
			label: preset.label,
			region: preset.region,
			authKind: preset.authKind,
			endpoint: preset.endpoint,
			quotaNote: preset.quotaNote,
			caveats: preset.caveats,
			passwordHelpUrl: preset.passwordHelpUrl,
			signupUrl: preset.signupUrl,
			maxObjectSize: preset.caps.maxObjectSize,
		})),
	);
	ipcMain.handle(
		"sync:probe",
		async (
			_e,
			input: { presetId: string; account: string; secret: string },
		): Promise<SyncProbeResult> => {
			const preset = getWebdavPreset(String(input?.presetId ?? ""));
			if (!preset?.endpointProbe) {
				return { ok: false, message: "该服务不支持自动识别地址，请手动填写" };
			}
			if (!preset.endpointProbe.apiKey) {
				return {
					ok: false,
					message: "本应用尚未申请该服务的 API KEY，请手动填写 My Page 里的 WebDAV 地址",
				};
			}
			const request = buildInfinicloudUserRequest(
				preset,
				String(input.account ?? ""),
				String(input.secret ?? ""),
			);
			if (!request) return { ok: false, message: "请求构造失败" };
			try {
				const response = await fetch(request.url, {
					headers: request.headers,
					signal: AbortSignal.timeout(15_000),
				});
				if (!response.ok) return { ok: false, message: `服务方返回 ${response.status}` };
				return parseInfinicloudUser(await response.json());
			} catch (error) {
				return {
					ok: false,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		},
	);
	ipcMain.handle("sync:open-external", async (_e, url: string) => {
		// 只允许 http(s)：避免被参数注入成 file:// 之类的本地跳转
		if (!/^https?:\/\//i.test(String(url ?? ""))) return false;
		await shell.openExternal(String(url));
		return true;
	});
	ipcMain.handle("sync:open-login", async (_e, presetId: string, url: string) => {
		const preset = getWebdavPreset(String(presetId ?? ""));
		const target = String(url ?? "");
		if (!/^https?:\/\//i.test(target)) return false;
		await openLoginWindow(
			preset?.label ?? "云盘",
			target,
			allowedHosts(preset?.endpoint, preset?.passwordHelpUrl),
		);
		return true;
	});
	ipcMain.handle("sync:read-clipboard", () => {
		// 只在用户点按钮时读一次，不做后台监听
		const text = clipboard.readText().trim();
		return text.length > 0 && text.length <= 512 ? text : null;
	});
	ipcMain.handle("sync:pick-directory", async () => {
		const { canceled, filePaths } = await dialog.showOpenDialog({
			properties: ["openDirectory", "createDirectory"],
			title: "选择同步目录",
		});
		return canceled ? null : (filePaths[0] ?? null);
	});

	onDirty(() => {
		broadcast();
		scheduleFlush();
	});
}
