import { type SyncBackend, SyncError } from "./backend.ts";
import type { BookSync } from "./books.ts";
import { type EngineStorage, STATE_DIR } from "./engine.ts";

/**
 * 删除一本书。
 *
 * 两种范围，语义必须由用户明确选择：
 * - `everywhere`：本地目录 + 云端原书 + 云端笔记状态 + 本地基线/索引。这是「删除」该有的样子。
 * - `local`：只移除本机文件，云端保留。之后书在书架里会变成「云端」条目——不是复活，而是它本来就还在。
 *
 * 之前只有「本地」这一条路，且 UI 上就叫「删除」：用户删完发现云端还在、书架又冒出一条云端书，
 * 看着就像功能失效。这里把范围变成显式参数，并在界面里做成两个明确选项。
 */

export type DeleteScope = "everywhere" | "local";

export type DeleteResult = {
	removedLocal: boolean;
	removedRemote: string[];
};

export async function deleteBook(opts: {
	docId: string;
	scope: DeleteScope;
	backend: SyncBackend | null;
	books: BookSync | null;
	storage: EngineStorage;
	/** 删除本机书库目录（由调用方处理 fs 与各类缓存） */
	removeLocal: () => boolean;
}): Promise<DeleteResult> {
	const deleted: string[] = [];
	let removedLocal = false;

	if (opts.scope === "everywhere") {
		if (!opts.backend) {
			throw new SyncError("server", 500, false, "尚未配置同步，无法删除云端副本");
		}
		const remoteBooks = opts.books ? await opts.books.remoteBooks() : [];
		for (const book of remoteBooks.filter((entry) => entry.docId === opts.docId)) {
			await opts.backend.del(book.path);
			deleted.push(book.path);
		}
		// 笔记状态也一起删：用户按「删除」就是想彻底清掉这本书
		const statePath = `${STATE_DIR}/${opts.docId}.json`;
		await opts.backend.del(statePath);
		deleted.push(statePath);
	}

	removedLocal = opts.removeLocal();

	// 基线一定要清：留着它，下次重新导入同一本书时三方合并会拿一份过期基线去比对
	opts.storage.deleteDocBase?.(opts.docId);

	const index = opts.storage.readIndex();
	if (index.docs[opts.docId]) {
		delete index.docs[opts.docId];
		opts.storage.writeIndex(index);
	}

	return { removedLocal, removedRemote: deleted };
}
