import { randomUUID } from "node:crypto";
import type { Stamp } from "./types.ts";

/**
 * 设备身份 + 混合逻辑时钟（HLC 的最简形式）。
 *
 * 为什么不能用裸 `Date.now()`：同一台设备同一毫秒内写两次（拖动阅读位置、连续改 TTS 语速）
 * 会产生两个 `(at, dev)` 完全相同的记录，全序键退化成非全序，合并结果随拉取方向变化。
 * `at` 在单台设备内必须严格递增 —— 代价为零，却把「兜底一定收敛」从概率变成保证。
 */

export type Clock = {
	deviceId: string;
	/** 取下一个严格递增的戳。 */
	next(): Stamp;
	/** 最近一次发出的时间戳（用于持久化，防止重启后倒退）。 */
	lastAt(): number;
};

export function newDeviceId(): string {
	return randomUUID();
}

export function createClock(opts: {
	deviceId: string;
	/** 上次进程退出时的时间戳；启动时用 max(它, now) 兜住时钟回拨。 */
	initialAt?: number;
	now?: () => number;
}): Clock {
	const now = opts.now ?? Date.now;
	let last = Math.max(opts.initialAt ?? 0, now());
	return {
		deviceId: opts.deviceId,
		next() {
			last = Math.max(now(), last + 1);
			return { at: last, dev: opts.deviceId };
		},
		lastAt() {
			return last;
		},
	};
}

/** 全序比较：`(at, dev)`，用于冲突兜底裁决。 */
export function compareStamps(a: Stamp, b: Stamp): number {
	if (a.at !== b.at) return a.at < b.at ? -1 : 1;
	if (a.dev !== b.dev) return a.dev < b.dev ? -1 : 1;
	return 0;
}

export function maxStamp(a: Stamp | undefined, b: Stamp | undefined): Stamp | undefined {
	if (!a) return b;
	if (!b) return a;
	return compareStamps(a, b) >= 0 ? a : b;
}
