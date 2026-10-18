import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

/**
 * 应用身份：名称 / 图标 / 关于面板 / userData 目录。
 *
 * 此前从未设置 app.name，Electron 取 package.json 的包名 "@agentreader/app"：
 * macOS 菜单显示「Electron → About @agentreader/app」，userData 落在
 * `{appData}/@agentreader/app`。这里统一为 AgentReader，并把旧目录整体迁移
 * （同盘 rename 瞬时完成；失败则继续沿用旧目录，已有书库/设置/密钥不丢）。
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

export const APP_NAME = "AgentReader";

/** AppUserModelID：Windows 任务栏分组/通知使用，与 electron-builder 的 appId 一致。 */
export const APP_ID = "com.agentreader.app";

/**
 * 应用图标。`dist-electron/main.js` 与源码 `src/main/` 同级的 `../build` 下，
 * dev 与打包（electron-builder files 已包含 build/icon.png）路径一致。
 * macOS 窗口图标由 .app 包决定，这里用于 Windows/Linux 窗口与关于面板。
 */
export const ICON_PATH = join(__dirname, "../build/icon.png");

/** 旧包名目录名（app.name 未设置时 userData 的默认目录）。 */
const LEGACY_DIR = "@agentreader/app";

/** 必须在任何代码读取 userData 之前调用（main 入口模块顶部）。 */
export function setupAppIdentity() {
	app.setName(APP_NAME);
	if (process.platform === "win32") app.setAppUserModelId(APP_ID);
	const legacy = join(app.getPath("appData"), LEGACY_DIR);
	const current = join(app.getPath("appData"), APP_NAME);
	if (existsSync(legacy) && !existsSync(current)) {
		try {
			renameSync(legacy, current);
		} catch {
			// 旧目录被占用（例如旧版本仍在运行）时退回旧路径，功能不受影响。
			app.setPath("userData", legacy);
		}
	}
}

/** Dev：显式设置 Dock 图标（打包后由 .app 包提供）。 */
export function applyAppIcon() {
	if (process.platform === "darwin" && !app.isPackaged && existsSync(ICON_PATH)) {
		app.dock?.setIcon(ICON_PATH);
	}
}

/** 「关于 AgentReader」面板内容（macOS 应用菜单 / Windows 帮助菜单）。 */
export function setupAboutPanel() {
	app.setAboutPanelOptions({
		applicationName: APP_NAME,
		applicationVersion: app.getVersion(),
		version: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
		copyright: "© 2026 whitestar.lau · AI 文档阅读器（PDF / EPUB）",
		iconPath: ICON_PATH,
	});
}
