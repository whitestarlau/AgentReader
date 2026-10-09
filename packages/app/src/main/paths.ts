import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/** Root of the on-disk library: `{userData}/library/{docId}/`. */
export const LIBRARY_ROOT = join(app.getPath("userData"), "library");

export function getDocDir(docId: string) {
	return join(LIBRARY_ROOT, docId);
}

export function ensureLibrary() {
	mkdirSync(LIBRARY_ROOT, { recursive: true });
}
