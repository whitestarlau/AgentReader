import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkBackendContract, type SyncBackend, SyncError } from "./backend.ts";
import { createLocalFolderBackend } from "./backends/local-folder.ts";
import type { RemoteEntry } from "./types.ts";

function tempDir(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), "ar-sync-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("local-folder backend satisfies the backend contract", async (t) => {
	const backend = createLocalFolderBackend({ root: tempDir(t) });
	assert.deepEqual(await checkBackendContract(backend), []);
});

test("the contract check actually catches a bad backend", async (t) => {
	const good = createLocalFolderBackend({ root: tempDir(t) });
	// 故意破坏两处约定：返回带前导斜杠的路径、get 对缺失对象返回空 Buffer
	const broken: SyncBackend = {
		...good,
		id: "broken",
		async list(prefix: string): Promise<RemoteEntry[]> {
			const entries = await good.list(prefix);
			return entries.map((e) => ({ ...e, path: `/${e.path}` }));
		},
	};
	const problems = await checkBackendContract(broken);
	assert.ok(
		problems.some((p) => p.includes("前导 /")),
		`应报出前导斜杠问题，实际：${problems}`,
	);
});

test("paths cannot escape the sync root", async (t) => {
	const backend = createLocalFolderBackend({ root: tempDir(t) });
	await assert.rejects(
		() => backend.put("../escaped.txt", Buffer.from("x")),
		(e: unknown) => e instanceof SyncError && e.code === "forbidden",
	);
});

test("an iCloud placeholder is reported as an actionable error, not as content", async (t) => {
	const root = tempDir(t);
	const backend = createLocalFolderBackend({ root });
	mkdirSync(join(root, "state"), { recursive: true });
	// 「优化存储空间」驱逐后的形态：.state/xxx.json.icloud
	writeFileSync(join(root, "state", ".abc.json.icloud"), "placeholder");
	await assert.rejects(
		() => backend.get("state/abc.json"),
		(e: unknown) => e instanceof SyncError && e.code === "not-found" && e.retryable,
	);
});

test("overwrite is atomic and read-back equals what was written", async (t) => {
	const backend = createLocalFolderBackend({ root: tempDir(t) });
	const first = Buffer.from("第一版");
	await backend.put("state/a.json", first);
	const { etag } = await backend.put("state/a.json", Buffer.from("第二版"));
	const back = await backend.get("state/a.json");
	assert.equal(back?.toString(), "第二版");
	assert.ok(etag, "put 必须返回 etag，上层要用它做条件写");
});

test("conditional writes reject stale etags and existing objects", async (t) => {
	const backend = createLocalFolderBackend({ root: tempDir(t) });
	const { etag } = await backend.put("state/a.json", Buffer.from("v1"));
	assert.ok(etag);

	await assert.rejects(
		() => backend.put("state/a.json", Buffer.from("v2"), { ifMatch: "stale" }),
		(e: unknown) => e instanceof SyncError && e.status === 412 && e.retryable,
	);
	await assert.rejects(
		() => backend.put("state/a.json", Buffer.from("v2"), { ifNoneMatch: true }),
		(e: unknown) => e instanceof SyncError && e.status === 412,
	);

	// 正确的 etag 必须放行
	await backend.put("state/a.json", Buffer.from("v3"), { ifMatch: etag });
	assert.equal((await backend.get("state/a.json"))?.toString(), "v3");
});

test("list skips dotfiles, reports directories, and keeps POSIX relative paths", async (t) => {
	const root = tempDir(t);
	const backend = createLocalFolderBackend({ root });
	await backend.put("state/a.json", Buffer.from("{}"));
	await backend.put("books/b.pdf", Buffer.from("pdf"));
	mkdirSync(join(root, "empty"), { recursive: true });
	writeFileSync(join(root, "state", ".hidden.json"), "x");

	const entries = await backend.list("");
	const paths = entries.map((e) => e.path).sort();
	assert.deepEqual(paths, ["books", "books/b.pdf", "empty", "state", "state/a.json"]);
	assert.equal(entries.find((e) => e.path === "books")?.isDir, true);
	assert.equal(entries.find((e) => e.path === "state/a.json")?.size, 2);
});

test("delete is idempotent", async (t) => {
	const backend = createLocalFolderBackend({ root: tempDir(t) });
	await backend.put("state/a.json", Buffer.from("x"));
	await backend.del("state/a.json");
	await backend.del("state/a.json");
	assert.equal(await backend.get("state/a.json"), null);
});

test("test() reports writability for a directory that does not exist yet", async (t) => {
	const root = join(tempDir(t), "not-created-yet", "nested");
	const backend = createLocalFolderBackend({ root });
	const result = await backend.test();
	assert.equal(result.ok, true);
});
