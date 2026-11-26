import { type BackendConfig, type SyncBackend, SyncError } from "../backend.ts";
import { classifyFailure, normalizeEndpoint, syncRootUrl } from "../connect.ts";
import { getWebdavPreset, type WebdavPreset } from "../presets.ts";
import type { RemoteEntry } from "../types.ts";
import { parseMultiStatus } from "./webdav-xml.ts";

/**
 * WebDAV 后端。
 *
 * 几个刻意的选择：
 * - **preemptive Basic**：第一个请求就带 `Authorization`，不等 401 挑战。多一次往返在
 *   坚果云 600/30min 的配额下是实打实的浪费。
 * - **令牌桶放在这一层**：所有请求都经过 `send()`，任何新增调用自动受限，不靠业务层记得限流。
 * - **错误映射集中在 `classifyFailure`**：同一个 429 在坚果云是限流、在 Koofr 是账号锁定，
 *   映射结果里的 `retryable` 决定引擎是否重试。
 * - **fetch 可注入**：单测用一个内存版 DAV 服务器就能验证全部语义，不需要真账号。
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:getetag/>
    <d:resourcetype/>
    <d:quota-available-bytes/>
  </d:prop>
</d:propfind>`;

const encodePath = (path: string): string =>
	path
		.split("/")
		.filter(Boolean)
		.map((segment) => encodeURIComponent(segment))
		.join("/");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type WebdavBackendOptions = {
	config: BackendConfig;
	/** 预设 id（`jianguoyun` / `koofr` / …），决定 caps 与错误语义 */
	presetId?: string;
	fetchImpl?: FetchLike;
	now?: () => number;
};

export function createWebdavBackend(opts: WebdavBackendOptions): SyncBackend {
	const preset: WebdavPreset =
		getWebdavPreset(opts.presetId ?? "") ?? (getWebdavPreset("custom") as WebdavPreset);
	const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
	const now = opts.now ?? Date.now;

	const normalized = normalizeEndpoint(opts.config.endpoint);
	if (!normalized.ok) throw new Error(normalized.message);
	const endpoint = normalized.url;
	const rootUrl = syncRootUrl(endpoint, opts.config.rootName || "AgentReader");
	const authorization = `Basic ${Buffer.from(
		`${opts.config.account}:${opts.config.secret}`,
		"utf-8",
	).toString("base64")}`;

	// ---- 令牌桶：按 caps.requestBudgetPerMinute 限速，所有请求共用 ----
	const perMinute = Math.max(1, preset.caps.requestBudgetPerMinute);
	const ratePerMs = perMinute / 60_000;
	let tokens = perMinute;
	let lastRefill = now();
	const takeToken = async (): Promise<void> => {
		for (;;) {
			const current = now();
			tokens = Math.min(perMinute, tokens + (current - lastRefill) * ratePerMs);
			lastRefill = current;
			if (tokens >= 1) {
				tokens -= 1;
				return;
			}
			await sleep(Math.max(5, Math.ceil((1 - tokens) / ratePerMs)));
		}
	};

	const failureFor = (status: number | "network" | "tls"): SyncError => {
		const failure = classifyFailure(status, { preset });
		return new SyncError(failure.code, status, failure.retryable, failure.detail);
	};

	const urlFor = (path: string, isDir = false): string => {
		const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
		if (!trimmed) return rootUrl;
		return isDir ? `${rootUrl}${encodePath(trimmed)}/` : `${rootUrl}${encodePath(trimmed)}`;
	};

	const send = async (
		method: string,
		url: string,
		init: { body?: string | Buffer; headers?: Record<string, string>; timeoutMs?: number } = {},
	): Promise<Response> => {
		await takeToken();
		const headers: Record<string, string> = {
			Authorization: authorization,
			...(init.headers ?? {}),
		};
		try {
			return await fetchImpl(url, {
				method,
				headers,
				// Buffer 在运行时就是合法的 body；TS 的 DOM 类型只认 BodyInit，这里做一次显式收窄
				body: init.body as BodyInit | undefined,
				signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
				redirect: "follow",
			});
		} catch (error) {
			const name = error instanceof Error ? error.name : "";
			if (/Timeout|Abort/i.test(name)) {
				throw new SyncError("network", "network", true, "请求超时，可能是网络不稳定");
			}
			throw new SyncError(
				"network",
				"network",
				true,
				error instanceof Error ? error.message : String(error),
			);
		}
	};

	const assertOk = (response: Response): void => {
		if (response.ok) return;
		throw failureFor(response.status);
	};

	const created = new Set<string>();
	const ensureDir = async (path: string): Promise<void> => {
		const clean = path.replace(/^\/+/, "").replace(/\/+$/, "");
		if (!clean || created.has(clean)) return;
		const segments = clean.split("/");
		let prefix = "";
		for (const segment of segments) {
			prefix = prefix ? `${prefix}/${segment}` : segment;
			if (created.has(prefix)) continue;
			const response = await send("MKCOL", urlFor(prefix, true));
			// 405 = 已存在；409 = 父级还不存在（顺序创建时不会出现，留着兜底）
			if (!response.ok && response.status !== 405 && response.status !== 409) {
				throw failureFor(response.status);
			}
			created.add(prefix);
		}
	};

	const backend: SyncBackend = {
		id: "webdav",
		label: preset.label,
		caps: {
			conditionalWrite: true,
			maxObjectSize: preset.caps.maxObjectSize,
			requestBudgetPerMinute: perMinute,
			paginatedListLimit: preset.caps.paginatedListLimit,
		},

		async test() {
			try {
				await ensureDir("");
				const root = await send("PROPFIND", rootUrl, {
					headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
					body: PROPFIND_BODY,
				});
				if (root.status === 404) {
					// 同步根还不存在：建出来再探一次
					const mk = await send("MKCOL", rootUrl);
					if (!mk.ok && mk.status !== 405) throw failureFor(mk.status);
					return { ok: true };
				}
				assertOk(root);
				const text = await root.text();
				const quota = /<(?:\w+:)?quota-available-bytes>(\d+)<\//i.exec(text);
				return quota ? { ok: true, freeBytes: Number(quota[1]) } : { ok: true };
			} catch (error) {
				if (error instanceof SyncError) {
					const failure = classifyFailure(
						typeof error.status === "number" ? error.status : error.status,
						{ preset },
					);
					return { ok: false, error: { ...failure, detail: error.message || failure.detail } };
				}
				const failure = classifyFailure("network", { preset });
				return {
					ok: false,
					error: { ...failure, detail: error instanceof Error ? error.message : String(error) },
				};
			}
		},

		async mkdir(path) {
			await ensureDir(path);
		},

		async list(prefix) {
			const clean = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
			const response = await send("PROPFIND", urlFor(clean, true), {
				headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
				body: PROPFIND_BODY,
			});
			if (response.status === 404) return [];
			assertOk(response);
			const entries = parseMultiStatus(await response.text(), { baseUrl: rootUrl });
			const out: RemoteEntry[] = entries
				.filter((entry) => entry.path !== clean && entry.path !== "")
				.map((entry) => ({
					path: entry.path,
					size: entry.size,
					mtime: entry.mtime,
					etag: entry.etag,
					isDir: entry.isDir,
				}));
			if (out.length >= backend.caps.paginatedListLimit) {
				// WebDAV 没有分页语义：服务方只会截断。把「可能不完整」变成显式错误，
				// 而不是让上层拿着半份列表当成完整列表（那会误判「远端没有这个文件」）。
				throw new SyncError(
					"server",
					507,
					false,
					`目录 ${clean || "/"} 的条目达到服务方单次列目录上限（${backend.caps.paginatedListLimit}），可能已被截断`,
				);
			}
			return out;
		},

		async get(path) {
			const response = await send("GET", urlFor(path));
			if (response.status === 404) return null;
			assertOk(response);
			return Buffer.from(await response.arrayBuffer());
		},

		async put(path, data, putOptions) {
			const slash = path.lastIndexOf("/");
			if (slash > 0) await ensureDir(path.slice(0, slash));
			if (data.length > backend.caps.maxObjectSize) {
				throw new SyncError("quota", 507, false, "对象超过服务方单文件上限");
			}
			const headers: Record<string, string> = {
				"Content-Type": "application/octet-stream",
			};
			if (putOptions?.ifMatch) headers["If-Match"] = putOptions.ifMatch;
			if (putOptions?.ifNoneMatch) headers["If-None-Match"] = "*";
			const response = await send("PUT", urlFor(path), {
				body: data,
				headers,
				timeoutMs: 60_000,
			});
			assertOk(response);
			const etag = response.headers.get("etag") ?? undefined;
			return etag ? { etag } : {};
		},

		async del(path) {
			const response = await send("DELETE", urlFor(path));
			if (response.status === 404) return;
			assertOk(response);
		},

		async move(from, to) {
			const response = await send("MOVE", urlFor(from), {
				headers: { Destination: urlFor(to), Overwrite: "T" },
				timeoutMs: 60_000,
			});
			assertOk(response);
		},
	};

	return backend;
}
