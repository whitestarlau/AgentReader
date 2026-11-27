import assert from "node:assert/strict";
import test from "node:test";
import { buildChain, emptyChainMessage } from "./chain.ts";

/** edge/openai are online; sherpa is the on-device engine. */
const isLocal = (id: string) => id === "sherpa";
const available = ["edge", "openai-compatible", "sherpa"];
const base = { available, isLocal } as const;

test("auto falls back to the old order when nothing has worked yet", () => {
	assert.deepEqual(buildChain({ ...base, mode: "auto" }), ["edge", "openai-compatible", "sherpa"]);
});

test("auto starts from the engine that last worked", () => {
	// The free endpoint failed and the local model carried the reading: the next
	// sentence must not wait for another timeout.
	assert.deepEqual(buildChain({ ...base, mode: "auto", lastGood: "sherpa" }), [
		"sherpa",
		"edge",
		"openai-compatible",
	]);
	// A stale id (engine gone) is ignored rather than pushed to the front.
	assert.deepEqual(buildChain({ ...base, mode: "auto", lastGood: "gone" }), [
		"edge",
		"openai-compatible",
		"sherpa",
	]);
});

test("online-first and local-first only differ in class order", () => {
	assert.deepEqual(buildChain({ ...base, mode: "online-first" }), [
		"edge",
		"openai-compatible",
		"sherpa",
	]);
	assert.deepEqual(buildChain({ ...base, mode: "local-first" }), [
		"sherpa",
		"edge",
		"openai-compatible",
	]);
});

test("only-modes never cross classes", () => {
	assert.deepEqual(buildChain({ ...base, mode: "local-only" }), ["sherpa"]);
	assert.deepEqual(buildChain({ ...base, mode: "online-only" }), ["edge", "openai-compatible"]);
	// No local engine installed: local-only has nothing to try, and says why
	// instead of quietly going online.
	assert.deepEqual(buildChain({ available: ["edge"], isLocal, mode: "local-only" }), []);
	assert.match(emptyChainMessage("local-only"), /本地模型/);
	assert.match(emptyChainMessage("online-only"), /在线引擎/);
});

test("a requested engine is used alone, even across classes", () => {
	// Voice preview: falling back would play another engine's voice.
	assert.deepEqual(buildChain({ ...base, mode: "local-only", requested: "edge" }), ["edge"]);
	assert.deepEqual(buildChain({ ...base, mode: "online-only", requested: "sherpa" }), ["sherpa"]);
	// Unknown ids are not invented; the mode chain applies instead.
	assert.deepEqual(buildChain({ ...base, mode: "local-only", requested: "nope" }), ["sherpa"]);
});

test("a pinned engine moves to the front of its own class only", () => {
	assert.deepEqual(buildChain({ ...base, mode: "online-first", pinned: "sherpa" }), [
		"edge",
		"openai-compatible",
		"sherpa",
	]);
	assert.deepEqual(buildChain({ ...base, mode: "online-first", pinned: "openai-compatible" }), [
		"openai-compatible",
		"edge",
		"sherpa",
	]);
	assert.deepEqual(buildChain({ ...base, mode: "local-only", pinned: "edge" }), ["sherpa"]);
	// auto has no class preference, so the pin is simply first.
	assert.deepEqual(buildChain({ ...base, mode: "auto", pinned: "sherpa" }), [
		"sherpa",
		"edge",
		"openai-compatible",
	]);
});

test("an empty registry yields an empty chain instead of throwing", () => {
	assert.deepEqual(buildChain({ available: [], isLocal, mode: "auto" }), []);
	assert.deepEqual(buildChain({ available: [], isLocal, mode: "online-first" }), []);
});
