import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { TtsError } from "../types.ts";
import { OpenAiCompatibleTts } from "./openai-compatible.ts";

/** 4-byte RIFF/WAVE header stub — enough for format sniffing. */
const WAV_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
const MP3_BYTES = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function withServer(t: { after: (fn: () => void) => void }, handler: Handler) {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => handler(req, res, body));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections?.();
		server.close();
	});
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}/v1`;
}

function engineFor(baseUrl: string) {
	return new OpenAiCompatibleTts({
		baseUrl,
		model: "kokoro",
		defaultVoice: "zf_xiaobei",
		voices: ["zf_xiaobei", "zm_yunxi"],
	});
}

test("posts the OpenAI speech payload and sniffs the real format", async (t) => {
	let seen: Record<string, unknown> = {};
	const base = await withServer(t, (req, res, body) => {
		assert.equal(req.url, "/v1/audio/speech");
		seen = JSON.parse(body);
		res.writeHead(200, { "Content-Type": "audio/mpeg" });
		res.end(Buffer.from(WAV_BYTES));
	});
	const engine = engineFor(base);
	const result = await engine.synthesize({ text: "你好。", voiceId: "zm_yunxi", rate: 1.2 });

	assert.deepEqual(seen, {
		model: "kokoro",
		input: "你好。",
		voice: "zm_yunxi",
		response_format: "mp3",
		speed: 1.2,
	});
	// The server lied about the content type; the bytes win.
	assert.equal(result.audio.format, "wav");
	assert.equal(result.audio.data.length, WAV_BYTES.length);
	assert.equal(typeof result.firstAudioMs, "number");
});

test("maps 401 to not-configured and 429 to rate-limited", async (t) => {
	const base = await withServer(t, (_req, res) => {
		res.writeHead(429, { "Content-Type": "text/plain" });
		res.end("too many requests");
	});
	const engine = engineFor(base);
	await assert.rejects(
		() => engine.synthesize({ text: "你好。", voiceId: "v" }),
		(e: unknown) => e instanceof TtsError && e.kind === "rate-limited",
	);

	const authBase = await withServer(t, (_req, res) => {
		res.writeHead(401);
		res.end("bad key");
	});
	await assert.rejects(
		() => engineFor(authBase).synthesize({ text: "你好。", voiceId: "v" }),
		(e: unknown) => e instanceof TtsError && e.kind === "not-configured",
	);
});

test("an unreachable endpoint is a network error, an empty body is internal", async (t) => {
	const dead = new OpenAiCompatibleTts({
		baseUrl: "http://127.0.0.1:1/v1",
		model: "kokoro",
		defaultVoice: "v",
		timeoutMs: 2000,
	});
	await assert.rejects(
		() => dead.synthesize({ text: "你好。", voiceId: "v" }),
		(e: unknown) => e instanceof TtsError && e.kind === "network",
	);

	const emptyBase = await withServer(t, (_req, res) => {
		res.writeHead(200);
		res.end();
	});
	await assert.rejects(
		() => engineFor(emptyBase).synthesize({ text: "你好。", voiceId: "v" }),
		(e: unknown) => e instanceof TtsError && e.kind === "internal",
	);
});

test("mp3 frames are detected when the server returns mp3", async (t) => {
	const base = await withServer(t, (_req, res) => {
		res.writeHead(200, { "Content-Type": "audio/mpeg" });
		res.end(Buffer.from(MP3_BYTES));
	});
	const result = await engineFor(base).synthesize({ text: "你好。", voiceId: "v" });
	assert.equal(result.audio.format, "mp3");
});

test("loopback endpoints are advertised as offline-capable", () => {
	const local = engineFor("http://127.0.0.1:8880/v1");
	assert.equal(local.capabilities().offline, true);
	const remote = engineFor("https://api.example.com/v1");
	assert.equal(remote.capabilities().offline, false);
});
