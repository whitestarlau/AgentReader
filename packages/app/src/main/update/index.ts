/**
 * 更新功能的主进程装配层：IPC、状态机、自动检查、下载与安装。
 *
 * 一次完整的更新是四步，每一步都能单独失败、单独重试：
 *   检查（GitHub API）→ 下载（流式 + 摘要）→ 覆盖安装（平台脚本）→ 重启
 *
 * 设计约束：
 * - 检查只读 GitHub，不上报任何信息；
 * - 安装包必须来自 Release 资产，且校验 `digest`（或 SHA256SUMS）后才允许安装；
 * - 自动检查每 6 小时一次，避开未认证 API 的 60 次/小时限流；
 * - 状态只在主进程维护，渲染层订阅 `update:state`，不复制判断逻辑。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import type {
	UpdateDownloadOptions,
	UpdatePlatform,
	UpdatePrefsPatch,
	UpdateProgress,
	UpdateState,
} from "../../shared/update.ts";
import { readRawSettings, updateSettings } from "../settings.ts";
import { downloadFile, isCompleteFile } from "./download.ts";
import { toUpdateError, UpdateError } from "./errors.ts";
import {
	fetchReleaseList,
	fetchText,
	parseRepo,
	type RepoRef,
	releasePageUrl,
	repoSlug,
} from "./github.ts";
import { launchInstall, prepareInstall } from "./install.ts";
import {
	findChecksumAsset,
	type GithubReleaseJson,
	parseChecksumFile,
	pickLatestRelease,
} from "./release.ts";
import { isNewer } from "./version.ts";

const DEFAULT_REPO = "whitestarlau/AgentReader";
/** 两次自动检查的最小间隔。未认证 GitHub API 每小时 60 次，6 小时足够稳。 */
const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 10_000;

type LocalState = {
	lastCheckAt: number;
	skippedVersion: string | null;
};

let state: UpdateState | null = null;
let controller: AbortController | null = null;
let timer: NodeJS.Timeout | null = null;
let installAfterDownload = false;

function platformOf(): UpdatePlatform {
	if (process.platform === "darwin") return "mac";
	if (process.platform === "win32") return "win";
	return "linux";
}

function updatesRoot(): string {
	return join(app.getPath("userData"), "updates");
}

function localStatePath(): string {
	return join(updatesRoot(), "state.json");
}

function logPath(): string {
	return join(app.getPath("logs"), "update.log");
}

function downloadDir(): string {
	const downloads = app.getPath("downloads");
	return existsSync(downloads) ? downloads : join(updatesRoot(), "downloads");
}

function loadLocal(): LocalState {
	try {
		const parsed = JSON.parse(readFileSync(localStatePath(), "utf-8")) as Partial<LocalState>;
		return {
			lastCheckAt: typeof parsed.lastCheckAt === "number" ? parsed.lastCheckAt : 0,
			skippedVersion: typeof parsed.skippedVersion === "string" ? parsed.skippedVersion : null,
		};
	} catch {
		return { lastCheckAt: 0, skippedVersion: null };
	}
}

function saveLocal(patch: Partial<LocalState>): void {
	const next = { ...loadLocal(), ...patch };
	try {
		mkdirSync(updatesRoot(), { recursive: true });
		writeFileSync(localStatePath(), JSON.stringify(next, null, 2));
	} catch {
		// 本机状态写不进去不影响更新本身：下次启动只是会重新检查。
	}
}

function readPrefs(): { autoCheck: boolean; includePrerelease: boolean; autoDownload: boolean } {
	const raw = readRawSettings();
	return {
		autoCheck: raw.updateAutoCheck !== "0",
		includePrerelease: raw.updateIncludePrerelease === "1",
		autoDownload: raw.updateAutoDownload === "1",
	};
}

function resolveRepo(): RepoRef {
	const raw = readRawSettings();
	const candidate = raw.updateRepo || process.env.AGENTREADER_UPDATE_REPO || DEFAULT_REPO;
	return parseRepo(candidate) ?? { owner: "whitestarlau", repo: "AgentReader" };
}

function initialState(): UpdateState {
	const repo = resolveRepo();
	const local = loadLocal();
	const prefs = readPrefs();
	return {
		phase: "idle",
		currentVersion: app.getVersion(),
		platform: platformOf(),
		arch: process.arch,
		repo: repoSlug(repo),
		releasePage: releasePageUrl(repo),
		info: null,
		progress: null,
		downloadPath: null,
		skipped: false,
		error: null,
		autoCheck: prefs.autoCheck,
		autoDownload: prefs.autoDownload,
		includePrerelease: prefs.includePrerelease,
		checkedAt: local.lastCheckAt > 0 ? local.lastCheckAt : null,
	};
}

function current(): UpdateState {
	if (!state) state = initialState();
	return state;
}

function broadcast(): void {
	const snapshot = current();
	for (const win of BrowserWindow.getAllWindows()) {
		if (win.isDestroyed()) continue;
		try {
			win.webContents.send("update:state", snapshot);
		} catch {
			// 窗口正在销毁时 send 会抛；忽略即可。
		}
	}
}

function patchState(patch: Partial<UpdateState>): void {
	state = { ...current(), ...patch };
	broadcast();
}

function progressSnapshot(
	received: number,
	total: number,
	percent: number,
	speed = 0,
): UpdateProgress {
	return { received, total, percent, bytesPerSecond: speed };
}

/** 老 Release 的资产可能没有 digest：尝试读同版本的 SHA256SUMS 补齐校验值。 */
async function attachChecksum(
	releases: GithubReleaseJson[],
	info: NonNullable<UpdateState["info"]>,
	signal: AbortSignal,
): Promise<void> {
	if (!info.asset || info.asset.sha256) return;
	const release = releases.find((item) => item.tag_name === info.tag);
	const sidecar = findChecksumAsset(release?.assets ?? []);
	if (!sidecar?.browser_download_url) return;
	try {
		const text = await fetchText(sidecar.browser_download_url, {
			appVersion: app.getVersion(),
			token: process.env.AGENTREADER_UPDATE_TOKEN,
			signal,
			timeoutMs: 10_000,
		});
		const hash = parseChecksumFile(text, info.asset.name);
		if (hash) {
			info.asset.sha256 = hash;
			info.checksum = "sha256";
		}
	} catch {
		// 校验和文件拉不到不影响主流程：下载时退化为「只校验字节数」并提示用户。
	}
}

async function check(opts: { manual: boolean }): Promise<void> {
	if (controller || current().phase === "installing") return;
	const prefs = readPrefs();
	const repo = resolveRepo();
	const abort = new AbortController();
	controller = abort;
	patchState({ phase: "checking", error: null, progress: null });
	try {
		const releases = await fetchReleaseList({
			repo,
			appVersion: app.getVersion(),
			token: process.env.AGENTREADER_UPDATE_TOKEN,
			signal: abort.signal,
			apiBase: process.env.AGENTREADER_UPDATE_API,
		});
		if (releases.length === 0) {
			throw new UpdateError("no-release", "仓库还没有发布任何 Release", {
				hint: "确认仓库地址；自动更新依赖 GitHub Releases",
			});
		}
		const info = pickLatestRelease(releases, {
			includePrerelease: prefs.includePrerelease,
			platform: current().platform,
			arch: current().arch,
		});
		const checkedAt = Date.now();
		saveLocal({ lastCheckAt: checkedAt });

		if (!info) {
			patchState({ phase: "up-to-date", info: null, checkedAt, skipped: false, error: null });
			return;
		}
		if (!isNewer(info.version, current().currentVersion)) {
			patchState({ phase: "up-to-date", info, checkedAt, skipped: false, error: null });
			return;
		}
		await attachChecksum(releases, info, abort.signal);
		const skipped = info.version === loadLocal().skippedVersion;
		patchState({ phase: "available", info, checkedAt, skipped, error: null });
		// 放到微/宏任务里：当前 controller 还没释放，直接调用会被 download() 的并发保护挡掉。
		if (!opts.manual && prefs.autoDownload && !skipped) {
			setTimeout(() => void download({}), 0);
		}
	} catch (error) {
		const mapped = toUpdateError(error);
		if (mapped.code === "cancelled") {
			patchState({ phase: "idle", error: null });
			return;
		}
		// 失败也算一次「尝试」：否则离线时调度器会每 10 秒重试一次。
		const attemptedAt = Date.now();
		saveLocal({ lastCheckAt: attemptedAt });
		patchState({
			phase: "error",
			checkedAt: attemptedAt,
			error: { code: mapped.code, message: mapped.message, hint: mapped.hint },
		});
	} finally {
		if (controller === abort) controller = null;
	}
}

async function download(opts: UpdateDownloadOptions = {}): Promise<void> {
	const snapshot = current();
	const info = snapshot.info;
	if (snapshot.phase === "installing" || controller) return;
	if (!info) {
		patchState({
			phase: "error",
			error: { code: "no-release", message: "还没有检查到可用版本", hint: "先点「检查更新」" },
		});
		return;
	}
	if (!info.asset) {
		patchState({
			phase: "error",
			error: {
				code: "no-asset",
				message: `v${info.version} 没有适配当前平台（${snapshot.platform}/${snapshot.arch}）的安装包`,
				hint: "去发布页确认是否提供了对应产物",
			},
		});
		return;
	}

	const asset = info.asset;
	// 资产名来自网络：只取 basename，杜绝 `../` 之类的路径穿越。
	const dest = join(downloadDir(), basename(asset.name));
	const abort = new AbortController();
	controller = abort;
	installAfterDownload = opts.install === true;
	try {
		if (opts.force) rmSync(dest, { force: true });
		if (!opts.force && (await isCompleteFile(dest, asset.size, asset.sha256))) {
			patchState({
				phase: "ready",
				downloadPath: dest,
				progress: progressSnapshot(asset.size, asset.size, 100),
				error: null,
			});
		} else {
			patchState({
				phase: "downloading",
				downloadPath: null,
				error: null,
				progress: progressSnapshot(0, asset.size, 0),
			});
			const done = await downloadFile({
				url: asset.url,
				dest,
				expectedBytes: asset.size,
				sha256: asset.sha256,
				signal: abort.signal,
				onProgress: (progress) => patchState({ progress }),
			});
			patchState({
				phase: "ready",
				downloadPath: dest,
				progress: progressSnapshot(done.bytes, done.bytes, 100),
			});
		}
	} catch (error) {
		const mapped = toUpdateError(error);
		if (mapped.code === "cancelled") {
			patchState({ phase: "available", progress: null, error: null });
		} else {
			patchState({
				phase: "error",
				progress: null,
				error: { code: mapped.code, message: mapped.message, hint: mapped.hint },
			});
		}
		return;
	} finally {
		if (controller === abort) controller = null;
	}

	if (installAfterDownload) {
		installAfterDownload = false;
		await install();
	}
}

async function install(): Promise<void> {
	const snapshot = current();
	if (snapshot.phase === "installing") return;
	const info = snapshot.info;
	const installerPath =
		snapshot.downloadPath ?? (info?.asset ? join(downloadDir(), basename(info.asset.name)) : null);
	if (!installerPath || !existsSync(installerPath)) {
		patchState({
			phase: "error",
			error: { code: "install", message: "安装包不存在，可能已被移动或删除", hint: "重新下载" },
		});
		return;
	}
	patchState({ phase: "installing", error: null });
	try {
		const plan = await prepareInstall({
			platform: process.platform,
			installerPath,
			execPath: app.getPath("exe"),
			pid: process.pid,
			workDir: join(updatesRoot(), "install"),
			logPath: logPath(),
			env: process.env,
		});
		if (plan.mode === "manual") {
			await shell.openPath(plan.path);
			patchState({
				phase: "ready",
				error: {
					code: "permission",
					message: plan.reason,
					hint: "按提示完成覆盖后重新打开 AgentReader",
				},
			});
			return;
		}
		launchInstall(plan);
		if (plan.mode === "restart") {
			app.relaunch();
			app.exit(0);
			return;
		}
		// macOS 的替换脚本会自己重启；Windows 安装器用 --force-run 重启。
		setTimeout(() => app.quit(), 300);
	} catch (error) {
		const mapped = toUpdateError(error);
		patchState({
			phase: "error",
			error: { code: mapped.code, message: mapped.message, hint: mapped.hint },
		});
	}
}

function cancel(): void {
	controller?.abort();
}

function toggleSkip(): void {
	const info = current().info;
	if (!info) return;
	const skipped = current().skipped;
	const next = skipped ? null : info.version;
	saveLocal({ skippedVersion: next });
	patchState({ skipped: next !== null });
}

function applyPrefs(patch: UpdatePrefsPatch): void {
	const writes: Record<string, string> = {};
	if (typeof patch.autoCheck === "boolean") writes.updateAutoCheck = patch.autoCheck ? "1" : "0";
	if (typeof patch.includePrerelease === "boolean") {
		writes.updateIncludePrerelease = patch.includePrerelease ? "1" : "0";
	}
	if (typeof patch.autoDownload === "boolean") {
		writes.updateAutoDownload = patch.autoDownload ? "1" : "0";
	}
	if (Object.keys(writes).length > 0) updateSettings(writes);
	const prefs = readPrefs();
	patchState({
		autoCheck: prefs.autoCheck,
		includePrerelease: prefs.includePrerelease,
		autoDownload: prefs.autoDownload,
	});
	if (prefs.autoCheck) startUpdateScheduler();
	else stopUpdateScheduler();
}

function stopUpdateScheduler(): void {
	if (timer) clearTimeout(timer);
	timer = null;
}

/**
 * 启动后延迟检查 + 每 6 小时一次。
 *
 * 开发态默认不检查（版本号通常与最新 Release 相同，检查没有意义），
 * 需要联调时设 `AGENTREADER_UPDATE=1`。
 */
export function startUpdateScheduler(): void {
	if (timer) return;
	const prefs = readPrefs();
	if (!prefs.autoCheck) return;
	if (!app.isPackaged && process.env.AGENTREADER_UPDATE !== "1") return;
	const local = loadLocal();
	const wait = Math.max(FIRST_CHECK_DELAY_MS, AUTO_INTERVAL_MS - (Date.now() - local.lastCheckAt));
	timer = setTimeout(
		() => {
			timer = null;
			void check({ manual: false }).finally(() => startUpdateScheduler());
		},
		Math.min(wait, AUTO_INTERVAL_MS),
	);
	timer.unref?.();
}

/** 菜单/无窗口场景直接触发一次检查（状态仍通过 update:state 推给已打开的窗口）。 */
export function checkForUpdates(): void {
	void check({ manual: true });
}

export function registerUpdateIpc(): void {
	ipcMain.handle("update:state", () => current());
	ipcMain.handle("update:check", async () => {
		await check({ manual: true });
		return current();
	});
	ipcMain.handle("update:download", async (_event, opts?: UpdateDownloadOptions) => {
		await download(opts ?? {});
		return current();
	});
	ipcMain.handle("update:install", async () => {
		await install();
		return current();
	});
	ipcMain.handle("update:cancel", () => {
		cancel();
		return current();
	});
	ipcMain.handle("update:skip", () => {
		toggleSkip();
		return current();
	});
	ipcMain.handle("update:prefs", (_event, patch: UpdatePrefsPatch) => {
		applyPrefs(patch ?? {});
		return current();
	});
	ipcMain.handle("update:open-release", async () => {
		const snapshot = current();
		const url = snapshot.info?.url || snapshot.releasePage;
		if (!/^https:\/\//i.test(url)) return false;
		await shell.openExternal(url);
		return true;
	});
	ipcMain.handle("update:reveal", () => {
		const snapshot = current();
		if (!snapshot.downloadPath || !existsSync(snapshot.downloadPath)) return false;
		shell.showItemInFolder(snapshot.downloadPath);
		return true;
	});
}
