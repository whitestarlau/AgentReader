import { randomUUID } from "node:crypto";
import type { BackendCaps, FailureCode, PutOptions, RemoteEntry, TestResult } from "./types.ts";

/**
 * 后端抽象层：所有后端只做「键值 + 原子写」这一件事，冲突合并全部交给上层。
 *
 * 这样即使某个后端不支持 ETag 或条件写（Gist、多数 WebDAV），正确性也不受影响 ——
 * 上层永远靠做题 + 写后回读来兜底，而不是依赖服务端能力。
 */

export class SyncError extends Error {
	readonly code: FailureCode;
	readonly status: number | "network" | "tls";
	/** 引擎是否可以自动重试。账号锁定（Koofr 429）必须为 false。 */
	readonly retryable: boolean;

	constructor(
		code: FailureCode,
		status: number | "network" | "tls",
		retryable: boolean,
		message: string,
	) {
		super(message);
		this.name = "SyncError";
		this.code = code;
		this.status = status;
		this.retryable = retryable;
	}
}

export interface SyncBackend {
	readonly id: string;
	readonly label: string;
	readonly caps: BackendCaps;
	/** 连通性与权限自检；向导的「连接」按钮就是调它。 */
	test(): Promise<TestResult>;
	/** 列目录。返回的 path 是相对同步根的 POSIX 路径，**不带前导 `/`**。 */
	list(prefix: string): Promise<RemoteEntry[]>;
	get(path: string): Promise<Buffer | null>;
	put(path: string, data: Buffer, opts?: PutOptions): Promise<{ etag?: string }>;
	del(path: string): Promise<void>;
	/** 建目录，幂等（已存在不报错）。 */
	mkdir(path: string): Promise<void>;
	/** 可选：分片拼装用。不支持时上层退化为整传。 */
	move?(from: string, to: string): Promise<void>;
	/** 可选：清理空目录（契约测试收尾用）。 */
	rmdir?(path: string): Promise<void>;
}

/** 后端实例化所需的配置（凭据由上层从 safeStorage 取出后传入）。 */
export type BackendConfig = {
	endpoint: string;
	account: string;
	secret: string;
	rootName: string;
	/** WebDAV 预设 id：决定 caps（单文件上限、配额）与错误语义（Koofr 的 429） */
	presetId?: string;
};

export type BackendFactory = (config: BackendConfig) => SyncBackend;

const factories = new Map<string, BackendFactory>();

export function registerBackendFactory(id: string, factory: BackendFactory): void {
	factories.set(id, factory);
}

export function listBackendIds(): string[] {
	return [...factories.keys()];
}

export function createBackend(id: string, config: BackendConfig): SyncBackend {
	const factory = factories.get(id);
	if (!factory) throw new Error(`未注册的同步后端：${id}`);
	return factory(config);
}

/**
 * 后端契约检查：任何新后端实现（WebDAV / Gist / 本地文件夹）都必须通过。
 * 返回的是「问题列表」而不是抛错，方便测试断言与启动自检。
 */
export async function checkBackendContract(backend: SyncBackend): Promise<string[]> {
	const problems: string[] = [];
	const dir = `contract-${randomUUID().slice(0, 8)}`;
	const file = `${dir}/probe.txt`;
	const bytes = Buffer.from("hello-同步-✓");
	const missingPath = `${dir}/missing.txt`;

	const expectError = async (run: () => Promise<unknown>): Promise<SyncError | null> => {
		try {
			await run();
			return null;
		} catch (e) {
			return e instanceof SyncError ? e : new SyncError("server", 500, false, String(e));
		}
	};

	try {
		if (!(backend.caps.maxObjectSize > 0)) problems.push("caps.maxObjectSize 必须为正数");
		if (!(backend.caps.paginatedListLimit > 0)) problems.push("caps.paginatedListLimit 必须为正数");

		// mkdir 必须幂等：第二次调用不能抛错
		await backend.mkdir(dir);
		try {
			await backend.mkdir(dir);
		} catch {
			problems.push("mkdir 不幂等：目录已存在时抛错了");
		}

		// 不存在的对象返回 null，而不是抛错或返回空 Buffer
		const missing = await backend.get(missingPath);
		if (missing !== null) problems.push("get 对不存在的路径应返回 null");

		// 二进制原样往返
		const first = await backend.put(file, bytes);
		const back = await backend.get(file);
		if (!back || !back.equals(bytes))
			problems.push("put 之后 get 的内容不一致（二进制必须原样往返）");

		// list 的路径约定：相对、无前导斜杠、不越界
		const entries = await backend.list(dir);
		const hit = entries.find((e) => e.path === file);
		if (!hit) problems.push(`list("${dir}") 未返回 ${file}`);
		else if (hit.size !== bytes.length)
			problems.push(`list 返回的 size 不对：期望 ${bytes.length}，实际 ${hit.size}`);
		for (const entry of entries) {
			if (entry.path.startsWith("/")) problems.push(`list 返回的 path 不应带前导 /：${entry.path}`);
			if (!entry.path.startsWith(`${dir}/`))
				problems.push(`list 返回了 prefix 之外的条目：${entry.path}`);
		}

		// 覆盖写
		await backend.put(file, Buffer.from("second"));
		const overwritten = await backend.get(file);
		if (!overwritten || overwritten.toString() !== "second") problems.push("重复 put 未覆盖旧内容");

		// 条件写（仅在声明支持时检查）
		if (backend.caps.conditionalWrite) {
			if (!first.etag) {
				problems.push("声明了 conditionalWrite，但 put 未返回 etag");
			} else {
				const stale = await expectError(() =>
					backend.put(file, Buffer.from("stale"), { ifMatch: "definitely-not-matching" }),
				);
				if (!stale) problems.push("If-Match 不匹配时应当抛 SyncError");
				else if (stale.status !== 412)
					problems.push(`If-Match 冲突的状态码应为 412，实际 ${String(stale.status)}`);
			}
			const fresh = await expectError(() =>
				backend.put(file, Buffer.from("fresh"), { ifNoneMatch: true }),
			);
			if (!fresh) problems.push("ifNoneMatch 对已存在的对象应当抛 SyncError");
		}

		// 删除幂等
		await backend.del(file);
		if ((await backend.get(file)) !== null) problems.push("del 之后 get 仍能读到内容");
		try {
			await backend.del(file);
		} catch {
			problems.push("del 对不存在的对象不幂等：抛错了");
		}
	} finally {
		try {
			await backend.del(file);
		} catch {}
		try {
			await backend.rmdir?.(dir);
		} catch {}
	}

	return problems;
}
