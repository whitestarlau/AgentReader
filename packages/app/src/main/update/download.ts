/**
 * 安装包下载：流式写盘 + 进度 + SHA-256 校验。
 *
 * 安装包有 100–200 MB，任何一步「先整包读进内存」「失败留半截文件」都会出问题：
 * - 先写 `<name>.part`，校验通过后才 rename 成最终文件名，失败/取消立即删掉；
 * - 边写边算摘要，避免下载完再读一遍磁盘；
 * - 字节数必须与 Release 声明一致（GitHub 的 `size`），这是摘要之外的兜底。
 */

import { createHash } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdateProgress } from "../../shared/update.ts";
import { messageOf, UpdateError } from "./errors.ts";
import type { FetchLike } from "./github.ts";

const PROGRESS_INTERVAL_MS = 250;

export type DownloadedFile = { bytes: number; sha256: string };

/**
 * 下载 url 到 dest。
 *
 * `expectedBytes` / `sha256` 来自 Release 元数据；缺失时相应校验会被跳过，
 * 但调用方会在 UI 上明确告知「只校验了大小」。
 */
export async function downloadFile(opts: {
	url: string;
	dest: string;
	expectedBytes?: number;
	sha256?: string | null;
	signal?: AbortSignal;
	onProgress?: (progress: UpdateProgress) => void;
	fetchImpl?: FetchLike;
}): Promise<DownloadedFile> {
	if (!/^https:\/\//i.test(opts.url)) {
		throw new UpdateError("bad-response", "拒绝从非 HTTPS 地址下载安装包");
	}
	mkdirSync(dirname(opts.dest), { recursive: true });
	const part = `${opts.dest}.part`;
	rmSync(part, { force: true });

	const fetchImpl = opts.fetchImpl ?? fetch;
	let res: Response;
	try {
		res = await fetchImpl(opts.url, { redirect: "follow", signal: opts.signal });
	} catch (error) {
		if (opts.signal?.aborted) throw new UpdateError("cancelled", "已取消下载");
		throw new UpdateError("network", `下载失败：${messageOf(error)}`, {
			hint: "检查网络后重试",
			cause: error,
		});
	}
	if (!res.ok || !res.body) {
		if (res.status === 404) {
			throw new UpdateError("not-found", "安装包已不存在（可能被发布者删除）", {
				hint: "重新检查更新，或去发布页手动下载",
			});
		}
		throw new UpdateError("bad-response", `下载失败：HTTP ${res.status}`, {
			hint: "稍后重试",
		});
	}

	const headerTotal = Number(res.headers.get("content-length") ?? "0");
	const total = opts.expectedBytes && opts.expectedBytes > 0 ? opts.expectedBytes : headerTotal;
	const hash = createHash("sha256");
	let received = 0;
	let emittedAt = Date.now();
	let emittedBytes = 0;

	const emit = (final = false) => {
		if (!opts.onProgress) return;
		const now = Date.now();
		if (!final && now - emittedAt < PROGRESS_INTERVAL_MS) return;
		const elapsed = Math.max(1, now - emittedAt) / 1000;
		const speed = Math.max(0, (received - emittedBytes) / elapsed);
		emittedAt = now;
		emittedBytes = received;
		opts.onProgress({
			received,
			total,
			percent: total > 0 ? Math.min(100, (received / total) * 100) : 0,
			bytesPerSecond: speed,
		});
	};

	const meter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			received += chunk.length;
			emit();
			callback(null, chunk);
		},
	});

	try {
		const body = Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
		await pipeline(body, meter, createWriteStream(part), { signal: opts.signal });
	} catch (error) {
		rmSync(part, { force: true });
		if (opts.signal?.aborted) throw new UpdateError("cancelled", "已取消下载");
		throw new UpdateError("network", `下载中断：${messageOf(error)}`, {
			hint: "重试即可，已下载的部分会被丢弃",
			cause: error,
		});
	}

	const finalSize = statSync(part).size;
	if (total > 0 && finalSize !== total) {
		rmSync(part, { force: true });
		throw new UpdateError("incomplete", `安装包不完整（${finalSize} / ${total} 字节）`, {
			hint: "重新下载；如果反复出现，可能是网络代理截断了响应",
		});
	}

	const digest = hash.digest("hex");
	if (opts.sha256 && digest !== opts.sha256.toLowerCase()) {
		rmSync(part, { force: true });
		throw new UpdateError("checksum", "安装包校验失败，文件可能已损坏或被篡改", {
			hint: "不要安装该文件；重新检查更新，若仍失败请去发布页手动下载并核对 SHA-256",
		});
	}

	renameSync(part, opts.dest);
	emit(true);
	return { bytes: finalSize, sha256: digest };
}

/** 已下载文件是否完整（大小一致 + 摘要一致）；用于避免重复下载同一个包。 */
export async function isCompleteFile(
	path: string,
	expectedBytes: number,
	sha256?: string | null,
): Promise<boolean> {
	if (!existsSync(path)) return false;
	// 既没有大小也没有摘要时无法证明文件完整，宁可重新下载。
	if (expectedBytes <= 0 && !sha256) return false;
	try {
		if (expectedBytes > 0 && statSync(path).size !== expectedBytes) return false;
		if (!sha256) return true;
		return (await sha256File(path)) === sha256.toLowerCase();
	} catch {
		return false;
	}
}

export function sha256File(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}
