import type { FailureAction, FailureCode } from "./types.ts";

/**
 * WebDAV 服务的预设表。
 *
 * 「一条龙」的全部意义在这张表里：用户不需要知道端点长什么样、去哪生成应用密码、
 * 免费额度是多少。表里同时存了三件事——端点、帮助页、以及**服务方特有的错误语义**。
 *
 * 数据来源与核对时间见 docs/sync-webdav-plan.md §1。
 */

export type AuthKind = "account" | "app-password" | "token";

export type StatusOverride = {
	code: FailureCode;
	title: string;
	detail: string;
	action?: FailureAction;
	retryable: boolean;
};

export type WebdavPreset = {
	id: string;
	label: string;
	region: "cn" | "global" | "self";
	/** account：账号密码可直连；app-password：必须在服务方先生成应用密码 */
	authKind: AuthKind;
	/** 固定端点；null 表示要用户填（自建 / Nextcloud / 群晖），或由 Familylink 反查 */
	endpoint: string | null;
	/** InfiniCLOUD：用 REST 反查该账号专属的 WebDAV 地址 */
	endpointProbe?: { restUrl: string; apiKeyHeader: string; apiKey: string };
	signupUrl?: string;
	passwordHelpUrl?: string;
	quotaNote: string;
	caveats: string[];
	caps: { maxObjectSize: number; requestBudgetPerMinute: number; paginatedListLimit: number };
	statusOverrides?: Record<number, StatusOverride>;
};

export const WEBDAV_PRESETS: WebdavPreset[] = [
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
			"必须在「账户信息 → 安全选项 → 第三方应用管理」生成应用密码，登录密码不能用于 WebDAV",
			"免费版 600 请求 / 30 分钟，列目录一次最多 750 项",
			"建议每台设备单独生成一个应用密码，方便单独吊销",
		],
		caps: {
			maxObjectSize: 500 * 1024 * 1024,
			requestBudgetPerMinute: 20,
			paginatedListLimit: 750,
		},
	},
	{
		id: "infinicloud",
		label: "InfiniCLOUD",
		region: "global",
		authKind: "app-password",
		endpoint: null,
		// API KEY 需要向官方申请（个人 / 开源均可）；留空时自动退回「手填地址」
		endpointProbe: {
			restUrl: "https://api.infini-cloud.net/v2/api/ba/user",
			apiKeyHeader: "X-InfiniCLOUD-API-KEY",
			apiKey: "",
		},
		signupUrl: "https://infini-cloud.net/en/",
		passwordHelpUrl: "https://infini-cloud.net/en/use_app-link.html",
		quotaNote: "免费 20GB，不限流量",
		caveats: [
			"需要在 My Page 打开「外部应用连接」并生成 App Password",
			"WebDAV 地址按账号不同；若没有 API KEY，请手动填写 My Page 里给出的地址",
		],
		caps: {
			maxObjectSize: 1024 * 1024 * 1024,
			requestBudgetPerMinute: 60,
			paginatedListLimit: 1000,
		},
	},
	{
		id: "koofr",
		label: "Koofr",
		region: "global",
		authKind: "app-password",
		endpoint: "https://app.koofr.net/dav/Koofr/",
		signupUrl: "https://koofr.eu/",
		passwordHelpUrl:
			"https://koofr.eu/help/koofr_with_webdav/how-do-i-connect-a-service-to-koofr-through-webdav/",
		quotaNote: "免费 10GB（另有邀请赠送空间）",
		caveats: [
			"必须生成「应用特定密码」，登录密码连不上",
			"端点大小写敏感：/dav/Koofr 里的 K 必须大写",
			"它的 429 是密码错太多次导致的账号锁定 1 小时，不是限流——此时不能重试",
		],
		caps: {
			maxObjectSize: 512 * 1024 * 1024,
			requestBudgetPerMinute: 60,
			paginatedListLimit: 1000,
		},
		statusOverrides: {
			429: {
				code: "locked-out",
				title: "账号被临时锁定 1 小时",
				detail:
					"Koofr 的 429 不是请求太频繁，而是密码错误次数过多触发了保护：账号会被锁 1 小时，期间重试只会延长锁定。请确认填的是「应用特定密码」。",
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
		caps: {
			maxObjectSize: 2 * 1024 * 1024 * 1024,
			requestBudgetPerMinute: 120,
			paginatedListLimit: 2000,
		},
	},
	{
		id: "synology",
		label: "群晖 WebDAV Server",
		region: "self",
		authKind: "account",
		endpoint: null,
		quotaNote: "取决于你的 NAS",
		caveats: [
			"端点形如 https://nas.local:5006/（需在套件中心启用 WebDAV Server）",
			"自签证书需要在系统里信任",
		],
		caps: {
			maxObjectSize: 4 * 1024 * 1024 * 1024,
			requestBudgetPerMinute: 120,
			paginatedListLimit: 2000,
		},
	},
	{
		id: "custom",
		label: "其他 WebDAV",
		region: "self",
		authKind: "account",
		endpoint: null,
		quotaNote: "—",
		caveats: ["需要完整端点、用户名与密码"],
		caps: {
			maxObjectSize: 512 * 1024 * 1024,
			requestBudgetPerMinute: 60,
			paginatedListLimit: 1000,
		},
	},
];

export function getWebdavPreset(id: string): WebdavPreset | undefined {
	return WEBDAV_PRESETS.find((preset) => preset.id === id);
}
