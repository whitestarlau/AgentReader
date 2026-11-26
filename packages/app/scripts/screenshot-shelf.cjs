/**
 * 截图工具：载入已构建的主进程，等书架渲染完，把窗口截图写到指定路径。
 *
 * 用法（先 `npm run build`，再开 vite 渲染服务）：
 *   npx electron scripts/screenshot-shelf.cjs --user-data-dir=/tmp/ar-shelf-demo/userdata \
 *     --out /tmp/shelf.png --wait 4000
 */
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const { pathToFileURL } = require("node:url");
const { join } = require("node:path");

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : fallback;
};
const out = argOf("--out", "/tmp/shelf.png");
const waitMs = Number(argOf("--wait", "4000"));
const width = Number(argOf("--width", "1280"));
const height = Number(argOf("--height", "820"));

async function main() {
	// 载入应用主进程（注册 IPC、创建窗口）。窗口会去连本地的 vite 渲染服务。
	await import(pathToFileURL(join(__dirname, "..", "dist-electron", "main.js")).href);

	await app.whenReady();
	const win = await waitForWindow();
	win.setSize(width, height);
	win.setContentSize(width, height);
	await new Promise((resolve) => setTimeout(resolve, waitMs));

	const image = await win.webContents.capturePage();
	writeFileSync(out, image.toPNG());
	console.log(`截图已保存：${out}（${width}x${height}）`);
	app.exit(0);
}

async function waitForWindow(timeoutMs = 20000) {
	const started = Date.now();
	for (;;) {
		const [win] = BrowserWindow.getAllWindows();
		if (win) {
			if (win.webContents.isLoading()) {
				await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
			}
			return win;
		}
		if (Date.now() - started > timeoutMs) throw new Error("等不到窗口");
		await new Promise((resolve) => setTimeout(resolve, 120));
	}
}

main().catch((error) => {
	console.error(error);
	app.exit(1);
});
