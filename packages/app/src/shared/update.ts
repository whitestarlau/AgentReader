/**
 * 自动更新的共享类型（主进程 ↔ 渲染层）。
 *
 * 这里只放**数据形状**：版本比较、资产挑选、下载校验都在 main/update/ 下，
 * 渲染层不复制任何更新逻辑，避免两边对「哪个文件算这个平台的安装包」判断不一致。
 */

export type UpdatePlatform = "mac" | "win" | "linux";

/** 更新状态机。UI 只按 phase 渲染，不自己拼状态。 */
export type UpdatePhase =
	| "idle"
	| "checking"
	| "up-to-date"
	| "available"
	| "downloading"
	| "ready"
	| "installing"
	| "error";

export type UpdateAssetKind = "dmg" | "zip" | "exe" | "msi" | "appimage" | "deb" | "rpm";

export type UpdateAsset = {
	name: string;
	/** GitHub 上的字节数；0 表示未知。 */
	size: number;
	/** browser_download_url（https）。 */
	url: string;
	kind: UpdateAssetKind;
	/** 文件名里的架构标记：arm64 / x64 / ia32 / universal；没写架构时为 null。 */
	arch: string | null;
	/** GitHub Release 的 `digest` 字段（sha256）；老资产可能没有。 */
	sha256: string | null;
};

/** 这次下载能验到什么程度：摘要 > 字节数 > 无从校验。 */
export type UpdateChecksum = "sha256" | "size" | "none";

export type UpdateInfo = {
	/** 归一化后的版本号，例如 `0.4.0` / `0.4.0-beta.1`。 */
	version: string;
	tag: string;
	name: string;
	/** Release 正文（Markdown），已截断到安全长度。 */
	notes: string;
	/** Release 网页地址。 */
	url: string;
	publishedAt: string | null;
	prerelease: boolean;
	/** 按当前平台/架构挑出来的安装包；该 Release 没有对应产物时为 null。 */
	asset: UpdateAsset | null;
	assets: UpdateAsset[];
	checksum: UpdateChecksum;
};

export type UpdateProgress = {
	received: number;
	total: number;
	/** 0–100，total 未知时为 0。 */
	percent: number;
	bytesPerSecond: number;
};

export type UpdateErrorInfo = {
	code: string;
	message: string;
	/** 给用户下一步动作的提示（检查网络 / 去发布页手动下载）。 */
	hint?: string;
};

export type UpdateState = {
	phase: UpdatePhase;
	currentVersion: string;
	platform: UpdatePlatform;
	arch: string;
	/** `owner/repo`，展示用。 */
	repo: string;
	releasePage: string;
	info: UpdateInfo | null;
	progress: UpdateProgress | null;
	/** 下载完成后的本地安装包路径。 */
	downloadPath: string | null;
	/** 该版本被用户「跳过」：自动检查不再提示，手动检查仍然显示。 */
	skipped: boolean;
	error: UpdateErrorInfo | null;
	autoCheck: boolean;
	autoDownload: boolean;
	includePrerelease: boolean;
	/** 上次检查完成时间（毫秒时间戳）。 */
	checkedAt: number | null;
};

export type UpdatePrefsPatch = {
	autoCheck?: boolean;
	includePrerelease?: boolean;
	autoDownload?: boolean;
};

export type UpdateDownloadOptions = {
	/** 下载完成后直接覆盖安装并退出应用（「下载并安装」一键流程）。 */
	install?: boolean;
	/** 丢弃已存在的同名文件，强制重新下载（安装失败后的「重新下载」）。 */
	force?: boolean;
};
