/**
 * 把 GitHub Release JSON 翻译成 UpdateInfo：选出版本、正文，以及**当前平台该下哪个文件**。
 *
 * 资产命名来自 electron-builder 的模板：
 * - macOS：`AgentReader-0.4.0-arm64.dmg`
 * - Windows：`AgentReader-Setup-0.4.0.exe`
 * - Linux：`AgentReader-0.4.0-x86_64.AppImage`
 *
 * 同时发布 `.blockmap`、`latest*.yml` 等辅助文件，它们必须被排除，否则可能被当成安装包。
 * 这里不信任文件名里的架构标记能覆盖所有情况：认不出架构的文件按「通用包」处理，
 * 但**明确标了别的架构**的文件一定会被排除（避免在 arm64 上下载 x64 的安装包）。
 */

import type {
	UpdateAsset,
	UpdateAssetKind,
	UpdateChecksum,
	UpdateInfo,
	UpdatePlatform,
} from "../../shared/update.ts";
import { compareVersions, formatVersion, parseVersion } from "./version.ts";

/** GitHub Release 资产（只声明用得到的字段）。 */
export type GithubAssetJson = {
	name?: string;
	size?: number;
	browser_download_url?: string;
	digest?: string | null;
	state?: string;
};

export type GithubReleaseJson = {
	tag_name?: string;
	name?: string | null;
	body?: string | null;
	html_url?: string;
	prerelease?: boolean;
	draft?: boolean;
	published_at?: string | null;
	assets?: GithubAssetJson[];
};

/** Release 正文可能非常长（自动生成的 changelog），截断后再跨进程传输。 */
const MAX_NOTES = 64 * 1024;

const KIND_BY_EXT: Record<string, UpdateAssetKind> = {
	dmg: "dmg",
	zip: "zip",
	exe: "exe",
	msi: "msi",
	appimage: "appimage",
	deb: "deb",
	rpm: "rpm",
};

/** 每个平台可接受的安装包类型及优先级（分高者优先）。 */
const PLATFORM_KINDS: Record<UpdatePlatform, Partial<Record<UpdateAssetKind, number>>> = {
	mac: { dmg: 40, zip: 25 },
	win: { exe: 40, msi: 25 },
	linux: { appimage: 40, deb: 25, rpm: 15 },
};

/** 这些后缀是发布辅助文件，永远不是安装包。 */
const NON_INSTALLER_EXT = new Set([
	"blockmap",
	"yml",
	"yaml",
	"json",
	"txt",
	"md",
	"sig",
	"asc",
	"sha256",
	"sha512",
	"md5",
	"zsync",
	"pem",
]);

export function assetKind(name: string): UpdateAssetKind | null {
	const lower = name.toLowerCase();
	const dot = lower.lastIndexOf(".");
	if (dot < 0 || dot === lower.length - 1) return null;
	const ext = lower.slice(dot + 1);
	if (NON_INSTALLER_EXT.has(ext)) return null;
	return KIND_BY_EXT[ext] ?? null;
}

/** 从文件名推断架构；识别不出返回 null（按通用包处理）。 */
export function assetArch(name: string): string | null {
	const lower = name.toLowerCase();
	if (/universal|universal2/.test(lower)) return "universal";
	if (/arm64|aarch64/.test(lower)) return "arm64";
	if (/x86[_-]64|amd64|x64/.test(lower)) return "x64";
	if (/ia32|i386|win32/.test(lower)) return "ia32";
	return null;
}

/** `sha256:<hex>`（GitHub `digest` 字段）→ 小写 hex。 */
export function parseSha256(input: string | null | undefined): string | null {
	if (typeof input !== "string") return null;
	const match = /^(?:sha256:)?([a-f0-9]{64})$/i.exec(input.trim());
	return match ? match[1].toLowerCase() : null;
}

function toAsset(json: GithubAssetJson): UpdateAsset | null {
	const name = json.name;
	const url = json.browser_download_url;
	if (!name || !url) return null;
	// 只接受 https，避免发布方误配 http 镜像把安装包降级成明文分发。
	if (!/^https:\/\//i.test(url)) return null;
	const kind = assetKind(name);
	if (!kind) return null;
	const size = typeof json.size === "number" && json.size > 0 ? json.size : 0;
	return {
		name,
		size,
		url,
		kind,
		arch: assetArch(name),
		sha256: parseSha256(json.digest),
	};
}

/**
 * 给一个资产打分；不属于该平台/架构返回 null。
 *
 * 架构不匹配的文件会先被排除，因此分数以**安装包类型**为主（NSIS Setup 能用
 * `/S --force-run` 静默安装并重启，dmg 能自动覆盖；zip/msi 只能退化处理），
 * 类型相同时再看架构：精确匹配 > universal > 未标架构。
 */
export function scoreAsset(
	asset: UpdateAsset,
	platform: UpdatePlatform,
	arch: string,
): number | null {
	const kindScore = PLATFORM_KINDS[platform][asset.kind];
	if (kindScore === undefined) return null;
	let archScore: number;
	if (asset.arch === null) archScore = 15;
	else if (asset.arch === "universal") archScore = 60;
	else if (asset.arch === arch) archScore = 100;
	else return null;
	// `AgentReader-Setup-0.4.0.exe` 是安装包；同目录里的 `*-debug.exe`、符号包不该被选中。
	if (/debug|symbols|pdb|\btest\b/i.test(asset.name)) return null;
	return kindScore * 10 + archScore;
}

export function pickAsset(
	assets: UpdateAsset[],
	platform: UpdatePlatform,
	arch: string,
): UpdateAsset | null {
	let best: UpdateAsset | null = null;
	let bestScore = -1;
	for (const asset of assets) {
		const score = scoreAsset(asset, platform, arch);
		if (score === null || score <= bestScore) continue;
		best = asset;
		bestScore = score;
	}
	return best;
}

export function checksumOf(asset: UpdateAsset | null): UpdateChecksum {
	if (!asset) return "none";
	if (asset.sha256) return "sha256";
	if (asset.size > 0) return "size";
	return "none";
}

/** 单个 Release → UpdateInfo；tag 不是版本号时返回 null。 */
export function releaseInfo(
	release: GithubReleaseJson,
	platform: UpdatePlatform,
	arch: string,
): UpdateInfo | null {
	const tag = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
	const version = parseVersion(tag);
	if (!version) return null;
	const assets = (release.assets ?? [])
		.filter((a) => a && (a.state === undefined || a.state === "uploaded"))
		.map(toAsset)
		.filter((a): a is UpdateAsset => a !== null);
	const asset = pickAsset(assets, platform, arch);
	const body = typeof release.body === "string" ? release.body : "";
	return {
		version: formatVersion(version),
		tag,
		name: (release.name ?? "").trim() || tag,
		notes: body.slice(0, MAX_NOTES),
		url: release.html_url ?? "",
		publishedAt: release.published_at ?? null,
		prerelease: release.prerelease === true,
		asset,
		assets,
		checksum: checksumOf(asset),
	};
}

/**
 * 从 Release 列表里挑「最新可安装版本」。
 *
 * 只认非草稿；预发布是否参与由 includePrerelease 决定。**优先选当前平台有安装包的版本**：
 * 最新版如果漏传了本平台产物，退回上一个能装的版本，比弹一个只能「去网页看看」的更新有用。
 */
export function pickLatestRelease(
	releases: GithubReleaseJson[],
	opts: { includePrerelease: boolean; platform: UpdatePlatform; arch: string },
): UpdateInfo | null {
	const infos: UpdateInfo[] = [];
	for (const release of releases) {
		if (!release || release.draft === true) continue;
		if (release.prerelease === true && !opts.includePrerelease) continue;
		const info = releaseInfo(release, opts.platform, opts.arch);
		if (info) infos.push(info);
	}
	infos.sort((a, b) => {
		const va = parseVersion(a.version);
		const vb = parseVersion(b.version);
		if (!va || !vb) return 0;
		return compareVersions(vb, va);
	});
	return infos.find((info) => info.asset !== null) ?? infos[0] ?? null;
}

/** 找发布方附带的校验和文件（GitHub 老资产没有 digest 时兜底）。 */
export function findChecksumAsset(releasesAssets: GithubAssetJson[]): GithubAssetJson | null {
	for (const asset of releasesAssets) {
		const name = (asset.name ?? "").toLowerCase();
		if (/^(sha256sums?|checksums?)(\.txt)?$/.test(name) && asset.browser_download_url) {
			return asset;
		}
	}
	return null;
}

/** 解析 `sha256sum` 格式（`<hex>  <文件名>`，兼容 `*` 前缀）。 */
export function parseChecksumFile(text: string, fileName: string): string | null {
	const wanted = fileName.trim().toLowerCase();
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(trimmed);
		if (!match) continue;
		if (match[2].trim().toLowerCase() === wanted) return match[1].toLowerCase();
	}
	return null;
}
