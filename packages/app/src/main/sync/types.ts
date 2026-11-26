/**
 * 云同步的共享类型。
 *
 * 刻意不依赖 electron / node:fs —— 纯函数模块（sanitize / merge-settings / clock /
 * 后端契约检查）只依赖这里，单测因此可以在 `node --experimental-strip-types` 下直接跑。
 */

/** 混合逻辑时钟的戳：同一设备内 at 严格递增（见 clock.ts）。 */
export type Stamp = { at: number; dev: string };

export type ConflictReason = "both-changed" | "delete-vs-modify";

/** 一条冲突：双方的值都留着，由界面逐条裁决。 */
export type Conflict = {
	key: string;
	reason: ConflictReason;
	local?: string;
	remote?: string;
	winner: "local" | "remote";
};

/**
 * 设置同步体的形状（对应远端 `settings/state.json`）。
 * `values` 与 `settings.json` 扁平结构完全一致，写回时零转换。
 */
export type SettingsState = {
	schema: 1;
	values: Record<string, string>;
	mtimes: Record<string, Stamp>;
	tombstones: Record<string, Stamp>;
};

export type FailureCode =
	| "unauthorized"
	| "forbidden"
	| "not-found"
	| "method-not-allowed"
	| "conflict"
	| "locked"
	| "rate-limited"
	| "locked-out"
	| "quota"
	| "server"
	| "network"
	| "tls";

export type FailureAction =
	| "check-credentials"
	| "open-help"
	| "retry-later"
	| "trust-cert"
	| "reduce-requests";

/**
 * 一次失败的完整描述。`retryable` 必须驱动引擎的调度，而不只是 UI 文案：
 * Koofr 的 429 是「密码错太多次、账号锁 1 小时」，重试只会延长锁定。
 */
export type Failure = {
	code: FailureCode;
	title: string;
	detail: string;
	action?: FailureAction;
	retryable: boolean;
};

export type RemoteEntry = {
	/** 相对同步根的 POSIX 路径，不带前导 `/`。 */
	path: string;
	size: number;
	mtime?: number;
	etag?: string;
	isDir?: boolean;
};

export type PutOptions = {
	/** 乐观并发：与远端当前 etag 不符时抛 412。 */
	ifMatch?: string;
	/** 仅当远端不存在时写入。 */
	ifNoneMatch?: boolean;
};

export type BackendCaps = {
	/** 是否支持 If-Match 条件写（不支持时靠写后回读兜底）。 */
	conditionalWrite: boolean;
	/** 单文件上限，决定原书能不能传。 */
	maxObjectSize: number;
	/** 供令牌桶使用；本地后端给一个很大的值。 */
	requestBudgetPerMinute: number;
	/** 单次列目录最多返回多少项（坚果云 750，超出需分页）。 */
	paginatedListLimit: number;
};

export type TestResult = { ok: true; freeBytes?: number } | { ok: false; error: Failure };
