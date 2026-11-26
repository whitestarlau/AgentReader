import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConfigStore, normalizeConfig, type SecretCodec } from "./config.ts";

function tempDir(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), "ar-sync-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** 假的系统钥匙串：真实实现由主进程注入 safeStorage。 */
const fakeCodec = (available = true): SecretCodec => ({
	available,
	encrypt: (plain) => `enc:${Buffer.from(plain, "utf-8").toString("base64")}`,
	decrypt: (cipher) => {
		if (!cipher.startsWith("enc:")) throw new Error("不是本编码器产出的密文");
		return Buffer.from(cipher.slice(4), "base64").toString("utf-8");
	},
});

test("defaults are safe: disabled, settings+notes in scope, books out", () => {
	const config = normalizeConfig({});
	assert.equal(config.enabled, false);
	assert.equal(config.backend, null);
	assert.deepEqual(config.scope, { settings: true, notes: true, books: false });
	assert.ok(config.deviceId.length > 0);
});

test("a backend without an endpoint keeps sync disabled", () => {
	const config = normalizeConfig({
		enabled: true,
		backend: { id: "webdav", endpoint: "", account: "a", rootName: "AgentReader" },
	});
	assert.equal(config.backend, null);
	assert.equal(config.enabled, false);
});

test("a configured backend enables sync and keeps the root name", () => {
	const config = normalizeConfig({
		enabled: true,
		backend: { id: "webdav", endpoint: "https://dav.jianguoyun.com/dav/", account: "a" },
	});
	assert.equal(config.enabled, true);
	assert.equal(config.backend?.rootName, "AgentReader");
	assert.equal(config.backend?.endpoint, "https://dav.jianguoyun.com/dav/");
});

test("reading a missing config writes defaults with a stable deviceId", (t) => {
	const dir = tempDir(t);
	const store = createConfigStore({ dir, codec: fakeCodec() });
	const first = store.read();
	assert.ok(existsSync(store.configFile));
	const second = store.read();
	assert.equal(second.deviceId, first.deviceId, "deviceId 必须稳定，否则兜底裁决会错");
});

test("patch persists and is normalized on read", (t) => {
	const dir = tempDir(t);
	const store = createConfigStore({ dir, codec: fakeCodec() });
	store.patch({
		backend: {
			id: "webdav",
			endpoint: "https://app.koofr.net/dav/Koofr/",
			account: "me@example.com",
			rootName: "AgentReader",
		},
		scope: { settings: true, notes: true, books: true },
	});
	const config = store.read();
	assert.equal(config.backend?.account, "me@example.com");
	assert.equal(config.scope.books, true);
	assert.equal(config.enabled, false, "patch 不会自动启用：启用由 configure 流程决定");
});

test("a corrupt config file falls back to defaults instead of throwing", (t) => {
	const dir = tempDir(t);
	const store = createConfigStore({ dir, codec: fakeCodec() });
	writeFileSync(store.configFile, "{ this is not json");
	const config = store.read();
	assert.equal(config.version, 1);
	assert.deepEqual(config.scope, { settings: true, notes: true, books: false });
});

test("secrets never hit the disk in plaintext", (t) => {
	const dir = tempDir(t);
	const store = createConfigStore({ dir, codec: fakeCodec() });
	store.writeSecret("app-password-REAL");
	const raw = readFileSync(store.secretsFile, "utf-8");
	assert.equal(raw.includes("app-password-REAL"), false, "secrets.json 里不能出现明文");
	assert.equal(store.secretState(), "encrypted");
	assert.equal(store.readSecret(), "app-password-REAL");
});

test("without a system keychain we degrade to base64 and say so", (t) => {
	const dir = tempDir(t);
	const store = createConfigStore({ dir, codec: fakeCodec(false) });
	store.writeSecret("app-password");
	assert.equal(store.secretState(), "plain");
	assert.equal(store.readSecret(), "app-password");
});

test("a secret that cannot be decrypted is treated as missing, not as a password", (t) => {
	const dir = tempDir(t);
	const store = createConfigStore({ dir, codec: fakeCodec() });
	store.writeSecret("app-password");
	// 换一台机器：钥匙串条目不在，密文解不开
	const otherMachine = createConfigStore({
		dir,
		codec: {
			available: true,
			encrypt: () => "enc:bogus",
			decrypt: () => {
				throw new Error("钥匙串条目不存在");
			},
		},
	});
	assert.equal(otherMachine.readSecret(), null);
});

test("clearing the secret removes the file", (t) => {
	const dir = tempDir(t);
	const store = createConfigStore({ dir, codec: fakeCodec() });
	store.writeSecret("x");
	store.writeSecret(null);
	assert.equal(existsSync(store.secretsFile), false);
	assert.equal(store.secretState(), "none");
});
