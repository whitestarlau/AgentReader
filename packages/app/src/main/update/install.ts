/**
 * 覆盖安装：把下载好的安装包变成「当前应用已被替换」。
 *
 * 三个平台各有各的现实约束，这里是刻意做得不「优雅」但可靠的做法：
 *
 * - macOS：dmg → hdiutil 挂载 → ditto 复制到暂存目录 → 等旧进程退出 → rm + ditto 原位覆盖
 *   → 去 quarantine → open。必须等进程退出，因为正在运行的 .app 不能被覆盖。
 *   如果 /Applications 不可写（管理员安装）或应用本身在只读镜像里，退回「打开 dmg 让用户拖」。
 * - Windows：NSIS `/S --force-run` 静默安装，安装器自己负责重启应用。
 * - Linux：只对 AppImage 做同名原子替换（rename 不会遇到 ETXTBSY），deb/rpm 交给系统包管理器。
 *
 * 所有路径都做单引号转义后再拼进 shell 脚本 —— 安装包文件名来自网络，不能假设它干净。
 */

import { execFile, spawn } from "node:child_process";
import {
	accessSync,
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { messageOf, UpdateError } from "./errors.ts";

export type InstallPlan =
	/** 把 command 拉起来后就可以退出应用；必要时由外部程序负责重启。 */
	| { mode: "spawn"; command: string; args: string[]; relaunch: boolean; note?: string }
	/** 文件已就位，直接重启应用即可。 */
	| { mode: "restart"; relaunch: true; note?: string }
	/** 没法自动安装：打开文件让用户手动处理。 */
	| { mode: "manual"; path: string; reason: string };

export type InstallOptions = {
	platform: NodeJS.Platform;
	installerPath: string;
	/** `app.getPath("exe")` */
	execPath: string;
	/** 当前进程 pid，macOS 替换脚本用它等待旧进程退出。 */
	pid: number;
	/** 暂存目录（userData/updates/install）。 */
	workDir: string;
	logPath: string;
	env?: NodeJS.ProcessEnv;
};

/** 单引号包裹，供 /bin/sh、/bin/bash 使用。 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 从 `.../AgentReader.app/Contents/MacOS/AgentReader` 取回 `.app` 路径。 */
export function appBundleFromExecPath(execPath: string): string | null {
	const marker = ".app/Contents/MacOS/";
	const index = execPath.indexOf(marker);
	if (index < 0) return null;
	return execPath.slice(0, index + ".app".length);
}

export function isWritablePath(target: string): boolean {
	try {
		// 替换一个目录需要父目录可写（rename/删除条目），同时需要目标自身可写
		// （root 安装的 .app 以 755 存在时，普通用户删不掉里面的文件）。
		accessSync(dirname(target), constants.W_OK);
		if (existsSync(target)) accessSync(target, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * 生成 macOS 替换脚本。
 *
 * 为什么不直接在 Node 里替换：`rm -rf` 正在运行的 bundle 会把当前进程的代码页抽掉，
 * 应用会在完成替换前崩掉，且没有机会重启自己。脚本以 detached 方式脱离应用运行，
 * 先等 pid 消失，再动手。
 */
export function macReplaceScript(opts: {
	pid: number;
	target: string;
	staged: string;
	cleanupDir: string;
	logPath: string;
}): string {
	const q = shellQuote;
	return [
		"#!/bin/bash",
		"# AgentReader 更新助手：等待旧进程退出 → 原位替换 .app → 去隔离标记 → 重启。",
		"set -u",
		`exec >> ${q(opts.logPath)} 2>&1`,
		`echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始更新：pid ${opts.pid}"`,
		`PID=${opts.pid}`,
		`for _ in $(seq 1 240); do`,
		'  kill -0 "$PID" 2>/dev/null || break',
		"  sleep 0.25",
		"done",
		"sleep 0.5",
		'if kill -0 "$PID" 2>/dev/null; then',
		'  echo "旧进程未退出，放弃替换（可手动覆盖安装）"',
		"  exit 1",
		"fi",
		`rm -rf ${q(opts.target)} || { echo "删除旧版本失败"; exit 1; }`,
		`/usr/bin/ditto ${q(opts.staged)} ${q(opts.target)} || { echo "复制新版本失败"; exit 1; }`,
		`/usr/bin/xattr -dr com.apple.quarantine ${q(opts.target)} 2>/dev/null`,
		`rm -rf ${q(opts.cleanupDir)}`,
		`/usr/bin/open ${q(opts.target)}`,
		`echo "更新完成"`,
		"",
	].join("\n");
}

export function windowsInstallerPlan(installerPath: string): InstallPlan {
	const ext = extname(installerPath).toLowerCase();
	if (ext === ".exe") {
		// electron-builder 的 NSIS 安装器：/S 静默，--force-run 让它在安装完成后启动应用。
		return { mode: "spawn", command: installerPath, args: ["/S", "--force-run"], relaunch: false };
	}
	if (ext === ".msi") {
		return {
			mode: "spawn",
			command: "msiexec.exe",
			args: ["/i", installerPath, "/qn", "/norestart"],
			relaunch: false,
			note: "MSI 安装完成后请手动打开应用",
		};
	}
	return { mode: "manual", path: installerPath, reason: "不是可静默安装的 Windows 安装包" };
}

/** AppImage 的真实路径：优先 env.APPIMAGE，其次 exe 本身以 .AppImage 结尾。 */
export function linuxAppImageTarget(execPath: string, env: NodeJS.ProcessEnv): string | null {
	const fromEnv = env.APPIMAGE;
	if (fromEnv?.toLowerCase().endsWith(".appimage")) return fromEnv;
	if (execPath.toLowerCase().endsWith(".appimage")) return execPath;
	return null;
}

function run(command: string, args: string[], timeoutMs = 120_000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
			if (error) {
				const detail = `${stderr || ""}${messageOf(error)}`.trim().slice(0, 600);
				reject(new UpdateError("install", `${basename(command)} 执行失败：${detail}`));
				return;
			}
			resolve(stdout);
		});
	});
}

async function detachVolume(mountPoint: string): Promise<void> {
	try {
		await run("/usr/bin/hdiutil", ["detach", mountPoint, "-quiet"], 60_000);
	} catch {
		// 有残留句柄（Finder/Spotlight）时强制卸载；失败也不该让整个更新失败。
		await run("/usr/bin/hdiutil", ["detach", mountPoint, "-force", "-quiet"], 60_000).catch(
			() => "",
		);
	}
}

async function prepareMacInstall(opts: InstallOptions): Promise<InstallPlan> {
	if (extname(opts.installerPath).toLowerCase() === ".zip") {
		return {
			mode: "manual",
			path: opts.installerPath,
			reason:
				"下载的是 zip 包，已用系统默认方式打开；解压后把 AgentReader.app 拖到「应用程序」即可",
		};
	}
	const target = appBundleFromExecPath(opts.execPath);
	if (!target) {
		return {
			mode: "manual",
			path: opts.installerPath,
			reason: "无法定位当前 .app，已打开安装镜像，请手动安装",
		};
	}
	if (target.startsWith("/Volumes/")) {
		return {
			mode: "manual",
			path: opts.installerPath,
			reason: "当前应用是从磁盘镜像里直接运行的，已打开新版镜像，请把 AgentReader 拖到「应用程序」",
		};
	}
	if (!isWritablePath(target)) {
		return {
			mode: "manual",
			path: opts.installerPath,
			reason: `没有写入「${dirname(target)}」的权限，已打开安装镜像，请手动拖拽覆盖`,
		};
	}

	const mountPoint = join(opts.workDir, "mount");
	const stageDir = join(opts.workDir, "staged");
	// 上次异常退出可能留下挂载点；先卸载再清理，否则 rmSync 会因设备忙失败。
	if (existsSync(mountPoint)) await detachVolume(mountPoint).catch(() => {});
	rmSync(opts.workDir, { recursive: true, force: true });
	mkdirSync(mountPoint, { recursive: true });
	mkdirSync(stageDir, { recursive: true });
	mkdirSync(dirname(opts.logPath), { recursive: true });

	await run("/usr/bin/hdiutil", [
		"attach",
		"-nobrowse",
		"-readonly",
		"-noautoopen",
		"-mountpoint",
		mountPoint,
		opts.installerPath,
	]);
	let stagedApp = "";
	let stagingError: unknown = null;
	try {
		const appName = readdirSync(mountPoint).find((name) => name.endsWith(".app"));
		if (!appName) {
			throw new UpdateError("install", "安装镜像里没有找到 .app", {
				hint: "安装包可能损坏，请重新下载",
			});
		}
		stagedApp = join(stageDir, appName);
		await run("/usr/bin/ditto", [join(mountPoint, appName), stagedApp], 600_000);
	} catch (error) {
		stagingError = error;
	} finally {
		await detachVolume(mountPoint);
	}
	if (stagingError) {
		rmSync(opts.workDir, { recursive: true, force: true });
		throw stagingError;
	}

	const scriptPath = join(opts.workDir, "replace.sh");
	writeFileSync(
		scriptPath,
		macReplaceScript({
			pid: opts.pid,
			target,
			staged: stagedApp,
			cleanupDir: opts.workDir,
			logPath: opts.logPath,
		}),
		{ mode: 0o755 },
	);
	return { mode: "spawn", command: "/bin/bash", args: [scriptPath], relaunch: false };
}

function prepareLinuxInstall(opts: InstallOptions): InstallPlan {
	const ext = extname(opts.installerPath).toLowerCase();
	if (ext === ".appimage") {
		const target = linuxAppImageTarget(opts.execPath, opts.env ?? process.env);
		if (!target) {
			return {
				mode: "manual",
				path: opts.installerPath,
				reason: "没有找到当前 AppImage 路径，请手动替换",
			};
		}
		try {
			const next = `${target}.new`;
			copyFileSync(opts.installerPath, next);
			chmodSync(next, 0o755);
			// rename 是原子的；正在运行的 AppImage 文件可以这样被替换。
			renameSync(next, target);
			return { mode: "restart", relaunch: true };
		} catch (error) {
			return {
				mode: "manual",
				path: opts.installerPath,
				reason: `无法替换 AppImage：${messageOf(error)}`,
			};
		}
	}
	return {
		mode: "manual",
		path: opts.installerPath,
		reason: "下载的是系统安装包，请用软件中心或包管理器安装",
	};
}

export async function prepareInstall(opts: InstallOptions): Promise<InstallPlan> {
	if (opts.platform === "darwin") return prepareMacInstall(opts);
	if (opts.platform === "win32") return windowsInstallerPlan(opts.installerPath);
	return prepareLinuxInstall(opts);
}

/** 拉起外部安装程序；调用方随后退出应用。 */
export function launchInstall(plan: InstallPlan): void {
	if (plan.mode !== "spawn") return;
	const child = spawn(plan.command, plan.args, { detached: true, stdio: "ignore" });
	child.unref();
}
