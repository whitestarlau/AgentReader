import type { Clock } from "./clock.ts";
import type { SettingsPort } from "./engine.ts";
import type { Stamp } from "./types.ts";

/**
 * 把「本机 settings.json」适配成引擎要的 `SettingsPort`。
 *
 * 难点只有一个：**每个 key 的最后修改时间从哪来**。
 * settings.json 本身不带时间戳（它是用户和界面共同写的扁平表），所以这里维护一份
 * `{ at, dev, v }` —— 多存一个 `v`（发戳时的值），就能判断「值没变就沿用旧戳、
 * 变了才发新戳」，而不需要在每次读设置时无脑刷新时间戳（那会让所有 key 看起来都是刚改的，
 * 三方合并直接失效）。
 */

export type StampRecord = Record<string, { at: number; dev: string; v: string }>;

export type SettingsPortDeps = {
	clock: Clock;
	/** 当前 settings.json 的内容（本机原始值，含本机专属 key）。 */
	readValues(): Record<string, string>;
	/** 覆盖写回（调用方保证已做「保留本机专属 key」的合并）。 */
	writeValues(values: Record<string, string>): void;
	/** 读取持久化的发戳记录。 */
	readStamps(): StampRecord;
	writeStamps(record: StampRecord): void;
};

export function createSettingsPort(deps: SettingsPortDeps): SettingsPort {
	return {
		read() {
			const values = deps.readValues();
			const stored = deps.readStamps();
			const nextRecord: StampRecord = {};
			const stamps: Record<string, Stamp> = {};
			let changed = false;

			for (const [key, value] of Object.entries(values)) {
				const remembered = stored[key];
				if (remembered && remembered.v === value) {
					nextRecord[key] = remembered;
				} else {
					const stamp = deps.clock.next();
					nextRecord[key] = { at: stamp.at, dev: stamp.dev, v: value };
					changed = true;
				}
				stamps[key] = { at: nextRecord[key].at, dev: nextRecord[key].dev };
			}

			// 已经被删掉的 key 不保留戳：删除的证据是「键不存在」，不需要戳；
			// 留着反而会在用户重新加回来时误用旧时间戳。
			if (changed || Object.keys(stored).length !== Object.keys(nextRecord).length) {
				deps.writeStamps(nextRecord);
			}
			return { values, stamps };
		},

		write(values, stamps) {
			deps.writeValues(values);
			const nextRecord: StampRecord = {};
			for (const [key, value] of Object.entries(values)) {
				const stamp = stamps[key] ?? deps.clock.next();
				nextRecord[key] = { at: stamp.at, dev: stamp.dev, v: value };
			}
			deps.writeStamps(nextRecord);
		},
	};
}
