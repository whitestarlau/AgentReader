import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SyncBackend } from "./backend.ts";
import { createLocalFolderBackend } from "./backends/local-folder.ts";
import { createClock } from "./clock.ts";
import { createEngine, type EngineStorage, type SettingsPort, type SyncIndex } from "./engine.ts";
import { type DocState, emptyDocState } from "./merge-records.ts";
import type { SettingsState, Stamp } from "./types.ts";

/**
 * 两台机器跑在一个进程里：共享一个「云端」目录，各自有独立的本地设置与基线。
 * 这是 P1 的核心验收场景，全部离线可跑。
 */
function machine(name: string, remoteRoot: string, initial: Record<string, string> = {}) {
	const clock = createClock({ deviceId: name });
	const values: Record<string, string> = { ...initial };
	const stamps: Record<string, Stamp> = {};
	for (const key of Object.keys(values)) stamps[key] = clock.next();
	let base: SettingsState | undefined;
	const docBases = new Map<string, DocState>();
	const docs = new Map<string, DocState>();
	let index: SyncIndex = { settingsRev: 0, docs: {} };

	const settings: SettingsPort & {
		set(key: string, value: string): void;
		unset(key: string): void;
		value(key: string): string | undefined;
		all(): Record<string, string>;
	} = {
		read: () => ({ values: { ...values }, stamps: { ...stamps } }),
		write: (nextValues, nextStamps) => {
			for (const key of Object.keys(values)) if (!(key in nextValues)) delete values[key];
			for (const [key, value] of Object.entries(nextValues)) {
				if (values[key] === value) continue;
				values[key] = value;
				stamps[key] = nextStamps[key] ?? clock.next();
			}
		},
		set: (key, value) => {
			values[key] = value;
			stamps[key] = clock.next();
		},
		unset: (key) => {
			delete values[key];
			delete stamps[key];
		},
		value: (key) => values[key],
		all: () => ({ ...values }),
	};

	const storage: EngineStorage = {
		readBase: () => base,
		writeBase: (state) => {
			base = state;
		},
		readDocBase: (docId) => docBases.get(docId),
		writeDocBase: (docId, state) => {
			docBases.set(docId, state);
		},
		readIndex: () => ({ ...index, docs: { ...index.docs } }),
		writeIndex: (next) => {
			index = next;
		},
	};

	const engine = createEngine({
		backend: createLocalFolderBackend({ root: remoteRoot }),
		settings,
		storage,
		docs: {
			list: () => [...docs.keys()],
			read: (docId) => docs.get(docId) ?? null,
			write: (docId, state) => {
				docs.set(docId, state);
			},
		},
	});
	return { engine, settings, docs };
}

/**
 * 包一层「写后回读会读到旧内容」的后端，用来验证 §3.4.3 的回读校验与重试。
 * 真实世界里这对应：两台设备同时写、或服务方有缓存延迟。
 */
function staleOnVerify(root: string, times: number): SyncBackend {
	const inner = createLocalFolderBackend({ root });
	let pendingStale = 0;
	let budget = times;
	return {
		...inner,
		async put(path, data, opts) {
			const result = await inner.put(path, data, opts);
			// 只让前 `times` 次写的回读变脏，之后的回读是诚实的
			if (budget > 0) {
				budget -= 1;
				pendingStale = 1;
			}
			return result;
		},
		async get(path) {
			if (pendingStale > 0) {
				pendingStale -= 1;
				return Buffer.from(
					'{"schema":1,"rev":1,"values":{"ocrLang":"stale"},"mtimes":{},"tombstones":{}}',
				);
			}
			return inner.get(path);
		},
	};
}

function remote(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), "ar-sync-remote-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("S1: a setting changed on A arrives on B", async (t) => {
	const cloud = remote(t);
	const a = machine("A", cloud);
	const b = machine("B", cloud, { ocrLang: "chi_sim+eng" });

	a.settings.set("ocrLang", "jpn");
	await a.engine.sync();
	await b.engine.sync();

	assert.equal(b.settings.value("ocrLang"), "jpn");
});

test("S2: concurrent edits to different keys both survive", async (t) => {
	const cloud = remote(t);
	const a = machine("A", cloud, { ocrLang: "chi_sim+eng", ttsEngine: "edge" });
	const b = machine("B", cloud, { ocrLang: "chi_sim+eng", ttsEngine: "edge" });
	// 现实流程：先启用同步让两台机器都拿到基线，之后才开始各自编辑
	await a.engine.sync();
	await b.engine.sync();

	a.settings.set("ocrLang", "jpn");
	b.settings.set("ttsEngine", "sherpa");
	await a.engine.sync();
	await b.engine.sync();
	await a.engine.sync(); // A 拉回 B 的改动

	assert.equal(a.settings.value("ocrLang"), "jpn");
	assert.equal(a.settings.value("ttsEngine"), "sherpa");
	assert.equal(b.settings.value("ocrLang"), "jpn");
	assert.equal(b.settings.value("ttsEngine"), "sherpa");
});

test("S3: the same key changed on both sides reports a conflict and converges", async (t) => {
	const cloud = remote(t);
	const a = machine("A", cloud, { theme: "dark" });
	const b = machine("B", cloud, { theme: "dark" });
	await a.engine.sync();
	await b.engine.sync(); // 先让 B 也有基线，才开始「双方都改」

	a.settings.set("theme", "light");
	b.settings.set("theme", "dark-blue");
	const reportA = await a.engine.sync();
	const reportB = await b.engine.sync();

	const conflicts = [...reportA.conflicts, ...reportB.conflicts];
	assert.ok(conflicts.length >= 1, "至少一方应报出冲突");
	// 输掉的一方的值必须留在冲突记录里（不静默丢失）
	const loserValues = conflicts.map((c) => c.local ?? c.remote);
	assert.ok(loserValues.includes("light") || loserValues.includes("dark-blue"));

	// 收敛发生在下一轮：胜出者已被推上云端，输的一方下次 pull 时接受它
	await a.engine.sync();
	assert.equal(a.settings.value("theme"), b.settings.value("theme"), "第二轮必须收敛到同一个值");
});

test("S5: a fresh machine accepts the cloud instead of overwriting it", async (t) => {
	const cloud = remote(t);
	const a = machine("A", cloud);
	a.settings.set("ocrLang", "jpn");
	a.settings.set("agentMaxTurns", "12");
	await a.engine.sync();

	const fresh = machine("B", cloud);
	await fresh.engine.sync();

	assert.equal(fresh.settings.value("ocrLang"), "jpn");
	assert.equal(fresh.settings.value("agentMaxTurns"), "12");
});

test("an unchanged machine costs a single GET and does not push", async (t) => {
	const cloud = remote(t);
	const a = machine("A", cloud);
	a.settings.set("theme", "dark");
	await a.engine.sync();

	const report = await a.engine.sync();
	assert.equal(report.pushed, false);
	assert.equal(report.pulled, false);
	// 设置一次 GET + 书库一次 list；没有任何 PUT
	assert.equal(report.requests, 2, "没有变化时不应产生任何写入请求");
});

test("a deletion propagates to the other machine", async (t) => {
	const cloud = remote(t);
	const a = machine("A", cloud, { theme: "dark", ocrLang: "chi_sim+eng" });
	const b = machine("B", cloud);
	await a.engine.sync();
	await b.engine.sync();
	assert.equal(b.settings.value("theme"), "dark");

	a.settings.unset("theme");
	await a.engine.sync();
	await b.engine.sync();

	assert.equal(a.settings.value("theme"), undefined);
	assert.equal(b.settings.value("theme"), undefined);
	assert.equal(b.settings.value("ocrLang"), "chi_sim+eng", "删除不应波及别的 key");
});

test("local-only settings never reach the cloud nor the other machine", async (t) => {
	const cloud = remote(t);
	const a = machine("A", cloud, {
		ocrLang: "chi_sim+eng",
		ttsSherpaModelDir: "/Users/whitelau/models/sherpa",
		apiKey: "sk-local",
	});
	await a.engine.sync();

	const b = machine("B", cloud);
	await b.engine.sync();

	assert.equal(b.settings.value("ocrLang"), "chi_sim+eng");
	assert.equal(b.settings.value("ttsSherpaModelDir"), undefined);
	assert.equal(b.settings.value("apiKey"), undefined);
	// A 自己的本机专属 key 也不该被应用合并结果时删掉
	assert.equal(a.settings.value("ttsSherpaModelDir"), "/Users/whitelau/models/sherpa");
});

test("a stale read-back is detected and the push is retried instead of being trusted", async (t) => {
	const cloud = remote(t);
	const clock = createClock({ deviceId: "A" });
	let values: Record<string, string> = { ocrLang: "chi_sim+eng" };
	let stamps: Record<string, { at: number; dev: string }> = {};
	let base: SettingsState | undefined;
	let index: SyncIndex = { settingsRev: 0, docs: {} };
	const settings: SettingsPort = {
		read: () => ({ values: { ...values }, stamps: { ...stamps } }),
		write: (nextValues) => {
			values = { ...nextValues };
			stamps = Object.fromEntries(
				Object.entries(nextValues).map(([key]) => [key, clock.next()] as const),
			);
		},
	};
	const storage: EngineStorage = {
		readBase: () => base,
		writeBase: (state) => {
			base = state;
		},
		readIndex: () => ({ ...index }),
		writeIndex: (next) => {
			index = next;
		},
	};
	const engine = createEngine({ backend: staleOnVerify(cloud, 1), settings, storage });

	const report = await engine.sync();
	assert.equal(report.pushed, true);
	// 第一次 PUT 后的回读被判定为「被覆盖」，于是重新拉取、重新合并、再推一次
	assert.ok(report.requests >= 5, `应当重试过一次，实际请求数 ${report.requests}`);

	const stored = await createLocalFolderBackend({ root: cloud }).get("settings/state.json");
	assert.ok(stored, "远端应当留下最终内容");
	assert.equal(JSON.parse(stored.toString()).values.ocrLang, "chi_sim+eng");
});

test("a backend that never confirms the write fails after three attempts instead of reporting success", async (t) => {
	const cloud = remote(t);
	const clock = createClock({ deviceId: "A" });
	const settings: SettingsPort = {
		read: () => ({ values: { ocrLang: "jpn" }, stamps: { ocrLang: clock.next() } }),
		write: () => {},
	};
	const storage: EngineStorage = {
		readBase: () => undefined,
		writeBase: () => {},
		readIndex: () => ({ settingsRev: 0, docs: {} }),
		writeIndex: () => {},
	};
	const engine = createEngine({ backend: staleOnVerify(cloud, 99), settings, storage });
	await assert.rejects(
		() => engine.sync(),
		(error: unknown) => error instanceof Error && /回读校验/.test(error.message),
	);
});

// ---------------------------------------------------------------- 书库同步

const annotation = (id: string, text: string, at: number, dev: string) => ({
	id,
	page: 12,
	text,
	updatedAt: at,
	deviceId: dev,
});

test("D1: an annotation and a reading position travel to the other machine", async (t) => {
	const cloud = remote(t);
	const a = machine("A", cloud);
	const b = machine("B", cloud);

	const base = emptyDocState("doc1", "一本书", "pdf");
	a.docs.set("doc1", {
		...base,
		annotations: [annotation("an1", "重点", 1, "A")],
		position: { page: 30, location: null, at: 1, dev: "A" },
	});
	await a.engine.sync({ dirtyDocs: ["doc1"] });

	b.docs.set("doc1", emptyDocState("doc1", "一本书", "pdf"));
	await b.engine.sync();

	const pulled = b.docs.get("doc1");
	assert.ok(pulled);
	assert.deepEqual(
		pulled.annotations.map((entry) => entry.id),
		["an1"],
	);
	assert.equal(pulled.position.page, 30);
});

test("D2: concurrent annotation + chat changes on two machines both survive", async (t) => {
	const cloud = remote(t);
	const a = machine("A", cloud);
	const b = machine("B", cloud);

	const seed: DocState = {
		...emptyDocState("doc1", "一本书", "pdf"),
		conversations: [{ id: "c1", title: "默认对话" }],
		chats: { c1: [{ id: "m1", role: "user", content: "你好", timestamp: 1 }] },
	};
	a.docs.set("doc1", seed);
	await a.engine.sync({ dirtyDocs: ["doc1"] });
	b.docs.set("doc1", seed);
	await b.engine.sync();

	// A 加一条标注，B 追加一条对话
	a.docs.set("doc1", {
		...seed,
		annotations: [annotation("an1", "A 的标注", 2, "A")],
	});
	b.docs.set("doc1", {
		...seed,
		chats: {
			c1: [
				...(seed.chats.c1 ?? []),
				{ id: "m2", role: "assistant", content: "回答", timestamp: 2 },
			],
		},
	});

	await a.engine.sync({ dirtyDocs: ["doc1"] });
	await b.engine.sync({ dirtyDocs: ["doc1"] });
	await a.engine.sync({ dirtyDocs: ["doc1"] });

	const mergedA = a.docs.get("doc1");
	const mergedB = b.docs.get("doc1");
	assert.ok(mergedA && mergedB);
	for (const state of [mergedA, mergedB]) {
		assert.deepEqual(
			state.annotations.map((entry) => entry.id),
			["an1"],
		);
		assert.deepEqual(
			(state.chats.c1 ?? []).map((entry) => entry.id),
			["m1", "m2"],
		);
	}
});

test("D3: pushing a book and pulling it back costs the expected number of requests", async (t) => {
	const cloud = remote(t);
	const a = machine("A", cloud);
	a.docs.set("doc1", {
		...emptyDocState("doc1", "一本书", "pdf"),
		annotations: [annotation("an1", "x", 1, "A")],
	});

	const first = await a.engine.sync({ dirtyDocs: ["doc1"] });
	// 设置 1 次 GET + 书库 1 次 list + 1 次 PUT + 1 次回读
	assert.ok(first.requests >= 4, `首次推送至少要 4 次请求，实际 ${first.requests}`);

	const second = await a.engine.sync();
	assert.ok(second.requests <= 3, `没有变化时只应有设置 GET + 书库 list，实际 ${second.requests}`);
	assert.equal(second.pushed, false);
});
