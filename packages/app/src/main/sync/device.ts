import { readFileSync } from "node:fs";
import { type Clock, createClock } from "./clock.ts";
import { syncConfigFile } from "./paths.ts";

/**
 * 主进程侧的发戳时钟。
 *
 * deviceId 取自 `sync/config.json`（与索引、基线同一个身份）。同步还没配置过时退回 `"local"`：
 * 发戳本身不影响本地使用，等用户启用同步后新记录会带上真正的设备 id；
 * 老记录里的 `"local"` 只用于兜底裁决，不会造成数据问题。
 */
let cached: Clock | null = null;

export function syncClock(): Clock {
	if (cached) return cached;
	let deviceId = "";
	try {
		const parsed = JSON.parse(readFileSync(syncConfigFile(), "utf-8")) as { deviceId?: unknown };
		if (typeof parsed.deviceId === "string") deviceId = parsed.deviceId;
	} catch {}
	cached = createClock({ deviceId: deviceId || "local" });
	return cached;
}

/** 仅供测试/重启后重置。 */
export function resetSyncClock(): void {
	cached = null;
}
