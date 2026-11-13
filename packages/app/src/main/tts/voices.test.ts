import assert from "node:assert/strict";
import test from "node:test";
import { resolveVoiceId, voiceSettingKey } from "./voices.ts";

test("an explicit request wins over settings", () => {
	assert.equal(resolveVoiceId("sherpa", "12", { "ttsVoice:sherpa": "7" }), "12");
});

test("each engine keeps its own voice", () => {
	assert.equal(resolveVoiceId("sherpa", undefined, { "ttsVoice:sherpa": "7" }), "7");
	// A voice picked for another engine must not leak in (ids are engine-scoped).
	assert.equal(resolveVoiceId("sherpa", undefined, { "ttsVoice:mock": "mock-zh" }), "0");
});

test("falls back to the engine default", () => {
	assert.equal(resolveVoiceId("sherpa", undefined, {}), "0");
	assert.equal(resolveVoiceId("openai-compatible", undefined, {}), "zf_xiaobei");
	assert.equal(resolveVoiceId("mock", undefined, {}), "mock-zh");
});

test("blank values are ignored", () => {
	assert.equal(
		resolveVoiceId("openai-compatible", "  ", { "ttsVoice:openai-compatible": "" }),
		"zf_xiaobei",
	);
});

test("setting keys are namespaced per engine", () => {
	assert.equal(voiceSettingKey("sherpa"), "ttsVoice:sherpa");
});
