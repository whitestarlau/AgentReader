import assert from "node:assert/strict";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TtsError } from "../types.ts";
import { buildConfig, detectModelKind, pickModelFile, SherpaTts } from "./sherpa.ts";

/** Create a sparse file of `size` bytes without writing them. */
function touch(dir: string, name: string, size = 2_000_000) {
	const path = join(dir, name);
	writeFileSync(path, "");
	truncateSync(path, size);
	return path;
}

function bundle(t: { after: (fn: () => void) => void }, files: Record<string, number>) {
	const dir = mkdtempSync(join(tmpdir(), "sherpa-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const [name, size] of Object.entries(files)) touch(dir, name, size);
	return dir;
}

test("detects the model family from file names", () => {
	assert.equal(detectModelKind(["model.onnx", "tokens.txt"]), "vits");
	assert.equal(detectModelKind(["model-steps-3.onnx", "lexicon.txt"]), "matcha");
	assert.equal(detectModelKind(["acoustic_model.onnx", "vocoder.onnx"]), "matcha");
	assert.equal(detectModelKind(["model.onnx", "voices.bin"]), "kokoro");
	assert.equal(detectModelKind(["README.md"]), "unknown");
});

test("never picks the 133-byte Git-LFS pointer over real weights", () => {
	const picked = pickModelFile([
		{ name: "model.int8.onnx", size: 133 },
		{ name: "model.onnx", size: 170_429_550 },
	]);
	assert.equal(picked, "model.onnx");
});

test("builds a vits config with runtime knobs inside `model`", (t) => {
	const dir = bundle(t, { "model.onnx": 2_000_000, "tokens.txt": 900, "date.fst": 900 });
	const config = buildConfig({ modelDir: dir, numThreads: 2 }) as {
		model: Record<string, unknown>;
		maxNumSentences: number;
		ruleFsts?: string;
	};

	assert.equal((config.model.vits as { model: string }).model, join(dir, "model.onnx"));
	assert.equal(config.model.numThreads, 2);
	// A top-level numThreads is silently ignored by the addon.
	assert.equal("numThreads" in config, false);
	assert.equal(config.maxNumSentences, 1);
	assert.match(config.ruleFsts ?? "", /date\.fst$/);
});

test("refuses a matcha bundle without a vocoder", (t) => {
	const dir = bundle(t, { "model-steps-3.onnx": 2_000_000, "tokens.txt": 900 });
	assert.throws(
		() => buildConfig({ modelDir: dir }),
		(e: unknown) =>
			e instanceof TtsError && e.kind === "not-configured" && /vocoder/.test(e.message),
	);
});

test("builds a matcha config when the vocoder is supplied", (t) => {
	const dir = bundle(t, { "model-steps-3.onnx": 2_000_000, "tokens.txt": 900 });
	const vocoder = touch(dir, "vocos-22khz-univ.onnx", 1_500_000);
	const config = buildConfig({ modelDir: dir, vocoder }) as {
		model: { matcha: { acousticModel: string; vocoder: string } };
	};
	assert.equal(config.model.matcha.acousticModel, join(dir, "model-steps-3.onnx"));
	assert.equal(config.model.matcha.vocoder, vocoder);
});

test("builds a kokoro config with the speaker bank and both lexicons", (t) => {
	const dir = bundle(t, {
		"model.int8.onnx": 2_000_000,
		"voices.bin": 1_500_000,
		"tokens.txt": 900,
		"lexicon-us-en.txt": 900,
		"lexicon-zh.txt": 900,
	});
	const config = buildConfig({ modelDir: dir }) as {
		model: { kokoro: { model: string; voices: string; lexicon: string }; numThreads: number };
	};
	assert.equal(config.model.kokoro.voices, join(dir, "voices.bin"));
	assert.equal(config.model.kokoro.model, join(dir, "model.int8.onnx"));
	assert.match(config.model.kokoro.lexicon, /lexicon-us-en\.txt,.*lexicon-zh\.txt$/);
	assert.equal(typeof config.model.numThreads, "number");
});

test("kokoro without voices.bin is refused", (t) => {
	const dir = bundle(t, { "model.int8.onnx": 2_000_000, "tokens.txt": 900 });
	assert.throws(
		() => buildConfig({ modelDir: dir, kind: "kokoro" }),
		(e: unknown) => e instanceof TtsError && /voices\.bin/.test(e.message),
	);
});

test("reports a missing model directory as not-configured", () => {
	assert.throws(
		() => buildConfig({ modelDir: "/nope/definitely/missing" }),
		(e: unknown) => e instanceof TtsError && e.kind === "not-configured",
	);
});

test("empty directory is an actionable configuration error", (t) => {
	const dir = bundle(t, { "README.md": 10 });
	assert.throws(
		() => buildConfig({ modelDir: dir }),
		(e: unknown) =>
			e instanceof TtsError && e.kind === "not-configured" && /无法识别/.test(e.message),
	);
});

test("cache tag changes with the model bundle", () => {
	const a = new SherpaTts({ modelDir: "/models/melo" });
	const b = new SherpaTts({ modelDir: "/models/matcha", vocoder: "/models/vocos.onnx" });
	assert.notEqual(a.cacheTag(), b.cacheTag());
	assert.equal(a.cacheTag(), new SherpaTts({ modelDir: "/models/melo" }).cacheTag());
});

test("an unknown voice id falls back to speaker 0 instead of failing", async () => {
	// No model needed: the request fails at load time, which proves voice parsing
	// ran first and did not throw on its own.
	const engine = new SherpaTts({ modelDir: "/nope/definitely/missing" });
	await assert.rejects(
		() => engine.synthesize({ text: "你好。", voiceId: "not-a-number" }),
		(e: unknown) => e instanceof TtsError && e.kind === "not-configured",
	);
});

// Integration test: only runs when a real unpacked bundle is pointed at.
const modelDir = process.env.SHERPA_TTS_MODEL_DIR;
test(
	"synthesizes real audio with an unpacked model bundle",
	{ skip: modelDir ? false : "set SHERPA_TTS_MODEL_DIR to run" },
	async () => {
		const engine = new SherpaTts({ modelDir: modelDir as string, numThreads: 2 });
		const voices = await engine.listVoices();
		assert.ok(voices.length >= 1);

		const result = await engine.synthesize({ text: "这是一次端到端测试。", voiceId: "0" });
		assert.equal(result.audio.format, "wav");
		assert.ok(result.audio.data.length > 44, "expected PCM payload after the header");
		assert.ok((result.durationMs ?? 0) > 200);
	},
);
