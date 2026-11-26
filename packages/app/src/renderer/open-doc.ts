import type { DocMeta } from "./types.ts";

/**
 * 「点开一本书」应该走本地还是先下载？
 *
 * 这个判断以前写在 `openDoc` 里，条件只看「云端书目里有没有它」。但下载完成后代码又
 * 回头调用 `openDoc`，读到的仍是**点击那一刻**的 `remoteDocs` 闭包（React 状态还没生效），
 * 于是判定「它还在云端」→ 再下载一次 → 无限循环。用户只是点开一本云端书，就把整本书
 * 反复下载了几十次（坚果云账单上表现为上传 50MB、下载 1.8GB）。
 *
 * 所以判断顺序必须是「本地优先」：只要本地已经有这本书，就绝不再走下载。
 */
export type OpenTarget = "local" | "download";

export function decideOpen(input: {
	docId: string;
	/** 本机书库里的书 */
	localDocs: DocMeta[];
	/** 只在云端有原书的书 */
	cloudDocs: DocMeta[];
}): OpenTarget {
	if (input.localDocs.some((doc) => doc.id === input.docId)) return "local";
	if (input.cloudDocs.some((doc) => doc.id === input.docId)) return "download";
	return "local";
}
