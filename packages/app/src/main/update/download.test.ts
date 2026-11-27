import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { UpdateProgress } from "../../shared/update.ts";
import { downloadFile, isCompleteFile, sha256File } from "./download.ts";

const BODY = Buffer.from("AgentReader update payload ".repeat(2000));
const DIGEST = createHash("sha256").update(BODY).digest("hex");

function tempDir(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), "ar-update-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function okResponse(): Response {
	return new Response(BODY, {
		status: 200,
		headers: { "content-length": String(BODY.length) },
	});
}

test("streams to disk and verifies the release digest", async (t) => {
	const dir = tempDir(t);
	const dest = join(dir, "AgentReader-0.4.0-arm64.dmg");
	const events: UpdateProgress[] = [];
	const done = await downloadFile({
		url: "https://github.com/x/AgentReader-0.4.0-arm64.dmg",
		dest,
		expectedBytes: BODY.length,
		sha256: DIGEST,
		fetchImpl: async () => okResponse(),
		onProgress: (p) => events.push(p),
	});
	assert.equal(done.sha256, DIGEST);
	assert.equal(done.bytes, BODY.length);
	assert.deepEqual(readFileSync(dest), BODY);
	assert.equal(existsSync(`${dest}.part`), false);
	// 至少有一次进度回调，且最终值为 100%。
	assert.ok(events.length >= 1);
	assert.equal(events.at(-1)?.percent, 100);
});

test("a checksum mismatch deletes the partial file", async (t) => {
	const dir = tempDir(t);
	const dest = join(dir, "AgentReader-0.4.0-arm64.dmg");
	await assert.rejects(
		downloadFile({
			url: "https://github.com/x/AgentReader-0.4.0-arm64.dmg",
			dest,
			expectedBytes: BODY.length,
			sha256: "a".repeat(64),
			fetchImpl: async () => okResponse(),
		}),
		(error: Error & { code?: string }) => error.code === "checksum",
	);
	assert.equal(existsSync(dest), false);
	assert.equal(existsSync(`${dest}.part`), false);
});

test("a short body is rejected by the declared size", async (t) => {
	const dir = tempDir(t);
	const dest = join(dir, "AgentReader-0.4.0-arm64.dmg");
	await assert.rejects(
		downloadFile({
			url: "https://github.com/x/AgentReader-0.4.0-arm64.dmg",
			dest,
			expectedBytes: BODY.length + 10,
			sha256: DIGEST,
			fetchImpl: async () => okResponse(),
		}),
		(error: Error & { code?: string }) => error.code === "incomplete",
	);
	assert.equal(existsSync(dest), false);
	assert.equal(existsSync(`${dest}.part`), false);
});

test("plain http download urls are refused", async (t) => {
	const dir = tempDir(t);
	await assert.rejects(
		downloadFile({
			url: "http://example.com/AgentReader.dmg",
			dest: join(dir, "x.dmg"),
			fetchImpl: async () => okResponse(),
		}),
		(error: Error & { code?: string }) => error.code === "bad-response",
	);
});

test("an aborted download ends as cancelled and leaves nothing behind", async (t) => {
	const dir = tempDir(t);
	const dest = join(dir, "AgentReader.dmg");
	const abort = new AbortController();
	const stalled = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(Buffer.from("partial")));
			// 不 close：模拟连接卡住。
		},
	});
	const pending = downloadFile({
		url: "https://github.com/x/AgentReader.dmg",
		dest,
		expectedBytes: 1024,
		signal: abort.signal,
		fetchImpl: async () => new Response(stalled, { status: 200 }),
	});
	setTimeout(() => abort.abort(), 50);
	await assert.rejects(pending, (error: Error & { code?: string }) => error.code === "cancelled");
	assert.equal(existsSync(dest), false);
	assert.equal(existsSync(`${dest}.part`), false);
});

test("isCompleteFile reuses a file only when size and digest match", async (t) => {
	const dir = tempDir(t);
	const file = join(dir, "done.dmg");
	writeFileSync(file, BODY);
	assert.equal(await isCompleteFile(file, BODY.length, DIGEST), true);
	assert.equal(await isCompleteFile(file, BODY.length, "b".repeat(64)), false);
	assert.equal(await isCompleteFile(file, BODY.length + 1, DIGEST), false);
	assert.equal(await isCompleteFile(join(dir, "missing.dmg"), 1), false);
	assert.equal(await sha256File(file), DIGEST);
});
