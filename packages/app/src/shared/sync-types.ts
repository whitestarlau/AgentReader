/**
 * 同步的「线上类型」：主进程与渲染进程共用。
 *
 * 两边都从这里取，避免各写一份然后慢慢漂移（`sync:status` 的字段一旦不一致，
 * 界面就会静默显示 undefined，而不是报错）。
 */

export type SyncScope = { settings: boolean; notes: boolean; books: boolean };

export type SyncFailure = {
	code: string;
	title: string;
	detail: string;
	/** 引擎是否可以自动重试（Koofr 的账号锁定为 false）。 */
	retryable: boolean;
};

export type SyncConflictItem = {
	key: string;
	reason: string;
	local?: string;
	remote?: string;
};

export type SyncRunReport = {
	pulled: boolean;
	pushed: boolean;
	/** 本次同步发起的后端请求数，用于核对坚果云 600/30min 的配额。 */
	requests: number;
	conflicts: SyncConflictItem[];
};

export type SyncStatusConflict = {
	id: string;
	scope: "settings" | "doc";
	kind: string;
	docId?: string;
	convId?: string;
	key: string;
	label: string;
	local?: string;
	remote?: string;
	at: number;
};

export type SyncStatus = {
	configured: boolean;
	backend: { id: string; label: string; endpoint: string } | null;
	state: "off" | "idle" | "syncing" | "error";
	scope: SyncScope;
	deviceId: string;
	secretState: "none" | "encrypted" | "plain";
	lastSyncAt?: number;
	lastError?: SyncFailure;
	pending: { settings: boolean; docs: string[] };
	/** 待用户裁决的冲突；为空表示两边已经可以自动合并 */
	conflicts: SyncStatusConflict[];
};

export type SyncPresetInfo = {
	id: string;
	label: string;
	region: "cn" | "global" | "self";
	authKind: "account" | "app-password" | "token";
	/** null 表示需要用户手填（或由服务方 REST 反查） */
	endpoint: string | null;
	quotaNote: string;
	caveats: string[];
	passwordHelpUrl?: string;
	signupUrl?: string;
	maxObjectSize: number;
};

export type SyncProbeResult =
	| { ok: true; webdavUrl: string; node: string }
	| { ok: false; message: string };

export type SyncConfigureInput = {
	backendId: string;
	presetId?: string;
	endpoint: string;
	account?: string;
	secret?: string;
	rootName?: string;
	scope?: Partial<SyncScope>;
};

export type SyncConfigureResult =
	| { ok: true; status: SyncStatus }
	| { ok: false; error: SyncFailure };

export type SyncRunResult = { ok: true; report: SyncRunReport } | { ok: false; error: SyncFailure };

export type RemoteBookInfo = {
	docId: string;
	ext: string;
	size: number;
	/** 云端文件名里的书名（旧版本存下的纯 hash 文件没有） */
	title?: string;
	name?: string;
};

export type BookListResult = { ok: boolean; remote: RemoteBookInfo[]; error?: SyncFailure };

export type BookOpResult =
	| { ok: true; bytes: number; ext?: string }
	| { ok: false; error: SyncFailure };

export type SyncResolveResult =
	| { ok: true; status: SyncStatus }
	| { ok: false; error: SyncFailure };
