import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, type BrowserWindowConstructorOptions } from "electron";
import { registerAiIpc } from "./ai.ts";
import { setProviderKey } from "./ai-auth.ts";
import { ensureConfig } from "./ai-config.ts";
import { registerChatIpc } from "./chat.ts";
import { registerConversationIpc } from "./conversations.ts";
import { registerDocStateIpc } from "./doc-state.ts";
import { registerDocTextIpc } from "./doc-text.ts";
import { applyAppIcon, ICON_PATH, setupAboutPanel, setupAppIdentity } from "./identity.ts";
import { registerLibraryIpc } from "./library.ts";
import { installAppMenu } from "./menu.ts";
import { registerPermissionIpc } from "./permissions.ts";
import { readSettings } from "./settings.ts";
import { registerSkillsIpc } from "./skills-ipc.ts";

/**
 * Main-process entry point: app lifecycle, the window, and wiring up every IPC
 * module. Business logic lives in the sibling modules.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

// 统一应用名并迁移 userData（决定 macOS 菜单名 / userData 路径），必须最先执行。
setupAppIdentity();

registerLibraryIpc();
registerDocTextIpc();
registerDocStateIpc();
registerConversationIpc();
registerAiIpc();
registerSkillsIpc();
registerPermissionIpc();
registerChatIpc();

/**
 * 沉浸式标题栏：内容延伸到标题栏区域，同时保留系统原生窗口按钮。
 * - macOS：hidden 保留左上角红黄绿按钮，并用 trafficLightPosition 对齐标题栏。
 * - Windows/Linux：hidden + titleBarOverlay 由系统在右上角绘制最小化/最大化/关闭，
 *   窗口控件颜色与渲染层标题栏保持一致（--vscode-titlebar: #3c3c3c）。
 */
function immersiveTitleBar(): Pick<
	BrowserWindowConstructorOptions,
	"titleBarStyle" | "titleBarOverlay" | "trafficLightPosition"
> {
	if (process.platform === "darwin") {
		return {
			titleBarStyle: "hidden",
			// 与渲染层 35px 标题栏垂直居中（按钮命中区 16px）。
			trafficLightPosition: { x: 14, y: 10 },
		};
	}
	return {
		titleBarStyle: "hidden",
		titleBarOverlay: { color: "#3c3c3c", symbolColor: "#cccccc", height: 35 },
	};
}

function createWindow() {
	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		title: "AgentReader",
		icon: ICON_PATH,
		...immersiveTitleBar(),
		webPreferences: {
			preload: join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	// Dev: talk to the Vite server. Packaged: load the bundled renderer over file://.
	// main.js lives in dist-electron/, the renderer bundle in dist/.
	if (app.isPackaged) {
		win
			.loadFile(join(__dirname, "../dist/index.html"))
			.catch((e) => console.error("load failed", e));
	} else {
		win.loadURL("http://localhost:5173").catch(() => {
			setTimeout(() => win.loadURL("http://localhost:5173").catch(() => {}), 1000);
		});
	}
	win.webContents.on("did-fail-load", (_e, code, desc, url) => {
		console.error("load failed", code, desc, url);
	});
}

// 单实例锁（仅打包版）：Windows 下重复双击快捷方式不应开出第二个进程——两个实例
// 会同时读写同一份书库/设置。dev 下 vite 重启存在新旧进程交接窗口，不加锁以免误退。
if (app.isPackaged && !app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => {
		const win = BrowserWindow.getAllWindows()[0];
		if (!win) return;
		if (win.isMinimized()) win.restore();
		win.focus();
	});

	app.whenReady().then(() => {
		applyAppIcon();
		setupAboutPanel();
		installAppMenu();
		// Seed models.json on first run, migrating the legacy single-provider settings
		// (and moving its encrypted key into the auth store) when present.
		const legacy = readSettings();
		const created = ensureConfig({ baseUrl: legacy.baseUrl, model: legacy.model });
		if (created && legacy.apiKey) setProviderKey("legacy", legacy.apiKey);
		createWindow();
	});

	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});

	// macOS：关闭窗口后点击 Dock 图标应重新打开窗口，否则应用看起来「卡死」。
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
}
