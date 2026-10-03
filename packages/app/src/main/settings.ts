import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";

export type AppSettings = Record<string, string> & {
	baseUrl?: string;
	model?: string;
	apiKey?: string;
	ocrLang?: string;
};

export function settingsPath(): string {
	return join(app.getPath("userData"), "settings.json");
}

/** Read settings.json, decrypting the legacy API key when encryption is available. */
export function readSettings(): AppSettings {
	const p = settingsPath();
	const settings: AppSettings = { ocrLang: "chi_sim+eng" };
	if (!existsSync(p)) return settings;
	try {
		Object.assign(settings, JSON.parse(readFileSync(p, "utf-8")));
	} catch {}
	if (settings.apiKey && safeStorage.isEncryptionAvailable()) {
		try {
			settings.apiKey = safeStorage.decryptString(Buffer.from(settings.apiKey, "base64"));
		} catch {}
	}
	return settings;
}

/** Persist settings.json, encrypting the legacy API key when encryption is available. */
export function writeSettings(settings: Record<string, string | undefined>): void {
	const next: Record<string, string> = {};
	for (const [k, v] of Object.entries(settings)) {
		if (typeof v === "string") next[k] = v;
	}
	if (next.apiKey && safeStorage.isEncryptionAvailable()) {
		next.apiKey = safeStorage.encryptString(next.apiKey).toString("base64");
	}
	writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
}
