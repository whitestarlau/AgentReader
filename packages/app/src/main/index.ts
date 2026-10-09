import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { setProviderKey } from "./ai-auth.ts";
import { ensureConfig } from "./ai-config.ts";
import { registerAiIpc } from "./ai.ts";
import { registerChatIpc } from "./chat.ts";
import { registerConversationIpc } from "./conversations.ts";
import { registerDocStateIpc } from "./doc-state.ts";
import { registerDocTextIpc } from "./doc-text.ts";
import { registerLibraryIpc } from "./library.ts";
import { registerPermissionIpc } from "./permissions.ts";
import { readSettings } from "./settings.ts";
import { registerSkillsIpc } from "./skills-ipc.ts";

/**
 * Main-process entry point: app lifecycle, the window, and wiring up every IPC
 * module. Business logic lives in the sibling modules.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

// App icon. `dist-electron/main.js` sits next to the source at `src/main/`, and the
// icon lives at `build/icon.png` relative to the package root in both dev and packaged
// layouts. On macOS the window icon is ignored (the .app bundle icon is used), so for
// dev we also set the Dock icon explicitly — otherwise it shows the Electron default.
const ICON_PATH = join(__dirname, "../build/icon.png");

function applyAppIcon() {
	if (process.platform === "darwin") {
		if (!app.isPackaged && existsSync(ICON_PATH)) app.dock?.setIcon(ICON_PATH);
	}
}

registerLibraryIpc();
registerDocTextIpc();
registerDocStateIpc();
registerConversationIpc();
registerAiIpc();
registerSkillsIpc();
registerPermissionIpc();
registerChatIpc();

function createWindow() {
	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		icon: ICON_PATH,
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

app.whenReady().then(() => {
	applyAppIcon();
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
