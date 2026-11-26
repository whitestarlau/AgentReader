import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EngineStorage, SyncIndex } from "./engine.ts";
import type { SettingsState } from "./types.ts";

/**
 * 引擎的落盘层：基线快照 + 本地索引。
 *
 * 基线（`base/settings.json`）是三方合并的地基，只在本机存在、上传云端；
 * 它推进得太早会成为「假基线」，让合并退化成覆盖，见计划 §4.2。
 */

function writeAtomic(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

const emptyIndex = (): SyncIndex => ({ settingsRev: 0, docs: {} });

export function createFileStorage(opts: {
	baseFile: string;
	indexFile: string;
	/** `base/{docId}.json` 的路径；删书时用来清基线（默认与 baseFile 同目录） */
	docBaseFile?: (docId: string) => string;
}): EngineStorage {
	const docBaseFile =
		opts.docBaseFile ?? ((docId: string) => opts.baseFile.replace(/[^/]+$/, `${docId}.json`));
	return {
		readBase() {
			if (!existsSync(opts.baseFile)) return undefined;
			try {
				const parsed = JSON.parse(readFileSync(opts.baseFile, "utf-8")) as SettingsState;
				if (!parsed || typeof parsed !== "object" || !parsed.values) return undefined;
				return {
					schema: 1,
					values: parsed.values,
					mtimes: parsed.mtimes ?? {},
					tombstones: parsed.tombstones ?? {},
				};
			} catch {
				return undefined;
			}
		},
		writeBase(state) {
			writeAtomic(opts.baseFile, JSON.stringify(state, null, 2));
		},
		deleteDocBase(docId) {
			rmSync(docBaseFile(docId), { force: true });
		},
		readIndex() {
			if (!existsSync(opts.indexFile)) return emptyIndex();
			try {
				const parsed = JSON.parse(readFileSync(opts.indexFile, "utf-8")) as SyncIndex;
				return {
					settingsRev: typeof parsed.settingsRev === "number" ? parsed.settingsRev : 0,
					docs: parsed.docs && typeof parsed.docs === "object" ? parsed.docs : {},
				};
			} catch {
				return emptyIndex();
			}
		},
		writeIndex(index) {
			writeAtomic(opts.indexFile, JSON.stringify(index, null, 2));
		},
	};
}
