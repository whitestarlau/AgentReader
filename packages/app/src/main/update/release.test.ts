import assert from "node:assert/strict";
import test from "node:test";
import type { UpdateAsset } from "../../shared/update.ts";
import type { GithubReleaseJson } from "./release.ts";
import {
	assetArch,
	assetKind,
	findChecksumAsset,
	parseChecksumFile,
	parseSha256,
	pickLatestRelease,
	releaseInfo,
	scoreAsset,
} from "./release.ts";

const SHA = "9af56193b425836ec05ce78e2081dd12f7573e1faf30a156e916af055940ea61";

/** GitHub API 形状的资产（releaseInfo 的输入）。 */
function ghAsset(
	name: string,
): GithubReleaseJson["assets"] extends (infer T)[] | undefined ? T : never {
	return {
		name,
		size: 1000,
		browser_download_url: `https://github.com/whitestarlau/AgentReader/releases/download/v0.4.0/${name}`,
		state: "uploaded",
	};
}

/** 归一化后的资产（scoreAsset 的输入）。 */
function asset(name: string): UpdateAsset {
	return {
		name,
		size: 1000,
		url: `https://github.com/whitestarlau/AgentReader/releases/download/v0.4.0/${name}`,
		kind: assetKind(name) ?? "dmg",
		arch: assetArch(name),
		sha256: null,
	};
}

function release(overrides: Partial<GithubReleaseJson> = {}): GithubReleaseJson {
	return {
		tag_name: "v0.4.0",
		name: "AgentReader 0.4.0",
		body: "## 更新\n- 支持检查更新",
		html_url: "https://github.com/whitestarlau/AgentReader/releases/tag/v0.4.0",
		prerelease: false,
		draft: false,
		published_at: "2026-11-27T02:00:00Z",
		assets: [
			{
				name: "AgentReader-0.4.0-arm64.dmg",
				size: 1000,
				browser_download_url:
					"https://github.com/whitestarlau/AgentReader/releases/download/v0.4.0/AgentReader-0.4.0-arm64.dmg",
				digest: `sha256:${SHA}`,
				state: "uploaded",
			},
			{
				name: "AgentReader-0.4.0-arm64.dmg.blockmap",
				size: 10,
				browser_download_url:
					"https://github.com/whitestarlau/AgentReader/releases/download/v0.4.0/AgentReader-0.4.0-arm64.dmg.blockmap",
				state: "uploaded",
			},
			{
				name: "AgentReader-Setup-0.4.0.exe",
				size: 1000,
				browser_download_url:
					"https://github.com/whitestarlau/AgentReader/releases/download/v0.4.0/AgentReader-Setup-0.4.0.exe",
				digest: `sha256:${SHA}`,
				state: "uploaded",
			},
		],
		...overrides,
	};
}

test("release helper files are never mistaken for installers", () => {
	assert.equal(assetKind("AgentReader-0.4.0-arm64.dmg"), "dmg");
	assert.equal(assetKind("AgentReader-0.4.0-arm64.dmg.blockmap"), null);
	assert.equal(assetKind("latest-mac.yml"), null);
	assert.equal(assetKind("AgentReader-0.4.0-x86_64.AppImage"), "appimage");
	assert.equal(assetKind("AgentReader-Setup-0.4.0.exe"), "exe");
	assert.equal(assetKind("checksums.txt"), null);
});

test("architecture is read from the file name", () => {
	assert.equal(assetArch("AgentReader-0.4.0-arm64.dmg"), "arm64");
	assert.equal(assetArch("AgentReader-0.4.0-x64.exe"), "x64");
	assert.equal(assetArch("AgentReader-0.4.0-x86_64.AppImage"), "x64");
	assert.equal(assetArch("AgentReader-0.4.0-universal.dmg"), "universal");
	assert.equal(assetArch("AgentReader-Setup-0.4.0.exe"), null);
});

test("macOS arm64 picks the dmg, not the blockmap or the exe", () => {
	const info = releaseInfo(release(), "mac", "arm64");
	assert.ok(info);
	assert.equal(info.version, "0.4.0");
	assert.equal(info.asset?.name, "AgentReader-0.4.0-arm64.dmg");
	assert.equal(info.checksum, "sha256");
	assert.equal(info.asset?.sha256, SHA);
	assert.equal(info.assets.length, 2);
});

test("an architecture mismatch is rejected instead of guessed", () => {
	const macOnly = release({
		assets: [
			{
				name: "AgentReader-0.4.0-x64.dmg",
				size: 1000,
				browser_download_url: "https://github.com/x/AgentReader-0.4.0-x64.dmg",
			},
		],
	});
	assert.equal(releaseInfo(macOnly, "mac", "arm64")?.asset, null);
	// 没写架构的文件按通用包处理。
	const universalName = release({
		assets: [
			{
				name: "AgentReader-0.4.0.dmg",
				size: 1000,
				browser_download_url: "https://github.com/x/AgentReader-0.4.0.dmg",
			},
		],
	});
	assert.equal(releaseInfo(universalName, "mac", "arm64")?.asset?.name, "AgentReader-0.4.0.dmg");
});

test("Windows prefers the NSIS setup over msi; Linux prefers AppImage", () => {
	const win = release({
		assets: [ghAsset("AgentReader-0.4.0-x64.msi"), ghAsset("AgentReader-Setup-0.4.0.exe")],
	});
	assert.equal(releaseInfo(win, "win", "x64")?.asset?.name, "AgentReader-Setup-0.4.0.exe");
	const linux = release({
		assets: [ghAsset("AgentReader-0.4.0-x86_64.deb"), ghAsset("AgentReader-0.4.0-x86_64.AppImage")],
	});
	assert.equal(
		releaseInfo(linux, "linux", "x64")?.asset?.name,
		"AgentReader-0.4.0-x86_64.AppImage",
	);
});

test("scoring prefers an exact arch over a universal build", () => {
	const exact = asset("AgentReader-0.4.0-arm64.dmg");
	const universal = asset("AgentReader-0.4.0-universal.dmg");
	const score = (a: UpdateAsset) => scoreAsset(a, "mac", "arm64") ?? -1;
	assert.ok(score(exact) > score(universal));
	assert.equal(scoreAsset(asset("AgentReader-0.4.0-x64.dmg"), "mac", "arm64"), null);
});

test("draft releases are ignored and prereleases are opt-in", () => {
	const stable = release({ tag_name: "v0.4.0" });
	const beta = release({ tag_name: "v0.5.0-beta.1", prerelease: true });
	const draft = release({ tag_name: "v0.6.0", draft: true });
	assert.equal(
		pickLatestRelease([beta, stable], {
			includePrerelease: false,
			platform: "mac",
			arch: "arm64",
		})?.version,
		"0.4.0",
	);
	assert.equal(
		pickLatestRelease([beta, stable], {
			includePrerelease: true,
			platform: "mac",
			arch: "arm64",
		})?.version,
		"0.5.0-beta.1",
	);
	assert.equal(
		pickLatestRelease([draft, stable], {
			includePrerelease: true,
			platform: "mac",
			arch: "arm64",
		})?.version,
		"0.4.0",
	);
});

test("when the newest release lacks this platform, fall back to the newest installable one", () => {
	const newerWithoutMac = release({
		tag_name: "v0.5.0",
		assets: [
			{
				name: "AgentReader-Setup-0.5.0.exe",
				size: 1000,
				browser_download_url: "https://github.com/x/AgentReader-Setup-0.5.0.exe",
			},
		],
	});
	const older = release({ tag_name: "v0.4.0" });
	assert.equal(
		pickLatestRelease([newerWithoutMac, older], {
			includePrerelease: false,
			platform: "mac",
			arch: "arm64",
		})?.version,
		"0.4.0",
	);
});

test("sha256 digests and checksum files are parsed strictly", () => {
	assert.equal(parseSha256(`sha256:${SHA}`), SHA);
	assert.equal(parseSha256(SHA.toUpperCase()), SHA);
	assert.equal(parseSha256("md5:abc"), null);
	assert.equal(parseSha256(undefined), null);
	assert.equal(
		parseChecksumFile(
			`${SHA}  AgentReader-0.4.0-arm64.dmg\n${"b".repeat(64)} *other.zip\n`,
			"AgentReader-0.4.0-arm64.dmg",
		),
		SHA,
	);
	assert.equal(parseChecksumFile(`${SHA}  other.zip`, "missing.dmg"), null);
	const sidecar = findChecksumAsset([
		{ name: "SHA256SUMS.txt", browser_download_url: "https://github.com/x/SHA256SUMS.txt" },
	]);
	assert.equal(sidecar?.name, "SHA256SUMS.txt");
});
