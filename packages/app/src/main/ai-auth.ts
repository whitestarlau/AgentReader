import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";

type StoredCredential = { type: "api_key"; key: string };
type StoredAuthFile = Record<string, StoredCredential>;

export function authPath(): string {
	return join(app.getPath("userData"), "auth.json");
}

function readRawAuth(): StoredAuthFile {
	const p = authPath();
	if (!existsSync(p)) return {};
	try {
		const parsed = JSON.parse(readFileSync(p, "utf-8"));
		if (parsed && typeof parsed === "object") return parsed as StoredAuthFile;
	} catch {}
	return {};
}

function writeRawAuth(data: StoredAuthFile): void {
	writeFileSync(authPath(), JSON.stringify(data, null, 2));
}

function decrypt(stored: string): string {
	if (!safeStorage.isEncryptionAvailable()) return stored;
	try {
		return safeStorage.decryptString(Buffer.from(stored, "base64"));
	} catch {
		return stored;
	}
}

function encrypt(key: string): string {
	if (!safeStorage.isEncryptionAvailable()) return key;
	return safeStorage.encryptString(key).toString("base64");
}

/** Decrypted API key for a provider, or undefined when none is stored. */
export function getProviderKey(providerId: string): string | undefined {
	const entry = readRawAuth()[providerId];
	if (!entry || entry.type !== "api_key" || !entry.key) return undefined;
	return decrypt(entry.key);
}

export function hasStoredKey(providerId: string): boolean {
	const entry = readRawAuth()[providerId];
	return Boolean(entry && entry.type === "api_key" && entry.key);
}

export function setProviderKey(providerId: string, key: string): void {
	const data = readRawAuth();
	if (!key) delete data[providerId];
	else data[providerId] = { type: "api_key", key: encrypt(key) };
	writeRawAuth(data);
}

export function removeProviderKey(providerId: string): void {
	const data = readRawAuth();
	delete data[providerId];
	writeRawAuth(data);
}
