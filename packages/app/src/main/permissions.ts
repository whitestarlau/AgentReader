import { randomUUID } from "node:crypto";
import { type BrowserWindow, ipcMain } from "electron";

export type PermissionDecision = "once" | "always" | "deny";

const pendingPermissions = new Map<string, (decision: PermissionDecision) => void>();

/** Ask the renderer to confirm a concrete command before executing it. */
export function requestPermission(
	win: BrowserWindow | null,
	payload: { kind: "skill_exec"; skill: string; command: string; cwd: string; timeoutMs: number },
	signal?: AbortSignal,
): Promise<PermissionDecision> {
	if (!win || win.isDestroyed()) return Promise.resolve("deny");
	const id = randomUUID();
	return new Promise((resolve) => {
		let settled = false;
		const done = (decision: PermissionDecision) => {
			if (settled) return;
			settled = true;
			pendingPermissions.delete(id);
			signal?.removeEventListener("abort", onAbort);
			resolve(decision);
		};
		const onAbort = () => done("deny");
		signal?.addEventListener("abort", onAbort, { once: true });
		pendingPermissions.set(id, done);
		win.webContents.send("permission:request", { id, ...payload });
	});
}

export function registerPermissionIpc() {
	ipcMain.handle("permission:reply", (_e, id: string, decision: string) => {
		const resolve = pendingPermissions.get(id);
		if (resolve && (decision === "once" || decision === "always" || decision === "deny")) {
			resolve(decision);
		}
		return true;
	});
}
