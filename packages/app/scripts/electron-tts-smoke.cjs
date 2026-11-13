/**
 * Runs one real synthesis inside Electron.
 *
 * Unit tests execute in plain Node, where the sherpa addon may take a code path
 * that Electron forbids (external ArrayBuffers → "TTS settlement failed"). This
 * smoke test is the only one that runs in the real embedder, so run it after
 * touching the sherpa adapter or upgrading Electron/sherpa-onnx.
 *
 *   SHERPA_TTS_MODEL_DIR=/path/to/model npm run test:electron --workspace=@agentreader/app
 */
const { app } = require("electron");
const path = require("node:path");

app.commandLine.appendSwitch("no-sandbox");
app.disableHardwareAcceleration();

const modelDir = process.env.SHERPA_TTS_MODEL_DIR;
if (!modelDir) {
	console.error("set SHERPA_TTS_MODEL_DIR to an unpacked sherpa model bundle");
	app.exit(2);
	return;
}

function config(dir) {
	const files = require("node:fs").readdirSync(dir);
	const model = files.find((f) => f === "model.onnx") ?? files.find((f) => /^model.*\.onnx$/.test(f));
	const vocoder = files.find((f) => /vocos.*\.onnx$/.test(f));
	const isMatcha = files.some((f) => /^(model-steps|acoustic).*\.onnx$/.test(f));
	const base = { tokens: path.join(dir, "tokens.txt") };
	if (files.includes("lexicon.txt")) base.lexicon = path.join(dir, "lexicon.txt");
	const acoustic = files.find((f) => /^(model-steps|acoustic).*\.onnx$/.test(f));
	const isKokoro = files.includes("voices.bin");
	const lexicon = files
		.filter((f) => /^lexicon-.*\.txt$/.test(f))
		.map((f) => path.join(dir, f));
	const body = isKokoro
		? {
				kokoro: {
					model: path.join(dir, model),
					voices: path.join(dir, "voices.bin"),
					...base,
					...(lexicon.length ? { lexicon: lexicon.join(",") } : {}),
				},
			}
		: isMatcha
			? { matcha: { acousticModel: path.join(dir, acoustic), vocoder, ...base } }
			: { vits: { model: path.join(dir, model), ...base } };
	return {
		model: { ...body, numThreads: 2, provider: "cpu" },
		maxNumSentences: 1,
	};
}

app.whenReady().then(async () => {
	try {
		const sherpa = require("sherpa-onnx-node");
		const tts = await sherpa.OfflineTts.createAsync(config(modelDir));
		const started = Date.now();
		const audio = await tts.generateAsync({
			text: "这是一次 Electron 环境下的朗读冒烟测试。",
			sid: 0,
			speed: 1,
			// Must match src/main/tts/providers/sherpa.ts.
			enableExternalBuffer: false,
			onProgress: () => 1,
		});
		const seconds = audio.samples.length / audio.sampleRate;
		console.log(
			`OK samples=${audio.samples.length} audio=${seconds.toFixed(2)}s wall=${Date.now() - started}ms`,
		);
		app.exit(0);
	} catch (e) {
		console.error("FAILED:", e && e.message ? e.message : e);
		app.exit(1);
	}
});
