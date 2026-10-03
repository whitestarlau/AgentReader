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

/**
 * Merge plain string fields into settings.json, preserving unrelated keys
 * (model, webSearch*, OCR, ...). Never pass secrets here; use the auth store.
 */
export function updateSettings(patch: Record<string, string | undefined>): void {
	const p = settingsPath();
	let current: Record<string, unknown> = {};
	if (existsSync(p)) {
		try {
			const parsed = JSON.parse(readFileSync(p, "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
		} catch {}
	}
	const next = { ...current };
	for (const [k, v] of Object.entries(patch)) {
		if (typeof v === "string") next[k] = v;
	}
	writeFileSync(p, JSON.stringify(next, null, 2));
}
