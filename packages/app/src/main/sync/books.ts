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

export type RemoteBook = {
	docId: string;
	ext: string;
	size: number;
	path: string;
	/** 云端文件名（含书名，便于界面直接展示） */
	name: string;
	/** 从文件名里解析出的书名（旧格式没有） */
	title?: string;
};

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

const MAX_NAME_LENGTH = 80;

/**
 * 云端文件名：`书名 [docId].pdf`。
 *
 * 为什么名字里还要带 docId：它是内容 hash，是「两台设备不看服务端也能对上同一本书」的
 * 唯一依据（换设备、重新导入、云端被改名都不影响识别）。纯书名会撞车，纯 hash 不可读，
 * 所以两者都留。
 *
 * 清理规则按最保守的来：去掉路径分隔符与 Windows 非法字符、折叠空白、去掉首尾的点与空格
 * （Windows 不允许以点结尾）、限长；清理后为空就退回 docId。
 */
export function cloudBookName(title: string | undefined, docId: string, ext: string): string {
	// 控制字符用码点过滤而不是正则：正则里出现控制字符既难读，也容易被 lint 判为笔误
	const withoutControls = Array.from(title ?? "")
		.filter((char) => {
			const code = char.codePointAt(0) ?? 0;
			return code >= 0x20 && code !== 0x7f;
		})
		.join("");
	const cleaned = withoutControls
		.replace(/[\\/:*?"<>|]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+|[.\s]+$/g, "");
	const safe = cleaned.slice(0, MAX_NAME_LENGTH).trim();
	const stem = safe ? `${safe} [${docId}]` : docId;
	return `${stem}.${ext}`;
}

/** 从云端文件名里取回 docId：新格式认方括号，旧格式（纯 hash）也继续支持。 */
export function docIdFromBookName(fileName: string): { docId: string; title?: string } | null {
	const match = /^(.+?)\.([a-z0-9]+)$/i.exec(fileName);
	if (!match) return null;
	const stem = match[1];
	const bracketed = /^(.*?)\s*\[([0-9a-f]{16})\]$/i.exec(stem);
	if (bracketed)
		return { docId: bracketed[2].toLowerCase(), title: bracketed[1].trim() || undefined };
	if (/^[0-9a-f]{16}$/i.test(stem)) return { docId: stem.toLowerCase() };
	return null;
}

export function createBookSync(deps: {
	backend: SyncBackend;
	/** 本机原书的绝对路径；返回 null 表示这本书不在本机 */
	pathOf: (docId: string) => string | null;
	/** 读取本地文件（可注入，便于单测） */
	readFile?: (path: string) => Buffer;
	/** 书名（优先取书籍元数据，其次本地文件名）；用于生成可读的云端文件名 */
	titleOf?: (docId: string) => Promise<string | undefined> | string | undefined;
}): BookSync {
	const readFile = deps.readFile ?? ((path: string) => readFileSync(path));

	const listRemote = async (): Promise<RemoteBook[]> => {
		const entries = await deps.backend.list(BOOKS_DIR);
		const books: RemoteBook[] = [];
		for (const entry of entries) {
			if (entry.isDir) continue;
			const fileName = entry.path.slice(entry.path.lastIndexOf("/") + 1);
			const parsed = docIdFromBookName(fileName);
			if (!parsed) continue;
			const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
			books.push({
				docId: parsed.docId,
				ext,
				size: entry.size,
				path: entry.path,
				name: fileName,
				title: parsed.title,
			});
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
			const title = deps.titleOf ? await deps.titleOf(docId) : undefined;
			const target = `${BOOKS_DIR}/${cloudBookName(title, docId, ext)}`;
			await deps.backend.put(target, content);

			// 书名变了（或旧版用纯 hash 存过）：把旧文件删掉，避免云端留住两个副本
			const stale = (await listRemote()).filter(
				(book) => book.docId === docId && book.path !== target,
			);
			for (const book of stale) {
				try {
					await deps.backend.del(book.path);
				} catch {}
			}

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
