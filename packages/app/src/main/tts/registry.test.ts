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

test("a failing engine is skipped for a while instead of retried every sentence", async () => {
	const flaky = fakeEngine("a", { fail: "network" });
	const stable = fakeEngine("b");
	const registry = new TtsRegistry().register(flaky).register(stable);

	const first = await registry.synthesize(["a", "b"], req);
	assert.equal(first.engineId, "b");
	assert.equal(flaky.calls, 1);

	// Within the cooldown window the broken engine is not called again.
	const second = await registry.synthesize(["a", "b"], req);
	assert.equal(second.engineId, "b");
	assert.equal(flaky.calls, 1, "should not retry the failing engine on every sentence");
	assert.equal(stable.calls, 2);
});

test("an abort does not put the engine into cooldown", async () => {
	const aborted = fakeEngine("a", { fail: "aborted" });
	const stable = fakeEngine("b");
	const registry = new TtsRegistry().register(aborted).register(stable);
	await assert.rejects(() => registry.synthesize(["a", "b"], req));
	assert.equal(stable.calls, 0, "abort is terminal, not a fall-through");
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

test("the request is built per engine so engine-scoped voices never cross over", async () => {
	const heard: Record<string, string> = {};
	const recording = (id: string, fail?: TtsErrorKind): TtsEngine => ({
		id,
		label: id,
		capabilities: () => CAPS,
		listVoices: async () => [],
		async synthesize(req: TtsRequest): Promise<TtsResult> {
			heard[id] = req.voiceId;
			if (fail) throw new TtsError(fail, `${id} failed`, { engineId: id });
			return {
				audio: { format: "mp3", sampleRate: 24_000, data: new Uint8Array([1]) },
				boundaries: [],
			};
		},
	});
	const registry = new TtsRegistry()
		.register(recording("sherpa", "internal"))
		.register(recording("edge"));
	const out = await registry.synthesize(["sherpa", "edge"], (engineId) => ({
		text: "你好。",
		voiceId: engineId === "sherpa" ? "3" : "zh-CN-XiaoxiaoNeural",
	}));
	assert.equal(out.engineId, "edge");
	assert.deepEqual(heard, { sherpa: "3", edge: "zh-CN-XiaoxiaoNeural" });
});

test("resolveOrder reports the engine that would really speak", async () => {
	const broken = fakeEngine("a", { fail: "network" });
	const stable = fakeEngine("b");
	const registry = new TtsRegistry().register(broken).register(stable);
	assert.equal(registry.preferred(["a", "b"]), "a");
	await registry.synthesize(["a", "b"], req);
	// `a` is cooling down, so the next sentence starts at `b`.
	assert.equal(registry.preferred(["a", "b"]), "b");
	assert.deepEqual(registry.resolveOrder(["a", "b"]), ["b"]);
	// Unknown ids never appear in the order.
	assert.deepEqual(registry.resolveOrder(["missing", "b"]), ["b"]);
});
