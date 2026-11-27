/**
 * GitHub Releases API 客户端。
 *
 * 只用公开的 REST 接口，不做缓存文件：一次检查 = 一个 GET。
 * 未认证请求按 IP 限流（60 次/小时），所以自动检查有 6 小时间隔；需要更高额度或
 * 私有仓库时，用 `AGENTREADER_UPDATE_TOKEN` 提供 token（不写进 settings.json，
 * 避免被云同步带走）。
 */

import { messageOf, UpdateError } from "./errors.ts";
import type { GithubReleaseJson } from "./release.ts";

export const DEFAULT_API_BASE = "https://api.github.com";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type RepoRef = { owner: string; repo: string };

/** `owner/repo` 校验。允许 fork 用户用 `AGENTREADER_UPDATE_REPO` 指到自己的仓库。 */
export function parseRepo(input: string): RepoRef | null {
	const text = input.trim();
	const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(text);
	if (!match) return null;
	return { owner: match[1], repo: match[2] };
}

export function repoSlug(repo: RepoRef): string {
	return `${repo.owner}/${repo.repo}`;
}

export function releasePageUrl(repo: RepoRef): string {
	return `https://github.com/${repo.owner}/${repo.repo}/releases`;
}

export function githubHeaders(appVersion: string, token?: string): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		// GitHub 强制要求 UA；带上版本，出问题时能在日志里定位是谁在请求。
		"User-Agent": `AgentReader/${appVersion}`,
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

/** 合并「调用方取消」与「超时」两个信号。 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function request(
	url: string,
	opts: {
		headers: Record<string, string>;
		signal?: AbortSignal;
		timeoutMs?: number;
		fetchImpl?: FetchLike;
	},
): Promise<Response> {
	const timeoutMs = opts.timeoutMs ?? 15_000;
	const fetchImpl = opts.fetchImpl ?? fetch;
	try {
		return await fetchImpl(url, {
			headers: opts.headers,
			signal: withTimeout(opts.signal, timeoutMs),
			redirect: "follow",
		});
	} catch (error) {
		if (opts.signal?.aborted) {
			throw new UpdateError("cancelled", "已取消", { cause: error });
		}
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
			throw new UpdateError("timeout", `请求 GitHub 超时（${Math.round(timeoutMs / 1000)} 秒）`, {
				hint: "检查网络或代理设置后重试",
				cause: error,
			});
		}
		throw new UpdateError("network", `无法连接 GitHub：${messageOf(error)}`, {
			hint: "检查网络或代理设置；也可以直接去发布页手动下载",
			cause: error,
		});
	}
}

async function failureOf(res: Response): Promise<UpdateError> {
	const body = await res
		.text()
		.then((text) => text.slice(0, 400))
		.catch(() => "");
	if (res.status === 404) {
		return new UpdateError("not-found", "没有找到这个仓库或 Release", {
			hint: "确认仓库存在且有已发布的 Release；私有仓库需要 AGENTREADER_UPDATE_TOKEN",
		});
	}
	if (res.status === 401) {
		return new UpdateError("unauthorized", "GitHub 拒绝了访问凭证", {
			hint: "检查 AGENTREADER_UPDATE_TOKEN 是否有效",
		});
	}
	if (res.status === 403) {
		const remaining = res.headers.get("x-ratelimit-remaining");
		const reset = res.headers.get("x-ratelimit-reset");
		if (remaining === "0") {
			const when = reset ? new Date(Number(reset) * 1000) : null;
			const at =
				when && !Number.isNaN(when.getTime())
					? `，额度将在 ${when.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 重置`
					: "";
			return new UpdateError("rate-limited", `GitHub API 额度用尽${at}`, {
				hint: "稍后再试，或设置 AGENTREADER_UPDATE_TOKEN 提高额度",
			});
		}
		return new UpdateError("unauthorized", "GitHub 拒绝了这次请求（403）", {
			hint: body || "稍后重试",
		});
	}
	if (res.status >= 500) {
		return new UpdateError("server", `GitHub 服务异常（HTTP ${res.status}）`, {
			hint: "稍后重试；持续失败可去发布页手动下载",
		});
	}
	return new UpdateError("bad-response", `GitHub 返回了意外响应（HTTP ${res.status}）`, {
		hint: body || "稍后重试",
	});
}

/** 拉取 Release 列表（新→旧）。`/releases/latest` 会排除预发布，这里要自己筛。 */
export async function fetchReleaseList(opts: {
	repo: RepoRef;
	appVersion: string;
	token?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	apiBase?: string;
	fetchImpl?: FetchLike;
}): Promise<GithubReleaseJson[]> {
	const base = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
	const url = `${base}/repos/${opts.repo.owner}/${opts.repo.repo}/releases?per_page=30`;
	const res = await request(url, {
		headers: githubHeaders(opts.appVersion, opts.token),
		signal: opts.signal,
		timeoutMs: opts.timeoutMs,
		fetchImpl: opts.fetchImpl,
	});
	if (!res.ok) throw await failureOf(res);
	let json: unknown;
	try {
		json = await res.json();
	} catch (error) {
		throw new UpdateError("bad-response", "无法解析 GitHub 返回的 JSON", { cause: error });
	}
	if (!Array.isArray(json)) {
		throw new UpdateError("bad-response", "GitHub 返回的 Release 列表格式不对");
	}
	return json.filter((item): item is GithubReleaseJson => !!item && typeof item === "object");
}

/** 下载小文本（校验和文件）。 */
export async function fetchText(
	url: string,
	opts: {
		appVersion: string;
		token?: string;
		signal?: AbortSignal;
		timeoutMs?: number;
		fetchImpl?: FetchLike;
	},
): Promise<string> {
	const res = await request(url, {
		headers: githubHeaders(opts.appVersion, opts.token),
		signal: opts.signal,
		timeoutMs: opts.timeoutMs ?? 10_000,
		fetchImpl: opts.fetchImpl,
	});
	if (!res.ok) throw await failureOf(res);
	const text = await res.text();
	return text.slice(0, 64 * 1024);
}
