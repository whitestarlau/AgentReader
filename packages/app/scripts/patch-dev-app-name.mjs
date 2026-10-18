/**
 * macOS dev 体验补丁：把 node_modules 里 Electron.app 的名称改成 AgentReader。
 *
 * 背景：macOS 菜单栏/程序坞/Dock 显示的应用名取自 .app 包的 CFBundleName，
 * app.setName() 与菜单模板的首项 label 都会被系统忽略 —— 因此 dev 模式一直显示
 * "Electron"，而打包版由 electron-builder 写入 productName（AgentReader），无需处理。
 *
 * 改 Info.plist 会破坏 Electron 的代码签名（Apple Silicon 上会直接无法启动），
 * 所以改完用 ad-hoc 重新签名。脚本幂等（已打过补丁则跳过），挂在 postinstall 与
 * predev 上：重装/升级 electron 后会自动重新打上。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const APP_NAME = "AgentReader";

function patchDevAppName() {
	if (process.platform !== "darwin") return;
	const require = createRequire(import.meta.url);
	const bin = require("electron"); // .../electron/dist/Electron.app/Contents/MacOS/Electron
	const appBundle = dirname(dirname(dirname(bin)));
	const plistPath = join(appBundle, "Contents", "Info.plist");
	if (!existsSync(plistPath)) return;

	const plist = readFileSync(plistPath, "utf8");
	const patched = plist
		.replace(/(<key>CFBundleName<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${APP_NAME}$2`)
		.replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${APP_NAME}$2`);
	if (patched === plist) return;

	writeFileSync(plistPath, patched);
	execFileSync("codesign", ["--force", "--sign", "-", appBundle], { stdio: "ignore" });
	console.log(`[patch-dev-app-name] dev Electron.app 已更名为 ${APP_NAME} 并重新签名`);
}

try {
	patchDevAppName();
} catch (e) {
	// 打不上补丁不影响开发（菜单栏只是仍显示 Electron），静默跳过。
	console.warn(`[patch-dev-app-name] skipped: ${e instanceof Error ? e.message : e}`);
}
