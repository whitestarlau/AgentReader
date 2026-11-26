import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { markSettingsDirty } from "./sync/dirty.ts";

export type AppSettings = Record<string, string> & {
	baseUrl?: string;
	model?: string;
	apiKey?: string;
	ocrLang?: string;
};

export function settingsPath(): string {
	return join(app.getPath("userData"), "settings.json");
}

/**
 * settings.json 的原始内容，**不做任何加工**：不注入默认值、不解密密钥。
 *
 * 同步层要用它，因为「文件里到底有什么」和「应用当前生效什么」是两件事：
 * 把 `ocrLang` 的内置默认值也写进同步体，会让每个新用户都把默认值推到云端。
 */
export function readRawSettings(): Record<string, string> {
	const p = settingsPath();
	if (!existsSync(p)) return {};
	try {
		const parsed = JSON.parse(readFileSync(p, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof v === "string") out[k] = v;
		}
		return out;
	} catch {
		return {};
	}
}

/** 覆盖写回 settings.json。同步层用它落盘合并结果（已保证保留本机专属 key）。 */
export function writeRawSettings(values: Record<string, string>): void {
	writeFileSync(settingsPath(), JSON.stringify(values, null, 2));
}

/** Read settings.json, decrypting the legacy API key when encryption is available. */
export function readSettings(): AppSettings {
	const settings: AppSettings = { ocrLang: "chi_sim+eng", ...readRawSettings() };
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
 *
 * 写完标脏：这是三个设置层写盘点里最关键的一个（其余两个在 ai-config.ts），
 * 漏掉它 = 用户在设置页改的任何东西都不会同步。
 */
export function updateSettings(patch: Record<string, string | undefined>): void {
	const next: Record<string, string> = readRawSettings();
	for (const [k, v] of Object.entries(patch)) {
		if (typeof v === "string") next[k] = v;
	}
	writeRawSettings(next);
	markSettingsDirty();
}
