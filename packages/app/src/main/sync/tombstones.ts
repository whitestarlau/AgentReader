import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Stamp } from "./types.ts";

/**
 * 删除墓碑。
 *
 * 只有「删除」也需要跨设备传播：A 删了一本书，B 还留着本地副本；缺了墓碑，B 的下一次
 * 同步会把笔记（甚至原书）推回云端 —— 删除就被复活了。墓碑的语义是：
 * 「这本书在 at 时刻被 dev 删除了，比你本地最后一次修改还新的话，你也删掉」。
 *
 * 本地存一份（`sync/tombstones.json`），云端存一份（`deleted/{docId}.json`）。
 */

export const TOMBSTONE_DIR = "deleted";

export type TombstoneMap = Record<string, Stamp>;

export type TombstoneStore = {
	read(): TombstoneMap;
	write(map: TombstoneMap): void;
	add(docId: string, stamp: Stamp): void;
	remove(docId: string): void;
};

export function createTombstoneStore(file: string): TombstoneStore {
	const read = (): TombstoneMap => {
		if (!existsSync(file)) return {};
		try {
			const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
			if (!parsed || typeof parsed !== "object") return {};
			const out: TombstoneMap = {};
			for (const [docId, value] of Object.entries(parsed as Record<string, unknown>)) {
				const stamp = value as Stamp;
				if (typeof stamp?.at === "number" && typeof stamp?.dev === "string") out[docId] = stamp;
			}
			return out;
		} catch {
			return {};
		}
	};
	const write = (map: TombstoneMap): void => {
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, JSON.stringify(map, null, 2));
		renameSync(tmp, file);
	};
	return {
		read,
		write,
		add(docId, stamp) {
			write({ ...read(), [docId]: stamp });
		},
		remove(docId) {
			const map = read();
			if (!(docId in map)) return;
			delete map[docId];
			write(map);
		},
	};
}

/**
 * 本机内容是否「比墓碑更新」。
 *
 * 用户删完之后又在另一台机器上接着读/标注，就不该被墓碑抹掉——那种情况宁可保留，
 * 让下一次同步把这本书重新推上去。
 */
export function localIsNewerThan(localStamps: number[], tombstone: Stamp): boolean {
	return localStamps.some((at) => at > tombstone.at);
}
