import assert from "node:assert/strict";
import test from "node:test";
import {
	applyMergedSettings,
	classifySetting,
	emptySettingsState,
	hasSecretWord,
	overlaySyncedValues,
	sanitizeSettingsState,
} from "./sanitize.ts";
import type { SettingsState } from "./types.ts";

test("credentials, machine paths and device identity never leave the machine", () => {
	const localOnly: Array<[string, string]> = [
		["apiKey", "sk-live-xxx"],
		["webSearchApiKey", "tvly-123"],
		["deviceId", "ab12cd34"],
		["ttsSherpaModelDir", "/Users/whitelau/models/sherpa"],
		["ttsSherpaVocoder", "/Users/whitelau/models/vocoder.onnx"],
		["ttsEndpoint", "https://tts.example.com/v1?key=REAL"],
		["somePassword", "hunter2"],
		["syncPassword", "…"],
	];
	for (const [key, value] of localOnly) {
		assert.equal(classifySetting(key, value), "local-only", `${key} 应当不同步`);
	}
});

test("ordinary preferences sync", () => {
	const portable: Array<[string, string]> = [
		["ocrLang", "chi_sim+eng"],
		["agentMaxTurns", "8"],
		["webSearchEnabled", "1"],
		["webSearchBackend", "auto"],
		["ttsEngine", "edge"],
		["ttsEngineMode", "local-first"],
		["ttsRate", "1.2"],
		["ttsVoice:sherpa", "12"],
		["theme", "dark"],
		["skillsExecutionEnabled", "0"],
	];
	for (const [key, value] of portable) {
		assert.equal(classifySetting(key, value), "sync", `${key} 应当同步`);
	}
});

test("secret detection is camelCase aware but does not over-match", () => {
	assert.equal(hasSecretWord("webSearchApiKey"), true);
	assert.equal(hasSecretWord("apiKey"), true);
	assert.equal(hasSecretWord("tts.api_key"), true);
	assert.equal(hasSecretWord("openai-secret"), true);
	assert.equal(hasSecretWord("ttsMaxChars"), false);
	assert.equal(hasSecretWord("agentMaxTurns"), false);
	assert.equal(hasSecretWord("ocrLang"), false);
});

test("sanitizeState drops local-only keys but keeps their stamps for the rest", () => {
	const state: SettingsState = {
		schema: 1,
		values: { ocrLang: "chi_sim+eng", apiKey: "sk-1", ttsSherpaModelDir: "/Users/x/m" },
		mtimes: {
			ocrLang: { at: 1, dev: "A" },
			apiKey: { at: 2, dev: "A" },
			ttsSherpaModelDir: { at: 3, dev: "A" },
		},
		tombstones: { apiKey: { at: 4, dev: "A" }, ttsRate: { at: 5, dev: "A" } },
	};
	const { state: clean, dropped } = sanitizeSettingsState(state);
	assert.deepEqual(Object.keys(clean.values), ["ocrLang"]);
	assert.deepEqual(Object.keys(clean.mtimes), ["ocrLang"]);
	assert.deepEqual(Object.keys(clean.tombstones), ["ttsRate"]);
	assert.deepEqual(dropped.sort(), ["apiKey", "ttsSherpaModelDir"]);
});

test("overlay keeps local-only keys instead of replacing the whole file", () => {
	// 本机原始设置里有绝对路径与残留密钥
	const raw: Record<string, string> = {
		ocrLang: "chi_sim+eng",
		agentMaxTurns: "8",
		ttsSherpaModelDir: "/Users/whitelau/models/sherpa",
		apiKey: "sk-local",
	};
	// 远端同步回来的是净身后的设置
	const synced: Record<string, string> = { ocrLang: "jpn", ttsEngine: "edge" };

	const next = overlaySyncedValues(raw, synced);
	assert.equal(next.ocrLang, "jpn", "远端值应当覆盖");
	assert.equal(next.ttsEngine, "edge", "远端新增的 key 应当写入");
	assert.equal(next.agentMaxTurns, "8", "本地独有的普通设置不应被删除");
	// 最关键的一条：本机专属字段必须原样保留
	assert.equal(next.ttsSherpaModelDir, "/Users/whitelau/models/sherpa");
	assert.equal(next.apiKey, "sk-local");
});

test("overlay is defensive: a leaked credential from upstream is still rejected", () => {
	const next = overlaySyncedValues({}, { apiKey: "sk-remote", ocrLang: "eng" });
	assert.equal(next.apiKey, undefined);
	assert.equal(next.ocrLang, "eng");
});

test("masking would overwrite the real value — which is why we drop the key instead", () => {
	const real = "https://tts.example.com/v1?key=REAL_SECRET";
	const masked = real.replace(/([?&]key=)[^&]*/, "$1***");
	// 掩码不是原值；推上去之后另一台机器拉到的是掩码，真凭据就丢了
	assert.notEqual(masked, real);
	assert.equal(masked.includes("REAL_SECRET"), false);
	// 所以这类 key 的处置只能是「整 key 剔除」
	assert.equal(classifySetting("ttsEndpoint", real), "local-only");
});

test("applyMergedSettings deletes sync keys that the merged state no longer has", () => {
	const raw: Record<string, string> = {
		ocrLang: "chi_sim+eng",
		theme: "dark",
		ttsSherpaModelDir: "/Users/x/m",
	};
	// 远端删掉了 theme；本机专属 key 不在 merged 里，但必须保留
	const merged: SettingsState = {
		schema: 1,
		values: { ocrLang: "jpn" },
		mtimes: { ocrLang: { at: 2, dev: "B" } },
		tombstones: {},
	};
	const next = applyMergedSettings(raw, merged);
	assert.equal(next.theme, undefined, "完整状态里没有的同步 key 必须被删除");
	assert.equal(next.ocrLang, "jpn");
	assert.equal(next.ttsSherpaModelDir, "/Users/x/m", "本机专属 key 不能被同步删除");
});

test("empty state is a well-formed schema-1 object", () => {
	assert.deepEqual(emptySettingsState(), { schema: 1, values: {}, mtimes: {}, tombstones: {} });
});
