import { compareStamps, maxStamp } from "./clock.ts";
import { sanitizeSettingsState } from "./sanitize.ts";
import type { Conflict, SettingsState } from "./types.ts";

/**
 * 设置的 key 级三方合并。
 *
 * 与书库的「记录级」三方合并（merge-records.ts）是同一张判定表，只是粒度更细：
 * 设置是扁平 `Record<string, string>`，一条记录就是一个 key，冲突面因此更小 ——
 * 用户在 A 机器改 TTS 引擎、在 B 机器改 OCR 语言，是两次不相干的修改，必须都落地。
 *
 * 比 VSCode 更保守的两处（有意为之）：
 * - 「一侧删除、另一侧改过」→ 保留内容并报冲突，不按时间裁决；
 * - 「无基线时一侧缺失」→ 缺席不等于删除，取有值的一方，绝不拿空状态覆盖云端。
 */

const keysOf = (state: SettingsState | undefined): string[] =>
	state ? Object.keys(state.values) : [];

export function mergeSettings(
	base: SettingsState | undefined,
	localRaw: SettingsState,
	remoteRaw: SettingsState,
): { state: SettingsState; conflicts: Conflict[] } {
	const baseState = base ? sanitizeSettingsState(base).state : undefined;
	const local = sanitizeSettingsState(localRaw).state;
	const remote = sanitizeSettingsState(remoteRaw).state;

	const out: SettingsState = { schema: 1, values: {}, mtimes: {}, tombstones: {} };
	const conflicts: Conflict[] = [];
	const keys = new Set([
		...keysOf(baseState),
		...Object.keys(local.values),
		...Object.keys(remote.values),
		...Object.keys(local.tombstones),
		...Object.keys(remote.tombstones),
	]);

	const put = (
		key: string,
		value: string | undefined,
		stamp: { at: number; dev: string } | undefined,
	) => {
		if (value === undefined) {
			delete out.values[key];
			if (stamp) out.tombstones[key] = stamp;
			return;
		}
		out.values[key] = value;
		delete out.tombstones[key];
		if (stamp) out.mtimes[key] = stamp;
	};

	for (const key of keys) {
		const baseValue = baseState?.values[key];
		const localValue = local.values[key];
		const remoteValue = remote.values[key];
		const localStamp = local.mtimes[key];
		const remoteStamp = remote.mtimes[key];

		// 两侧一致（含两侧都删）
		if (localValue === remoteValue) {
			put(key, localValue, maxStamp(localStamp, remoteStamp));
			continue;
		}

		// 有基线时：只有一侧偏离基线，直接采纳偏离的那一侧
		if (baseState && localValue === baseValue) {
			put(key, remoteValue, remoteStamp);
			continue;
		}
		if (baseState && remoteValue === baseValue) {
			put(key, localValue, localStamp);
			continue;
		}

		// 无基线时：缺席不等于删除，有值的一方胜出
		if (!baseState && localValue === undefined) {
			put(key, remoteValue, remoteStamp);
			continue;
		}
		if (!baseState && remoteValue === undefined) {
			put(key, localValue, localStamp);
			continue;
		}

		// 真冲突 1：一侧删除、一侧改过 —— 保留数据（宁可多留不可误删）并报冲突
		if (localValue === undefined || remoteValue === undefined) {
			const keepLocal = localValue !== undefined;
			put(key, keepLocal ? localValue : remoteValue, maxStamp(localStamp, remoteStamp));
			conflicts.push({
				key,
				reason: "delete-vs-modify",
				local: localValue,
				remote: remoteValue,
				winner: keepLocal ? "local" : "remote",
			});
			continue;
		}

		// 没有基线时的真冲突：**采用远端**（acceptRemote）。
		//
		// 为什么不是「按戳取新」：新设备第一次同步时本机还没基线，如果按戳裁决，
		// 结果就取决于两台机器的时钟——那正是 §3.4.2 反复警告的「结果随拉取方向变化」。
		// 定死为「云端优先」，语义清楚：云端代表「已经在用的配置」，本机是「刚开始用的」。
		// 本机被覆盖的值不会丢，原样留在冲突记录里，用户可以在冲突面板里选回来。
		if (!baseState) {
			put(key, remoteValue, maxStamp(localStamp, remoteStamp));
			conflicts.push({
				key,
				reason: "both-changed",
				local: localValue,
				remote: remoteValue,
				winner: "remote",
			});
			continue;
		}

		// 真冲突 2：两侧都改且值不同 —— 全序键兜底，戳完全相同时用值本身做末位键
		let winner: "local" | "remote";
		if (localStamp && remoteStamp && compareStamps(localStamp, remoteStamp) !== 0) {
			winner = compareStamps(localStamp, remoteStamp) > 0 ? "local" : "remote";
		} else {
			winner = localValue > remoteValue ? "local" : "remote";
		}
		put(key, winner === "local" ? localValue : remoteValue, maxStamp(localStamp, remoteStamp));
		conflicts.push({
			key,
			reason: "both-changed",
			local: localValue,
			remote: remoteValue,
			winner,
		});
	}

	return { state: out, conflicts };
}

/** 把当前设置快照成基线（同步成功后调用）。 */
export function snapshotSettings(
	values: Record<string, string>,
	mtimes: Record<string, { at: number; dev: string }>,
): SettingsState {
	const sanitized = sanitizeSettingsState({ schema: 1, values, mtimes, tombstones: {} }).state;
	return { schema: 1, values: sanitized.values, mtimes: sanitized.mtimes, tombstones: {} };
}
