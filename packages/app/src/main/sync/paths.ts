import { join } from "node:path";
import { app } from "electron";

/**
 * 云同步在本地的那一半：`{userData}/sync/`。
 *
 * 惰性求值：`userData` 由 `app.name` 决定，而应用名要到 main.ts 顶部
 * `setupAppIdentity()` 才设置好；模块加载期取值会拿到旧路径（见 `paths.ts` 的同款注释）。
 */
export function syncRoot(): string {
	return join(app.getPath("userData"), "sync");
}

/** 后端配置（端点 / 账号 / 范围），非敏感字段明文存放。 */
export function syncConfigFile(): string {
	return join(syncRoot(), "config.json");
}

/** 凭据（密码 / PAT / OAuth token），经 safeStorage 加密后存放，永不进同步体。 */
export function syncSecretsFile(): string {
	return join(syncRoot(), "secrets.json");
}

/** 本地索引：每本书与设置的远端 rev。 */
export function syncIndexFile(): string {
	return join(syncRoot(), "index.json");
}

/** 本机记录的删除墓碑（云端 `deleted/` 是权威来源，这里留一份便于排查与撤除）。 */
export function syncTombstonesFile(): string {
	return join(syncRoot(), "tombstones.json");
}

/** 待用户裁决的冲突（每次同步后整体重写）。 */
export function syncConflictsFile(): string {
	return join(syncRoot(), "conflicts.json");
}

/** 每个设置 key 的发戳记录（值 + (at, dev)），由 settings-port 维护。 */
export function syncStampsFile(): string {
	return join(syncRoot(), "settings-stamps.json");
}

/** 待推送队列，崩溃后可续。 */
export function syncQueueFile(): string {
	return join(syncRoot(), "queue.json");
}

export function syncBaseDir(): string {
	return join(syncRoot(), "base");
}

export function syncBaseSettingsFile(): string {
	return join(syncBaseDir(), "settings.json");
}

export function syncBaseDocFile(docId: string): string {
	return join(syncBaseDir(), `${docId}.json`);
}

/** 回滚快照目录：`history/settings/*.json` 与 `history/{docId}/*.json`。 */
export function syncHistoryDir(kind?: string, docId?: string): string {
	const base = join(syncRoot(), "history");
	if (!kind) return base;
	return docId ? join(base, kind, docId) : join(base, kind);
}
