// AgentReader WebDAV 一条龙接入：服务预设表 + 连接逻辑 原型与验证
//
// 对应 docs/sync-webdav-plan.md 的 §2~§4。这里不含网络 IO，只把「一条龙」里
// 所有会出错、需要确定性的部分抽成纯函数，便于单测与后续搬进主进程：
//   C1 端点归一化：裸域名 / 尾斜杠 / http / 带 userinfo / 带 query 的处理
//   C2 预设解析：哪些服务能「只填账号」，哪些必须先生成应用密码
//   C3 InfiniCLOUD 的 node 反查：把用户专属 WebDAV URL 从 REST 返回里取出来
//   C4 错误分类：把 HTTP 状态码翻成人话 + 下一步动作
//   C5 向导状态机：五步走的合法迁移
//   C6 请求预算：坚果云 600/30min 的余量核算
//
// 运行：node --experimental-strip-types docs/research/webdav-presets.ts
// 预期：以 ok 开头的若干行，最后一行 summary

import assert from "node:assert";

// ---------------------------------------------------------------- 预设类型

export type AuthKind = "account" | "app-password" | "token";

export type SyncPreset = {
	id: string;
	label: string;
	region: "cn" | "global" | "self";
	/** account：账号密码可直连（真正的「登录即用」）；app-password：必须在服务方先生成应用密码 */
	authKind: AuthKind;
	/** 固定端点；null 表示必须由用户填（自建 / Nextcloud / 群晖） */
	endpoint: string | null;
	/** 端点不是固定的，但可以用服务方 REST API 反查（InfiniCLOUD 专属） */
	endpointProbe?: { restUrl: string; apiKeyHeader: string };
	signupUrl?: string;
	passwordHelpUrl?: string;
	quotaNote: string;
	caveats: string[];
	caps: { maxObjectSize: number; requestBudgetPerMinute: number };
	/**
	 * 同一个状态码在不同服务上语义不同的地方，在这里覆盖。
	 * 目前只有 Koofr 的 429（不是限流，是密码错误导致的账号锁定）。
	 */
	statusOverrides?: Record<number, StatusOverride>;
};

/**
 * 预设表。把「用户要背的知识」从这里搬到代码里——这是「一条龙」的全部意义。
 * 数据来源见 docs/sync-webdav-plan.md §1：坚果云帮助中心 2064、InfiniCLOUD
 * developer_auth / developer_restapiv2 两页。
 */
export const PRESETS: SyncPreset[] = [
	{
		id: "jianguoyun",
		label: "坚果云",
		region: "cn",
		authKind: "app-password",
		endpoint: "https://dav.jianguoyun.com/dav/",
		signupUrl: "https://www.jianguoyun.com/",
		passwordHelpUrl: "https://help.jianguoyun.com/?p=2064",
		quotaNote: "免费版每月上传 1GB / 下载 3GB，单文件 500MB",
		caveats: [
			"必须在「账户信息 → 安全选项 → 第三方应用管理」生成应用密码，账号密码不能用于 WebDAV",
			"免费版 600 请求 / 30 分钟，列目录一次最多 750 项",
		],
		caps: { maxObjectSize: 500 * 1024 * 1024, requestBudgetPerMinute: 20 },
	},
	{
		id: "infinicloud",
		label: "InfiniCLOUD",
		region: "global",
		authKind: "app-password",
		endpoint: null, // 每账号一个 node 子域，用 REST 反查（见 probeInfinicloud）
		endpointProbe: {
			restUrl: "https://api.infini-cloud.net/v2/api/ba/user",
			apiKeyHeader: "X-InfiniCLOUD-API-KEY",
		},
		signupUrl: "https://infini-cloud.net/en/",
		passwordHelpUrl: "https://infini-cloud.net/en/use_app-link.html",
		quotaNote: "免费 20GB，不限流量",
		caveats: [
			"需在 My Page 打开「外部应用连接」并生成 App Password",
			"WebDAV 地址按账号不同，本应用会用 REST API 自动反查，无需手填",
			"反查需要应用侧的 API KEY（需向官方申请，个人 / 开源均可）",
		],
		caps: { maxObjectSize: 1024 * 1024 * 1024, requestBudgetPerMinute: 60 },
	},
	{
		id: "koofr",
		label: "Koofr",
		region: "global",
		authKind: "app-password",
		endpoint: "https://app.koofr.net/dav/Koofr/",
		signupUrl: "https://koofr.eu/",
		passwordHelpUrl: "https://koofr.eu/help/koofr_with_webdav/how-do-i-connect-a-service-to-koofr-through-webdav/",
		quotaNote: "免费 10GB（另有 10GB 邀请赠送空间）",
		caveats: [
			"必须生成「应用特定密码」，登录密码连不上（官方原文：没有应用密码就无法建立 WebDAV 连接）",
			"端点大小写敏感：/dav/Koofr 里的 K 必须大写，写成 /dav/koofr 会 404",
			"它的 429 不是限流，是密码错太多次导致账号锁定 1 小时——此时不要重试",
			"每台设备建议单独生成一个应用密码，方便日后单独吊销",
		],
		caps: { maxObjectSize: 512 * 1024 * 1024, requestBudgetPerMinute: 60 },
		statusOverrides: {
			429: {
				code: "locked-out",
				title: "账号被临时锁定 1 小时",
				detail:
					"Koofr 的 429 不是请求太频繁，而是密码错误次数过多触发了保护：账号会被锁 1 小时，期间重试只会延长锁定。请确认填的是「应用特定密码」，而不是登录密码。",
				action: "open-help",
				retryable: false,
			},
		},
	},
	{
		id: "nextcloud",
		label: "Nextcloud / ownCloud",
		region: "self",
		authKind: "account",
		endpoint: null,
		quotaNote: "取决于你的部署",
		caveats: ["端点形如 https://your.host/remote.php/dav/files/<用户名>/", "账号密码可直接直连"],
		caps: { maxObjectSize: 2 * 1024 * 1024 * 1024, requestBudgetPerMinute: 120 },
	},
	{
		id: "synology",
		label: "群晖 WebDAV Server",
		region: "self",
		authKind: "account",
		endpoint: null,
		quotaNote: "取决于你的 NAS",
		caveats: ["端点形如 https://nas.local:5006/（需在套件中心启用 WebDAV Server）", "自签证书需在系统里信任"],
		caps: { maxObjectSize: 4 * 1024 * 1024 * 1024, requestBudgetPerMinute: 120 },
	},
	{
		id: "custom",
		label: "其他 WebDAV",
		region: "self",
		authKind: "account",
		endpoint: null,
		quotaNote: "—",
		caveats: ["需要完整端点、用户名、密码"],
		caps: { maxObjectSize: 512 * 1024 * 1024, requestBudgetPerMinute: 60 },
	},
];

export const presetById = (id: string) => PRESETS.find((p) => p.id === id);

// ------------------------------------------------------------- C1 端点归一化

export type EndpointResult =
	| { ok: true; url: string }
	| { ok: false; code: "empty" | "not-https" | "has-query" | "has-userinfo" | "not-url"; message: string };

/**
 * 用户手填端点时的归一化。三条规则来自真实踩坑：
 * - 必须 https（Basic 认证明文，http 等于把密码写在明信片上）
 * - 去掉 query / fragment（WebDAV 端点不接受）
 * - 去掉 URL 里的 user:pass（很多网盘的文档示例带，用户会整段粘贴）
 * - 统一补尾斜杠（PROPFIND 的 Depth 语义要求目录 URL 以 / 结尾）
 */
export function normalizeEndpoint(input: string): EndpointResult {
	const raw = input.trim();
	if (!raw) return { ok: false, code: "empty", message: "请填写 WebDAV 地址" };
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return { ok: false, code: "not-url", message: "这不像一个完整地址，需要以 https:// 开头" };
	}
	if (u.protocol !== "https:") return { ok: false, code: "not-https", message: "WebDAV 必须用 https://" };
	if (u.username || u.password)
		return { ok: false, code: "has-userinfo", message: "地址里不要带用户名密码，请填到下面的输入框" };
	if (u.search || u.hash) return { ok: false, code: "has-query", message: "地址里不能带 ? 或 # 后面的内容" };
	const path = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
	return { ok: true, url: `${u.origin}${path}` };
}

// --------------------------------------------------- C2 预设 → 需要用户填什么

export type CredentialField = "endpoint" | "account" | "secret";

export function requiredFields(preset: SyncPreset): CredentialField[] {
	if (preset.endpoint) return ["account", "secret"];
	// InfiniCLOUD 的端点能反查，所以用户不用填
	if (preset.endpointProbe) return ["account", "secret"];
	return ["endpoint", "account", "secret"];
}

/** 「一条龙」成色：能不能真的只填账号密码就用。 */
export function oneClickLevel(preset: SyncPreset): "full" | "guided" {
	return preset.authKind === "account" ? "full" : "guided";
}

// ------------------------------------------- C3 InfiniCLOUD 的 WebDAV 地址反查

export const INFINICLOUD_BA_USER_KEY_PLACEHOLDER = "APP_API_KEY";

/** BASIC 认证 + API KEY，官方文档给的初始注册接口。 */
export function buildInfinicloudUserRequest(preset: SyncPreset, account: string, appPassword: string) {
	if (!preset.endpointProbe) throw new Error("该预设不支持端点反查");
	return {
		url: preset.endpointProbe.restUrl,
		headers: {
			Authorization: `Basic ${Buffer.from(`${account}:${appPassword}`).toString("base64")}`,
			[preset.endpointProbe.apiKeyHeader]: INFINICLOUD_BA_USER_KEY_PLACEHOLDER,
			Accept: "application/json",
		},
	};
}

export type ProbeResult = { ok: true; webdavUrl: string; node: string } | { ok: false; message: string };

/**
 * 解析 `GET /v2/api/ba/user` 的返回。
 * 官方示例：{"result":0,"node":"ise.teracloud.jp","webdav_url":"https://ise.teracloud.jp/dav/",…}
 * 注意 result 非 0 时也可能是 HTTP 200，所以必须看 body 而不是只看状态码。
 */
export function parseInfinicloudUser(json: unknown): ProbeResult {
	if (!json || typeof json !== "object") return { ok: false, message: "返回内容无法解析" };
	const o = json as Record<string, unknown>;
	if (o.result !== 0) return { ok: false, message: `服务返回错误（result=${String(o.result)}），请检查账号与应用密码` };
	const webdav = typeof o.webdav_url === "string" ? o.webdav_url : "";
	if (!webdav) return { ok: false, message: "未取得 WebDAV 地址，可能账号尚未开通数据区" };
	const node = typeof o.node === "string" ? o.node : "";
	const normalized = normalizeEndpoint(webdav);
	if (!normalized.ok) return { ok: false, message: `返回的地址不可用：${normalized.message}` };
	return { ok: true, webdavUrl: normalized.url, node };
}

// ------------------------------------------------------------- C4 错误分类

export type FailureCode =
	| "unauthorized"
	| "forbidden"
	| "not-found"
	| "method-not-allowed"
	| "locked"
	| "rate-limited"
	| "locked-out"
	| "quota"
	| "server"
	| "network"
	| "tls";

export type FailureAction =
	| "check-credentials"
	| "open-help"
	| "retry-later"
	| "trust-cert"
	| "reduce-requests";

export type Failure = {
	code: FailureCode;
	title: string;
	detail: string;
	/** 给界面的下一步动作；action 为 "open-help" 时按钮跳到 preset.passwordHelpUrl */
	action?: FailureAction;
	/**
	 * 引擎是否可以自动重试。`rate-limited` 要退避重试，`locked-out`（密码错太多次
	 * 被锁）绝对不能重试——越重试锁得越久。这条字段把「文案」和「调度行为」分开，
	 * 避免把一句提示写在 UI 里、引擎却在后台继续打。
	 */
	retryable: boolean;
};

/** 按服务覆盖某个状态码的语义（同一个 429 在不同服务上含义完全不同）。 */
export type StatusOverride = {
	code: FailureCode;
	title: string;
	detail: string;
	action?: FailureAction;
	retryable: boolean;
};

/**
 * WebDAV 的失败信息几乎全是状态码，直接抛给用户等于没说。
 * 这张表是「一条龙」体验的另一半：每一种失败都要给出下一个动作。
 */
export function classifyFailure(
	status: number | "network" | "tls",
	ctx: { preset?: SyncPreset } = {},
): Failure {
	// 服务级覆盖优先：同一个状态码在不同服务上含义可能完全不同（Koofr 429 = 账号锁定）
	if (typeof status === "number") {
		const override = ctx.preset?.statusOverrides?.[status];
		if (override) return { ...override };
	}
	const isAppPassword = ctx.preset?.authKind === "app-password";
	if (status === "network")
		return {
			code: "network",
			title: "连不上服务器",
			detail: "检查网络或代理设置；坚果云 / InfiniCLOUD 在国内一般可直连。",
			action: "retry-later",
			retryable: true,
		};
	if (status === "tls")
		return {
			code: "tls",
			title: "证书校验失败",
			detail: "自建服务常用自签证书，需要在系统里信任该证书后再试。",
			action: "trust-cert",
			retryable: false,
		};
	switch (status) {
		case 401:
			return {
				code: "unauthorized",
				title: isAppPassword ? "账号或应用密码不对" : "用户名或密码不对",
				detail: isAppPassword
					? "坚果云 / InfiniCLOUD / Koofr 的 WebDAV 不接受登录密码，必须用「应用密码」。点右侧按钮可以直接跳到生成页面。"
					: "确认账号密码无误；若开启了二次验证，可能需要改用应用密码。",
				action: "open-help",
				retryable: false,
			};
		case 403:
			return {
				code: "forbidden",
				title: "没有权限",
				detail:
					"凭据正确但该目录不可写。InfiniCLOUD 需要先在 My Page 打开「外部应用连接」；坚果云请确认应用密码未被撤销。",
				action: "open-help",
				retryable: false,
			};
		case 404:
			return {
				code: "not-found",
				title: "地址不对",
				detail: "服务器可达但路径不存在。检查端点后缀（坚果云 /dav/、Koofr /dav/Koofr，注意大小写）。",
				action: "check-credentials",
				retryable: false,
			};
		case 405:
			return {
				code: "method-not-allowed",
				title: "这个地址不支持 WebDAV",
				detail: "地址可能是网盘的网页入口或 API 入口，不是 WebDAV 端点。",
				action: "open-help",
				retryable: false,
			};
		case 412:
			return {
				code: "server",
				title: "条件写被服务方拒绝（412）",
				detail:
					"远端文件在你读取之后被别的设备改过。这通常说明两台机器同时同步，本应用会重新拉取后重试；持续出现请反馈。",
				action: "retry-later",
				retryable: true,
			};
		case 423:
			return {
				code: "locked",
				title: "文件被锁定",
				detail:
					"另一个客户端占了文件锁且没释放（Koofr 常见）。稍后会自动重试；持续出现请关闭其他同步工具。",
				action: "retry-later",
				retryable: true,
			};
		case 429:
			return {
				code: "rate-limited",
				title: "请求太频繁",
				detail: "已触发服务方限流（坚果云免费版 600 次 / 30 分钟），本应用会自动退避，无需操作。",
				action: "reduce-requests",
				retryable: true,
			};
		case 507:
			return {
				code: "quota",
				title: "云端空间已满",
				detail: "清理网盘空间，或关闭「同步原书」只同步笔记与设置。",
				action: "retry-later",
				retryable: false,
			};
		default:
			return {
				code: "server",
				title: `服务方返回 ${status}`,
				detail: "多是服务端临时故障，稍后重试；持续出现请查看服务方状态页。",
				action: "retry-later",
				retryable: true,
			};
	}
}

// ------------------------------------------------------------- C5 向导状态机

export type WizardStep = "pick-provider" | "credentials" | "verify" | "scope" | "first-sync" | "done";
export type WizardState = { step: WizardStep; failure?: Failure };

export type WizardEvent =
	| { type: "pick"; presetId: string }
	| { type: "submit" }
	| { type: "verified" }
	| { type: "failed"; failure: Failure }
	| { type: "confirm-scope" }
	| { type: "synced" }
	| { type: "back" };

/** 五步向导：允许「退一步」，但失败只能退回凭据或原地重试，不允许跳步。 */
export function reduceWizard(state: WizardState, ev: WizardEvent): WizardState {
	switch (ev.type) {
		case "pick":
			return state.step === "pick-provider" ? { step: "credentials" } : state;
		case "submit":
			return state.step === "credentials" ? { step: "verify" } : state;
		case "verified":
			return state.step === "verify" ? { step: "scope" } : state;
		case "failed":
			return state.step === "verify" ? { step: "credentials", failure: ev.failure } : state;
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

// ------------------------------------------------------------- C6 请求预算

/**
 * 一次同步的请求数。坚果云免费版 600/30min 是硬约束，所以「一本书一个状态文件」
 * 的设计必须能被算出来，而不是估。
 */
export function estimateRequests(ops: { pulls: number; pushes: number; hasSettings: boolean }): number {
	const manifest = 1; // GET manifest
	const settings = ops.hasSettings ? 2 : 0; // GET + PUT
	const files = ops.pulls + ops.pushes; // 书库状态按文件计
	const verify = ops.pushes; // 写后回读
	return manifest + settings + files + verify;
}

export function withinBudget(preset: SyncPreset, requests: number): { ok: boolean; usedPercent: number } {
	const budget = preset.caps.requestBudgetPerMinute * 30;
	return { ok: requests <= budget, usedPercent: Math.round((requests / budget) * 100) };
}

// ------------------------------------------------------------------- 测试

{
	// C1
	assert.deepEqual(normalizeEndpoint("https://dav.jianguoyun.com/dav"), {
		ok: true,
		url: "https://dav.jianguoyun.com/dav/",
	});
	assert.equal(normalizeEndpoint("http://x.com/dav").ok, false);
	assert.equal(normalizeEndpoint("https://u:p@x.com/dav").ok, false);
	assert.equal(normalizeEndpoint("https://x.com/dav?a=1").ok, false);
	assert.equal(normalizeEndpoint("x.com/dav").ok, false);
	assert.deepEqual(normalizeEndpoint("  https://x.com  "), { ok: true, url: "https://x.com/" });
	console.log("ok C1 端点归一化：补尾斜杠 / 拒 http / 拒 userinfo / 拒 query");
}

{
	// C2
	const jgy = presetById("jianguoyun");
	const nc = presetById("nextcloud");
	const koofr = presetById("koofr");
	const inf = presetById("infinicloud");
	assert.ok(jgy && nc && koofr && inf);
	assert.deepEqual(requiredFields(jgy), ["account", "secret"], "固定端点时不该让用户填地址");
	assert.deepEqual(requiredFields(nc), ["endpoint", "account", "secret"]);
	assert.equal(oneClickLevel(jgy), "guided", "坚果云必须先生成应用密码");
	assert.equal(oneClickLevel(nc), "full", "Nextcloud 可账号密码直连");
	// Koofr：固定端点 + 必须应用密码 → 用户只填账号与密码，但要去后台生成
	assert.deepEqual(requiredFields(koofr), ["account", "secret"]);
	assert.equal(oneClickLevel(koofr), "guided");
	// Koofr 端点大小写敏感，不能被归一化「修正」
	assert.deepEqual(normalizeEndpoint("https://app.koofr.net/dav/Koofr"), {
		ok: true,
		url: "https://app.koofr.net/dav/Koofr/",
	});
	assert.ok(koofr.caveats.some((c) => c.includes("大小写")));
	// InfiniCLOUD：端点可反查，用户同样不需要填地址
	assert.deepEqual(requiredFields(inf), ["account", "secret"]);
	console.log("ok C2 预设：仅自建类需要填地址；坚果云/Koofr 是 guided，Nextcloud 是 full；Koofr 端点大小写被保留");
}

{
	// C3
	const inf = presetById("infinicloud");
	assert.ok(inf);
	const okJson = {
		result: 0,
		node: "ise.teracloud.jp",
		webdav_url: "https://ise.teracloud.jp/dav/",
		user: "alice",
	};
	const ok = parseInfinicloudUser(okJson);
	assert.equal(ok.ok, true);
	assert.equal(ok.ok && ok.webdavUrl, "https://ise.teracloud.jp/dav/");
	const bad = parseInfinicloudUser({ result: 1, message: "invalid" });
	assert.equal(bad.ok, false);
	// 无尾斜杠的返回也要能用
	const sloppy = parseInfinicloudUser({ result: 0, node: "x", webdav_url: "https://x.infini-cloud.net/dav" });
	assert.equal(sloppy.ok && sloppy.webdavUrl, "https://x.infini-cloud.net/dav/");
	assert.equal(parseInfinicloudUser(null).ok, false);
	console.log("ok C3 InfiniCLOUD：result≠0 也算失败；webdav_url 自动归一化");
}

{
	// C4
	const jgy = presetById("jianguoyun");
	const koofr = presetById("koofr");
	assert.ok(jgy && koofr);
	const f401 = classifyFailure(401, { preset: jgy });
	assert.equal(f401.code, "unauthorized");
	assert.ok(f401.detail.includes("应用密码"));
	assert.equal(f401.action, "open-help");
	assert.equal(f401.retryable, false, "凭据错不该自动重试");
	assert.equal(classifyFailure(429).code, "rate-limited");
	assert.equal(classifyFailure(429).retryable, true);
	assert.equal(classifyFailure(507).code, "quota");
	assert.equal(classifyFailure("tls").action, "trust-cert");
	assert.equal(classifyFailure(418).code, "server");

	// 同一个 429，在 Koofr 上语义完全不同：密码错太多次导致的账号锁定
	const k429 = classifyFailure(429, { preset: koofr });
	assert.equal(k429.code, "locked-out");
	assert.equal(k429.retryable, false, "账号锁定时重试只会延长锁定");
	assert.ok(k429.detail.includes("1 小时"));
	// 坚果云没有覆盖，仍按限流处理
	assert.equal(classifyFailure(429, { preset: jgy }).code, "rate-limited");
	// 412：条件写被拒 → 可重试（重新拉取后重试）
	assert.equal(classifyFailure(412).retryable, true);
	console.log("ok C4 错误分类：每种失败都给下一个动作；429 在 Koofr 上是「账号锁定」且禁止重试");
}

{
	// C5
	let s: WizardState = { step: "pick-provider" };
	s = reduceWizard(s, { type: "submit" }); // 跳步无效
	assert.equal(s.step, "pick-provider");
	s = reduceWizard(s, { type: "pick", presetId: "jianguoyun" });
	s = reduceWizard(s, { type: "submit" });
	assert.equal(s.step, "verify");
	s = reduceWizard(s, { type: "failed", failure: classifyFailure(401) });
	assert.equal(s.step, "credentials");
	assert.ok(s.failure);
	s = reduceWizard(s, { type: "submit" });
	s = reduceWizard(s, { type: "verified" });
	assert.equal(s.step, "scope");
	s = reduceWizard(s, { type: "confirm-scope" });
	s = reduceWizard(s, { type: "synced" });
	assert.equal(s.step, "done");
	console.log("ok C5 状态机：不可跳步，认证失败回退到凭据步并携带原因");
}

{
	// C6
	const jgy = presetById("jianguoyun");
	assert.ok(jgy);
	// 50 本书、本次 3 本有变化、带设置
	const n = estimateRequests({ pulls: 3, pushes: 3, hasSettings: true });
	assert.equal(n, 1 + 2 + 6 + 3);
	const b = withinBudget(jgy, n);
	assert.equal(b.ok, true);
	assert.ok(b.usedPercent <= 5, `一次同步应远低于配额，实际 ${b.usedPercent}%`);
	// 50 本全变
	const worst = estimateRequests({ pulls: 50, pushes: 50, hasSettings: true });
	assert.equal(withinBudget(jgy, worst).ok, true);
	console.log(
		`ok C6 请求预算：常规 ${n} 次（占 30 分钟配额 ${b.usedPercent}%），50 本全变 ${worst} 次仍在 600 以内`,
	);
}

console.log("summary: WebDAV 一条龙接入的预设表 / 归一化 / 反查 / 错误映射 / 状态机 / 预算 全部通过");
