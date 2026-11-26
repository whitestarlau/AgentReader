import type { SyncLibraryEntry } from "../shared/sync-types.ts";
import type { DocMeta } from "./types.ts";

/**
 * 书架卡片的展示状态。
 *
 * 这段逻辑之前直接写在 `main.tsx` 里，靠「远端书目 + 索引 + 待推送」三份来源自己拼，
 * 任一处时序落后就会显示错（典型症状：明明同步了却显示未同步、从云端下回来的书也是这样）。
 * 现在由主进程一次算出权威状态（`sync:library-state`），这里只做纯映射，且有测试。
 */

export type ShelfDoc = DocMeta & {
	/** 云端有原书，或笔记推过至少一次 */
	remote: boolean;
	/** 本地刚改过、还没推上去 */
	pending: boolean;
	/** 本地没有原书文件（只存在于云端） */
	cloud: boolean;
};

export function deriveShelfDocs(input: {
	docs: DocMeta[];
	remoteOnlyDocs: DocMeta[];
	libraryState: SyncLibraryEntry[];
	pendingDocs: string[];
}): ShelfDoc[] {
	const pending = new Set(input.pendingDocs);
	const stateOf = new Map(input.libraryState.map((entry) => [entry.docId, entry]));

	const withState = (doc: DocMeta): ShelfDoc => {
		const state = stateOf.get(doc.id);
		return {
			...doc,
			// 云端有原书、或笔记推过一次 —— 都算「已同步」
			remote: Boolean(state?.remoteOriginal || state?.notesSynced),
			pending: pending.has(doc.id),
			// 只有明确「本地没有原书」才算云端书；没有状态记录时沿用调用方给的标记
			cloud: state ? !state.localOriginal : doc.cloud === true,
		};
	};

	return [...input.docs.map(withState), ...input.remoteOnlyDocs.map(withState)];
}
