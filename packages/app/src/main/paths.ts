import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/**
 * Root of the on-disk library: `{userData}/library/{docId}/`.
 * 惰性求值：userData 由 app.name 决定，而 app 名称在 main 入口最顶部才完成设置
 * （见 identity.ts），模块加载期取值会拿到旧路径。
 */
export function libraryRoot() {
	return join(app.getPath("userData"), "library");
}

export function getDocDir(docId: string) {
	return join(libraryRoot(), docId);
}

export function ensureLibrary() {
	mkdirSync(libraryRoot(), { recursive: true });
}
