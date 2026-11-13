import assert from "node:assert/strict";
import test from "node:test";
import { TtsRegistry } from "./registry.ts";
import {
	type TtsCapabilities,
	type TtsEngine,
	TtsError,
	type TtsErrorKind,
	type TtsRequest,
	type TtsResult,
	type TtsVoice,
} from "./types.ts";

const CAPS: TtsCapabilities = {
	streaming: false,
	boundaries: "none",
	formats: ["mp3"],
	maxCharsPerRequest: 4000,
	offline: false,
	requiresConfig: true,
	rate: true,
	pitch: false,
};

function fakeEngine(
	id: string,
	opts: { fail?: TtsErrorKind; voices?: TtsVoice[] } = {},
): TtsEngine & { calls: number } {
	const engine = {
		id,
		label: id,
		calls: 0,
		capabilities: () => CAPS,
		listVoices: async () => {
			if (opts.fail === "not-configured") throw new TtsError("not-configured", `${id} has no key`);
			return opts.voices ?? [{ id: `${id}-v`, name: id, lang: "zh-CN" }];
		},
		async synthesize(_req: TtsRequest): Promise<TtsResult> {
			engine.calls++;
			if (opts.fail) throw new TtsError(opts.fail, `${id} failed`, { engineId: id });
			return {
				audio: { format: "mp3", sampleRate: 24_000, data: new Uint8Array([1, 2, 3]) },
				boundaries: [],
			};
		},
	};
	return engine;
}

const req: TtsRequest = { text: "你好。", voiceId: "v" };

test("falls through to the next engine and reports the hop", async () => {
	const registry = new TtsRegistry()
		.register(fakeEngine("a", { fail: "network" }))
		.register(fakeEngine("b"));
	const notes: string[] = [];
	const out = await registry.synthesize(["a", "b"], req, (n) => notes.push(`${n.from}->${n.to}`));
	assert.equal(out.engineId, "b");
	assert.deepEqual(notes, ["a->b"]);
});

test("does not fall through on abort", async () => {
	const registry = new TtsRegistry()
		.register(fakeEngine("a", { fail: "aborted" }))
		.register(fakeEngine("b"));
	await assert.rejects(
		() => registry.synthesize(["a", "b"], req),
		(e: unknown) => e instanceof TtsError && e.kind === "aborted",
	);
});

test("skips unknown engine ids and still succeeds", async () => {
	const registry = new TtsRegistry().register(fakeEngine("b"));
	const out = await registry.synthesize(["missing", "b"], req);
	assert.equal(out.engineId, "b");
});

test("reports every engine when the whole chain fails", async () => {
	const registry = new TtsRegistry()
		.register(fakeEngine("a", { fail: "not-configured" }))
		.register(fakeEngine("b", { fail: "rate-limited" }));
	await assert.rejects(
		() => registry.synthesize(["a", "b"], req),
		(e: unknown) => {
			assert.ok(e instanceof Error);
			assert.match(e.message, /a: a failed/);
			assert.match(e.message, /b: b failed/);
			return true;
		},
	);
});

test("explains an empty chain instead of throwing a generic error", async () => {
	const registry = new TtsRegistry();
	await assert.rejects(() => registry.synthesize([], req), /没有可用的朗读引擎/);
});

test("collects voices from every engine that answers", async () => {
	const registry = new TtsRegistry()
		.register(fakeEngine("a"))
		.register(fakeEngine("b", { fail: "not-configured" }))
		.register(fakeEngine("c", { voices: [] }));
	const groups = await registry.allVoices();
	assert.deepEqual(
		groups.map((g) => g.engineId),
		["a"],
	);
});
