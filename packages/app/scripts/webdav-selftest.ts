#!/usr/bin/env node
/**
 * WebDAV 真机自测：用你的真实账号把后端的每一条语义跑一遍。
 *
 * 这个脚本存在的理由：计划 §8 的待实测项（ETag 格式、quota 属性、429 口径、MKCOL 行为）
 * 只能在真机上观察，而它们又直接影响同步策略。与其在界面里点，不如一条命令跑完。
 *
 * 用法：
 *   WEBDAV_URL=https://dav.jianguoyun.com/dav/ \
 *   WEBDAV_USER=you@example.com WEBDAV_PASS=应用密码 \
 *   node --experimental-strip-types packages/app/scripts/webdav-selftest.ts --preset jianguoyun
 *
 * 不联网的冒烟（验证脚本本身）：
 *   node --experimental-strip-types packages/app/scripts/webdav-selftest.ts --local /tmp/ar-selftest
 */

import { checkBackendContract, type SyncBackend, SyncError } from "../src/main/sync/backend.ts";
import { createLocalFolderBackend } from "../src/main/sync/backends/local-folder.ts";
import { createWebdavBackend } from "../src/main/sync/backends/webdav.ts";
import { normalizeEndpoint } from "../src/main/sync/connect.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};
const has = (name: string) => args.includes(name);

let failures = 0;
const results: Array<{ name: string; ok: boolean; note: string }> = [];

function record(name: string, ok: boolean, note = ""): void {
	results.push({ name, ok, note });
	if (!ok) failures += 1;
	console.log(`${ok ? "✓" : "✗"} ${name}${note ? `  — ${note}` : ""}`);
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
	const started = Date.now();
	const value = await run();
	return { value, ms: Date.now() - started };
}

async function main(): Promise<void> {
	const localDir = flag("--local");
	const presetId = flag("--preset");
	let backend: SyncBackend;
	let label: string;
	let cleanup: (() => Promise<void>) | null = null;

	if (localDir) {
		backend = createLocalFolderBackend({ root: localDir });
		label = `本地文件夹 ${localDir}`;
	} else {
		const endpoint = process.env.WEBDAV_URL ?? "";
		const account = process.env.WEBDAV_USER ?? "";
		const secret = process.env.WEBDAV_PASS ?? "";
		if (!endpoint || !account || !secret) {
			console.error(
				"缺少环境变量。需要 WEBDAV_URL / WEBDAV_USER / WEBDAV_PASS，或用 --local <目录> 做离线冒烟。",
			);
			process.exitCode = 2;
			return;
		}
		const normalized = normalizeEndpoint(endpoint);
		if (!normalized.ok) {
			console.error(`地址不可用：${normalized.message}`);
			process.exitCode = 2;
			return;
		}
		const rootName = flag("--root") ?? "AgentReader-selftest";
		backend = createWebdavBackend({
			config: { endpoint: normalized.url, account, secret, rootName },
			presetId,
		});
		label = `${normalized.url}（预设：${presetId ?? "custom"}）`;
		cleanup = async () => {
			// 留个可选的收尾：需要保留现场时传 --keep
			if (has("--keep")) return;
			try {
				await backend.rmdir?.("");
			} catch {}
		};
	}

	console.log(`\n目标：${label}\n`);

	// 1. 连接与配额
	const test = await timed(() => backend.test());
	if (test.value.ok) {
		const free = test.value.freeBytes;
		record(
			"连接成功",
			true,
			free === undefined
				? `耗时 ${test.ms}ms；服务方未返回 quota-available-bytes（界面上不显示剩余空间）`
				: `耗时 ${test.ms}ms；剩余 ${(free / 1024 ** 3).toFixed(2)} GB`,
		);
	} else {
		record("连接失败", false, `${test.value.error.title}：${test.value.error.detail}`);
		console.log("\n后面的检查已跳过。");
		process.exitCode = 1;
		await cleanup?.();
		return;
	}

	// 2. 契约自检：任何实现都必须满足的不变式
	const problems = await checkBackendContract(backend);
	record("后端契约自检", problems.length === 0, problems.join("；") || "get/put/list/mkdir/del 语义一致");

	// 3. 真实写入路径（中文名 + 嵌套目录）
	const dir = "state";
	const file = `${dir}/自测-${Date.now()}.json`;
	const payload = Buffer.from(JSON.stringify({ schema: 1, hello: "同步", at: Date.now() }));
	const put = await timed(() => backend.put(file, payload));
	const readBack = await backend.get(file);
	record(
		"写入并回读",
		Boolean(readBack && readBack.equals(payload)),
		`耗时 ${put.ms}ms；ETag ${put.value.etag ?? "（服务方未返回）"}`,
	);

	const entries = await backend.list(dir);
	const hit = entries.find((entry) => entry.path === file);
	record("列目录包含刚写入的文件", Boolean(hit), `${dir}/ 下 ${entries.length} 项`);
	record(
		"list 返回 ETag",
		Boolean(hit?.etag),
		hit?.etag ? `格式 ${hit.etag}` : "没有 ETag：条件写会退化，改由写后回读兜底",
	);

	// 4. 条件写：这是「并发不互相覆盖」的关键
	let conditionalOk = false;
	let conditionalNote = "";
	try {
		await backend.put(file, Buffer.from("stale"), { ifMatch: "definitely-not-matching" });
		conditionalNote = "服务方接受了错误的 If-Match（不安全，必须依赖写后回读）";
	} catch (error) {
		conditionalOk = error instanceof SyncError && error.status === 412;
		conditionalNote = error instanceof SyncError ? `返回 ${String(error.status)}` : String(error);
	}
	record("If-Match 生效（不匹配返回 412）", conditionalOk, conditionalNote);

	// 5. 删除幂等
	await backend.del(file);
	await backend.del(file);
	record("删除幂等", (await backend.get(file)) === null);

	await cleanup?.();

	// 6. 汇总
	console.log("\n结果：");
	for (const result of results) {
		console.log(`  ${result.ok ? "✓" : "✗"} ${result.name}`);
	}
	if (failures > 0) {
		console.log(`\n${failures} 项未通过。`);
		process.exitCode = 1;
		return;
	}
	console.log("\n全部通过。还需要人工确认两项（脚本不该替你打这些请求）：");
	console.log("  · 429 / 限流：把密码故意填错几次，观察是否变成账号锁定（如 Koofr）；或在设置里看请求余额是否被正确统计");
	console.log("  · 配额口径：坚果云免费版 600 次 / 30 分钟是否包含 PROPFIND、按账号还是按 IP");
}

await main();
