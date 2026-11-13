import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ModelEntry, TTS_MODELS } from "./catalog.ts";
import {
	cancelDownload,
	downloadModel,
	isInstalled,
	type ModelProgress,
	modelDir,
	removeModel,
} from "./models.ts";
import { TtsError } from "./types.ts";

function tempRoot(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), "tts-models-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function writeSized(path: string, size: number) {
	writeFileSync(path, "");
	truncateSync(path, size);
}

const vitsEntry: ModelEntry = {
	id: "test-vits",
	name: "test",
	family: "vits",
	lang: "zh-CN",
	desc: "",
	license: "",
	commercial: true,
	sizeLabel: "",
	assets: [{ kind: "bundle", url: "", name: "x.tar.bz2", bytes: 1 }],
};

const matchaEntry: ModelEntry = {
	...vitsEntry,
	id: "test-matcha",
	family: "matcha",
	vocoderName: "vocoder.onnx",
	assets: [{ kind: "bundle", url: "", name: "x.tar.bz2", bytes: 1 }],
};

test("catalog entries are well formed", () => {
	const ids = new Set<string>();
	for (const m of TTS_MODELS) {
		assert.ok(!ids.has(m.id), `duplicate id ${m.id}`);
		ids.add(m.id);
		assert.ok(m.assets.length > 0);
		for (const a of m.assets) {
			assert.match(a.url, /^https:\/\//);
			assert.ok(a.bytes > 1_000_000, `${a.name} should declare a real size`);
		}
		if (m.family === "matcha") assert.ok(m.vocoderName, "matcha needs a vocoder");
	}
});

test("installed means real weights are present, not a partial download", (t) => {
	const root = tempRoot(t);
	const dir = modelDir(vitsEntry.id, root);
	assert.equal(isInstalled(vitsEntry, root), false);

	mkdirSync(dir, { recursive: true });
	writeSized(join(dir, "model.onnx"), 133); // Git-LFS pointer
	writeFileSync(join(dir, "tokens.txt"), "a 1");
	assert.equal(isInstalled(vitsEntry, root), false, "a 133-byte pointer must not count");

	writeSized(join(dir, "model.onnx"), 2_000_000);
	assert.equal(isInstalled(vitsEntry, root), true);
});

test("kokoro also requires the speaker bank", (t) => {
	const root = tempRoot(t);
	const entry: ModelEntry = { ...vitsEntry, id: "test-kokoro", family: "kokoro" };
	const dir = modelDir(entry.id, root);
	mkdirSync(dir, { recursive: true });
	writeSized(join(dir, "model.onnx"), 2_000_000);
	assert.equal(isInstalled(entry, root), false);

	writeSized(join(dir, "voices.bin"), 133);
	assert.equal(isInstalled(entry, root), false);

	writeSized(join(dir, "voices.bin"), 1_500_000);
	assert.equal(isInstalled(entry, root), true);
});

test("matcha also requires a real vocoder", (t) => {
	const root = tempRoot(t);
	const dir = modelDir(matchaEntry.id, root);
	mkdirSync(dir, { recursive: true });
	writeSized(join(dir, "model-steps-3.onnx"), 2_000_000);
	assert.equal(isInstalled(matchaEntry, root), false);

	writeSized(join(dir, "vocoder.onnx"), 133);
	assert.equal(isInstalled(matchaEntry, root), false);

	writeSized(join(dir, "vocoder.onnx"), 1_500_000);
	assert.equal(isInstalled(matchaEntry, root), true);
});

/** Build a real .tar.bz2 whose single top-level dir must be stripped on extract. */
function buildBundle(t: { after: (fn: () => void) => void }): string | null {
	const work = mkdtempSync(join(tmpdir(), "tts-bundle-"));
	t.after(() => rmSync(work, { recursive: true, force: true }));
	const pkg = join(work, "bundle");
	mkdirSync(pkg);
	writeSized(join(pkg, "model.onnx"), 2_000_000);
	writeFileSync(join(pkg, "tokens.txt"), "a 1\n");
	const archive = join(work, "bundle.tar.bz2");
	try {
		execFileSync("tar", ["-cjf", archive, "-C", work, "bundle"], { stdio: "ignore" });
		return archive;
	} catch {
		return null;
	}
}

async function serveFile(t: { after: (fn: () => void) => void }, file: string) {
	const server = createServer((_req, res) => {
		const body = readFileSync(file);
		res.writeHead(200, { "Content-Length": String(body.length) });
		res.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections?.();
		server.close();
	});
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

test("downloads, extracts and validates a bundle", async (t) => {
	const archive = buildBundle(t);
	if (!archive) return t.skip("system tar unavailable");
	const base = await serveFile(t, archive);
	const root = tempRoot(t);
	const entry: ModelEntry = {
		...vitsEntry,
		assets: [
			{
				kind: "bundle",
				url: `${base}/bundle.tar.bz2`,
				name: "bundle.tar.bz2",
				bytes: statSync(archive).size,
			},
		],
	};

	const phases: ModelProgress[] = [];
	await downloadModel(entry, (p) => phases.push(p), root);

	assert.ok(isInstalled(entry, root));
	assert.ok(readFileSync(join(modelDir(entry.id, root), "tokens.txt"), "utf8").includes("a 1"));
	assert.ok(phases.some((p) => p.phase === "download" && p.received > 0));
	assert.equal(phases.at(-1)?.phase, "done");
});

test("a truncated download fails loudly and leaves no model behind", async (t) => {
	const archive = buildBundle(t);
	if (!archive) return t.skip("system tar unavailable");
	const base = await serveFile(t, archive);
	const root = tempRoot(t);
	const entry: ModelEntry = {
		...vitsEntry,
		assets: [
			{ kind: "bundle", url: `${base}/bundle.tar.bz2`, name: "bundle.tar.bz2", bytes: 9_000_000 },
		],
	};

	await assert.rejects(
		() => downloadModel(entry, () => {}, root),
		(e: unknown) => e instanceof TtsError && e.kind === "network",
	);
	assert.equal(isInstalled(entry, root), false);
});

test("cancel aborts an in-flight download and cleans up", async (t) => {
	const root = tempRoot(t);
	// A server that sends a header then stalls forever.
	const server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Length": "100000000" });
		res.write(Buffer.alloc(1024));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections?.();
		server.close();
	});
	const { port } = server.address() as AddressInfo;
	const entry: ModelEntry = {
		...vitsEntry,
		assets: [
			{
				kind: "bundle",
				url: `http://127.0.0.1:${port}/slow.tar.bz2`,
				name: "slow.tar.bz2",
				bytes: 100_000_000,
			},
		],
	};

	const pending = downloadModel(entry, () => {}, root);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(cancelDownload(entry.id), true);
	await assert.rejects(pending, (e: unknown) => e instanceof TtsError && e.kind === "aborted");
	assert.equal(isInstalled(entry, root), false);
});

test("remove deletes an installed model", (t) => {
	const root = tempRoot(t);
	const dir = modelDir(vitsEntry.id, root);
	mkdirSync(dir, { recursive: true });
	writeSized(join(dir, "model.onnx"), 2_000_000);
	assert.equal(isInstalled(vitsEntry, root), true);

	removeModel(vitsEntry, root);
	assert.equal(isInstalled(vitsEntry, root), false);
});
