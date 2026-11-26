import type { WebdavPreset } from "./presets.ts";
import type { Failure, FailureAction, FailureCode } from "./types.ts";

/**
 * WebDAV 的「连接逻辑」：端点归一化、InfiniCLOUD 端点反查、错误分类、向导状态机。
 *
 * 全部是纯函数（不 import electron / fetch），所以能离线单测 —— 这一层是最容易
 * 写错又最难在真机上复现的地方（比如「同一个 429 在两家服务上含义相反」）。
 */

// ------------------------------------------------------------ 端点归一化

export type EndpointResult =
	| { ok: true; url: string }
	| {
			ok: false;
			code: "empty" | "not-https" | "has-query" | "has-userinfo" | "not-url";
			message: string;
	  };

/**
 * 用户手填端点时的归一化：
 * - 必须 https（Basic 认证明文，http 等于把密码写在明信片上）；
 * - 去掉 query / fragment；
 * - 去掉 URL 里的 user:pass（很多网盘文档的示例带，用户会整段粘贴）；
 * - 补尾斜杠（PROPFIND 的 Depth 语义要求目录 URL 以 / 结尾）；
 * - **不改大小写**（Koofr 的 `/dav/Koofr` 大写 K 是硬要求）。
 */
export function normalizeEndpoint(input: string): EndpointResult {
	const raw = input.trim();
	if (!raw) return { ok: false, code: "empty", message: "请填写 WebDAV 地址" };
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, code: "not-url", message: "这不像一个完整地址，需要以 https:// 开头" };
	}
	if (url.protocol !== "https:") {
		return { ok: false, code: "not-https", message: "WebDAV 必须用 https://" };
	}
	if (url.username || url.password) {
		return {
			ok: false,
			code: "has-userinfo",
			message: "地址里不要带用户名密码，请填到下面的输入框",
		};
	}
	if (url.search || url.hash) {
		return { ok: false, code: "has-query", message: "地址里不能带 ? 或 # 后面的内容" };
	}
	const pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
	return { ok: true, url: `${url.origin}${pathname}` };
}

/** 解析后的同步根：`<endpoint><rootName>/`。 */
export function syncRootUrl(endpoint: string, rootName = "AgentReader"): string {
	const normalized = normalizeEndpoint(endpoint);
	if (!normalized.ok) throw new Error(normalized.message);
	const clean = rootName.replace(/^\/+|\/+$/g, "") || "AgentReader";
	return `${normalized.url}${encodeURIComponent(clean)}/`;
}

// ------------------------------------------------- InfiniCLOUD 端点反查

export const INFINICLOUD_API_KEY_PLACEHOLDER = "";

export function buildInfinicloudUserRequest(
	preset: WebdavPreset,
	account: string,
	appPassword: string,
): { url: string; headers: Record<string, string> } | null {
	if (!preset.endpointProbe) return null;
	const token = Buffer.from(`${account}:${appPassword}`, "utf-8").toString("base64");
	return {
		url: preset.endpointProbe.restUrl,
		headers: {
			Authorization: `Basic ${token}`,
			[preset.endpointProbe.apiKeyHeader]: preset.endpointProbe.apiKey,
			Accept: "application/json",
		},
	};
}

export type ProbeResult =
	| { ok: true; webdavUrl: string; node: string }
	| { ok: false; message: string };

/**
 * 解析 `GET /v2/api/ba/user` 的返回。
 * 注意 `result` 非 0 时 HTTP 仍是 200，所以必须看 body 而不是只看状态码。
 */
export function parseInfinicloudUser(json: unknown): ProbeResult {
	if (!json || typeof json !== "object") return { ok: false, message: "返回内容无法解析" };
	const record = json as Record<string, unknown>;
	if (record.result !== 0) {
		return {
			ok: false,
			message: `服务返回错误（result=${String(record.result)}），请检查账号与应用密码`,
		};
	}
	const webdav = typeof record.webdav_url === "string" ? record.webdav_url : "";
	if (!webdav) return { ok: false, message: "未取得 WebDAV 地址，可能账号尚未开通数据区" };
	const normalized = normalizeEndpoint(webdav);
	if (!normalized.ok) return { ok: false, message: `返回的地址不可用：${normalized.message}` };
	return {
		ok: true,
		webdavUrl: normalized.url,
		node: typeof record.node === "string" ? record.node : "",
	};
}

// ------------------------------------------------------------- 错误分类

const DEFAULT_FAILURES: Record<
	number,
	{ code: FailureCode; title: string; detail: string; action?: FailureAction; retryable: boolean }
> = {
	401: {
		code: "unauthorized",
		title: "账号或应用密码不对",
		detail:
			"坚果云 / InfiniCLOUD / Koofr 的 WebDAV 不接受登录密码，必须用「应用密码」。点右侧按钮可以直接跳到生成页面。",
		action: "open-help",
		retryable: false,
	},
	403: {
		code: "forbidden",
		title: "没有权限",
		detail:
			"凭据正确但该目录不可写。InfiniCLOUD 需要先在 My Page 打开「外部应用连接」；坚果云请确认应用密码未被撤销。",
		action: "open-help",
		retryable: false,
	},
	404: {
		code: "not-found",
		title: "地址不对",
		detail: "服务器可达但路径不存在。检查端点后缀（坚果云 /dav/、Koofr /dav/Koofr，注意大小写）。",
		action: "check-credentials",
		retryable: false,
	},
	405: {
		code: "method-not-allowed",
		title: "这个地址不支持 WebDAV",
		detail: "地址可能是网盘的网页入口或 API 入口，不是 WebDAV 端点。",
		action: "open-help",
		retryable: false,
	},
	409: {
		code: "conflict",
		title: "父目录不存在",
		detail: "建目录时父级还没建好。本应用会自动逐级创建，若持续报错请检查权限。",
		action: "retry-later",
		retryable: true,
	},
	412: {
		code: "conflict",
		title: "远端有并发修改",
		detail: "远端文件在你读取之后被别的设备改过。本应用会重新拉取并重试。",
		action: "retry-later",
		retryable: true,
	},
	423: {
		code: "locked",
		title: "文件被锁定",
		detail: "另一个客户端占了文件锁且没释放（Koofr 常见）。稍后会自动重试。",
		action: "retry-later",
		retryable: true,
	},
	429: {
		code: "rate-limited",
		title: "请求太频繁",
		detail: "已触发服务方限流（坚果云免费版 600 次 / 30 分钟），本应用会自动退避，无需操作。",
		action: "reduce-requests",
		retryable: true,
	},
	507: {
		code: "quota",
		title: "云端空间已满",
		detail: "清理网盘空间，或关闭「同步原书」只同步笔记与设置。",
		action: "retry-later",
		retryable: false,
	},
};

export function classifyFailure(
	status: number | "network" | "tls",
	ctx: { preset?: WebdavPreset } = {},
): Failure {
	// 服务级覆盖优先：同一个状态码在不同服务上可能完全相反（Koofr 429 = 账号锁定）
	if (typeof status === "number") {
		const override = ctx.preset?.statusOverrides?.[status];
		if (override) return { ...override };
	}
	if (status === "network") {
		return {
			code: "network",
			title: "连不上服务器",
			detail: "检查网络或代理设置；坚果云 / InfiniCLOUD 在国内一般可直连。",
			action: "retry-later",
			retryable: true,
		};
	}
	if (status === "tls") {
		return {
			code: "tls",
			title: "证书校验失败",
			detail: "自建服务常用自签证书，需要在系统里信任该证书后再试。",
			action: "trust-cert",
			retryable: false,
		};
	}
	const known = DEFAULT_FAILURES[status];
	if (known) return { ...known };
	return {
		code: "server",
		title: `服务方返回 ${status}`,
		detail: "多是服务端临时故障，稍后重试；持续出现请查看服务方状态页。",
		action: "retry-later",
		retryable: true,
	};
}

// ------------------------------------------------------------- 向导状态机

export type WizardStep =
	| "pick-provider"
	| "credentials"
	| "verify"
	| "scope"
	| "first-sync"
	| "done";
export type WizardState = { step: WizardStep; failure?: Failure };

export type WizardEvent =
	| { type: "pick"; presetId: string }
	| { type: "submit" }
	| { type: "verified" }
	| { type: "failed"; failure: Failure }
	| { type: "confirm-scope" }
	| { type: "synced" }
	| { type: "back" };

/** 五步向导：允许退一步，但失败只能退回凭据或原地重试，不允许跳步。 */
export function reduceWizard(state: WizardState, event: WizardEvent): WizardState {
	switch (event.type) {
		case "pick":
			return state.step === "pick-provider" ? { step: "credentials" } : state;
		case "submit":
			return state.step === "credentials" ? { step: "verify" } : state;
		case "verified":
			return state.step === "verify" ? { step: "scope" } : state;
		case "failed":
			return state.step === "verify" ? { step: "credentials", failure: event.failure } : state;
		case "confirm-scope":
			return state.step === "scope" ? { step: "first-sync" } : state;
		case "synced":
			return state.step === "first-sync" ? { step: "done" } : state;
		case "back":
			switch (state.step) {
				case "credentials":
					return { step: "pick-provider" };
				case "scope":
					return { step: "credentials" };
				default:
					return state;
			}
	}
}
