import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type SyncBackend, SyncError } from "./backend.ts";

/**
 * 原书（L2）同步。
 *
 * 原书和笔记是两种数据：笔记小、频繁写；原书大、几乎不变。所以这里不做「每轮同步」，
 * 而是**按需上传 / 下载**。
 *
 * 关于分片：一开始打算做「分片上传 + MOVE 拼装」，写下去才发现**纯 WebDAV 没有追加写**，
 * 分片最终仍要客户端拼起来再整传一次，等于多绕两趟还不省流量。所以这一版就是
 * 「一次 PUT + 上传后核对体积」，真正的断点续传留给按服务方能力实现的未来后端
 * （OneDrive upload session / S3 multipart）。
 *
 * 三条硬约束：
 * 1. 上传前查 `caps.maxObjectSize` —— 坚果云 500MB、其他服务上限各不相同，必须先拦；
 * 2. 上传后用一次 `list` 核对远端体积 —— 挡住「服务方静默截断」这类问题；
 * 3. 下载后校验 `sha256(content).slice(0,16) === docId` —— 半截文件、被改写的文件、
 *    同名不同内容的文件，都在这一步被拒，而不是等 PDF.js 打开时报错。
 */

export type RemoteBook = { docId: string; ext: string; size: number; path: string };

export type BookSync = {
	upload(docId: string): Promise<{ bytes: number }>;
	download(
		docId: string,
		write: (data: Buffer, ext: string) => void,
	): Promise<{ bytes: number; ext: string }>;
	remoteBooks(): Promise<RemoteBook[]>;
};

const BOOKS_DIR = "books";

/** docId 是内容 hash 的前 16 位（见 library.ts），用来做完整性校验。 */
export function docIdOf(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

const bookPath = (docId: string, ext: string) => `${BOOKS_DIR}/${docId}.${ext}`;

export function createBookSync(deps: {
	backend: SyncBackend;
	/** 本机原书的绝对路径；返回 null 表示这本书不在本机 */
	pathOf: (docId: string) => string | null;
	/** 读取本地文件（可注入，便于单测） */
	readFile?: (path: string) => Buffer;
}): BookSync {
	const readFile = deps.readFile ?? ((path: string) => readFileSync(path));

	const listRemote = async (): Promise<RemoteBook[]> => {
		const entries = await deps.backend.list(BOOKS_DIR);
		const books: RemoteBook[] = [];
		for (const entry of entries) {
			if (entry.isDir) continue;
			const match = /^books\/([0-9a-f]{8,64})\.([a-z0-9]+)$/i.exec(entry.path);
			if (!match) continue;
			books.push({ docId: match[1], ext: match[2], size: entry.size, path: entry.path });
		}
		return books;
	};

	return {
		remoteBooks: listRemote,

		async upload(docId) {
			const path = deps.pathOf(docId);
			if (!path) throw new SyncError("not-found", 404, false, "这本书不在本机");
			const content = readFile(path);
			const bytes = content.length;

			if (bytes > deps.backend.caps.maxObjectSize) {
				throw new SyncError(
					"quota",
					413,
					false,
					`这本书 ${(bytes / 1024 ** 2).toFixed(1)}MB，超过该服务单文件上限 ${(
						deps.backend.caps.maxObjectSize / 1024 ** 2
					).toFixed(0)}MB；可以关闭「同步原书」，只同步笔记`,
				);
			}

			const ext = (path.split(".").pop() ?? "pdf").toLowerCase();
			const target = bookPath(docId, ext);
			await deps.backend.put(target, content);

			// 上传后核对体积：服务方静默截断比报错更危险
			const remote = (await listRemote()).find((book) => book.docId === docId);
			if (remote && remote.size !== bytes) {
				throw new SyncError(
					"server",
					500,
					true,
					`上传后远端体积为 ${remote.size} 字节，与本地 ${bytes} 字节不一致，可能被服务方截断`,
				);
			}
			return { bytes };
		},

		async download(docId, write) {
			const remote = (await listRemote()).find((book) => book.docId === docId);
			if (!remote) throw new SyncError("not-found", 404, false, "云端没有这本书的原文件");

			const data = await deps.backend.get(remote.path);
			if (!data) throw new SyncError("not-found", 404, false, "云端没有这本书的原文件");

			// 内容寻址的完整意义：docId 就是内容 hash，不匹配说明文件坏了或被换了
			if (docIdOf(data) !== docId) {
				throw new SyncError(
					"server",
					500,
					true,
					"下载到的文件与 docId 不匹配（可能被网盘改写过或只传了一半），已丢弃",
				);
			}
			write(data, remote.ext);
			return { bytes: data.length, ext: remote.ext };
		},
	};
}
