import { app, BrowserWindow, Menu, type MenuItemConstructorOptions, shell } from "electron";
import { APP_NAME } from "./identity.ts";

/**
 * 应用菜单。此前从未设置过，Electron 用的内置默认菜单在中文界面下完全不对：
 * 应用名显示为包名「@agentreader/app」、条目全英文、帮助指向 electronjs.org、
 * 视图里还挂着开发者工具。这里显式构建一套中文菜单，并区分平台：
 * - macOS：应用菜单（关于/设置/服务/隐藏/退出）+ 标准编辑菜单；
 * - Windows/Linux：设置与退出放进「文件」、「关于」放进「帮助」，
 *   不出现 macOS 专有项（services/hideOthers/front 等）。
 *
 * 界面动作（导入/新建对话/设置/侧栏/对话开关）通过 `app:menu` 事件交给渲染层，
 * 渲染层已有对应处理函数；窗口/编辑类动作直接使用 Electron role。
 */

export type MenuCommand = "settings" | "import" | "new-chat" | "toggle-sidebar" | "toggle-chat";

function sendCommand(cmd: MenuCommand) {
	const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
	win?.webContents.send("app:menu", cmd);
}

export function installAppMenu() {
	const isMac = process.platform === "darwin";
	const isDev = !app.isPackaged;

	const appMenu: MenuItemConstructorOptions = {
		label: APP_NAME,
		submenu: [
			{ label: `关于 ${APP_NAME}`, click: () => app.showAboutPanel() },
			{ type: "separator" },
			{ label: "设置…", accelerator: "CmdOrCtrl+,", click: () => sendCommand("settings") },
			{ type: "separator" },
			{ role: "services", label: "服务" },
			{ type: "separator" },
			{ role: "hide", label: `隐藏 ${APP_NAME}` },
			{ role: "hideOthers", label: "隐藏其他" },
			{ role: "unhide", label: "全部显示" },
			{ type: "separator" },
			{ role: "quit", label: `退出 ${APP_NAME}` },
		],
	};

	const fileMenu: MenuItemConstructorOptions = {
		label: "文件",
		submenu: [
			{ label: "导入 PDF / EPUB…", accelerator: "CmdOrCtrl+O", click: () => sendCommand("import") },
			{ label: "新建对话", accelerator: "CmdOrCtrl+N", click: () => sendCommand("new-chat") },
			{ type: "separator" },
			...(isMac
				? ([{ role: "close", label: "关闭窗口" }] as MenuItemConstructorOptions[])
				: ([
						{ label: "设置…", accelerator: "CmdOrCtrl+,", click: () => sendCommand("settings") },
						{ type: "separator" },
						{ role: "quit", label: "退出" },
					] as MenuItemConstructorOptions[])),
		],
	};

	const editMenu: MenuItemConstructorOptions = {
		label: "编辑",
		submenu: [
			{ role: "undo", label: "撤销" },
			{ role: "redo", label: "重做" },
			{ type: "separator" },
			{ role: "cut", label: "剪切" },
			{ role: "copy", label: "复制" },
			{ role: "paste", label: "粘贴" },
			{ role: "selectAll", label: "全选" },
		],
	};

	const viewSubmenu: MenuItemConstructorOptions[] = [
		{
			label: "显示/隐藏侧栏",
			accelerator: "CmdOrCtrl+B",
			click: () => sendCommand("toggle-sidebar"),
		},
		{
			label: "显示/隐藏 AI 对话",
			accelerator: "CmdOrCtrl+J",
			click: () => sendCommand("toggle-chat"),
		},
		{ type: "separator" },
		{ role: "resetZoom", label: "实际大小" },
		{ role: "zoomIn", label: "放大" },
		{ role: "zoomOut", label: "缩小" },
		{ type: "separator" },
		{ role: "togglefullscreen", label: "切换全屏" },
	];
	// 开发者工具只在 dev 暴露，正式包不出现。
	if (isDev) {
		viewSubmenu.push(
			{ type: "separator" },
			{ role: "reload", label: "重新加载" },
			{ role: "forceReload", label: "强制重新加载" },
			{ role: "toggleDevTools", label: "开发者工具" },
		);
	}
	const viewMenu: MenuItemConstructorOptions = { label: "视图", submenu: viewSubmenu };

	const windowMenu: MenuItemConstructorOptions = {
		label: "窗口",
		submenu: isMac
			? [
					{ role: "minimize", label: "最小化" },
					{ role: "zoom", label: "缩放" },
					{ type: "separator" },
					{ role: "front", label: "前置全部窗口" },
				]
			: [
					{ role: "minimize", label: "最小化" },
					{ role: "close", label: "关闭窗口" },
				],
	};

	const helpMenu: MenuItemConstructorOptions = {
		role: "help",
		label: "帮助",
		submenu: [
			...(isMac
				? []
				: ([
						{ label: `关于 ${APP_NAME}`, click: () => app.showAboutPanel() },
					] as MenuItemConstructorOptions[])),
			{ label: "打开数据目录", click: () => void shell.openPath(app.getPath("userData")) },
		],
	};

	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			...(isMac ? [appMenu] : []),
			fileMenu,
			editMenu,
			viewMenu,
			windowMenu,
			helpMenu,
		]),
	);
}
