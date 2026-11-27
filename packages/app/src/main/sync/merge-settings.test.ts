import assert from "node:assert/strict";
import test from "node:test";
import { mergeSettings, snapshotSettings } from "./merge-settings.ts";
import type { Conflict, SettingsState, Stamp } from "./types.ts";

const state = (
	values: Record<string, string>,
	mtimes: Record<string, Stamp> = {},
): SettingsState => ({
	schema: 1,
	values,
	mtimes,
	tombstones: {},
});

/** 一台设备的严格递增时钟（与 clock.ts 同语义，测试里不需要真实时间）。 */
const device = (name: string) => {
	let last = 0;
	return () => {
		last += 1;
		return { at: last, dev: name };
	};
};

const canon = (s: SettingsState): string =>
	JSON.stringify({
		values: Object.keys(s.values)
			.sort()
			.map((k) => [k, s.values[k]]),
		mtimes: Object.keys(s.mtimes)
			.sort()
			.map((k) => [k, s.mtimes[k].at, s.mtimes[k].dev]),
	});

/** 冲突按「key + 两个值（排序后）」归一，ignore 掉 local/remote 这种方向性字段。 */
const canonConflicts = (conflicts: Conflict[]): string =>
	JSON.stringify(
		conflicts
			.map((c) => {
				const pair = [c.local ?? null, c.remote ?? null].sort((a, b) =>
					String(a).localeCompare(String(b)),
				);
				return [c.key, c.reason, pair[0], pair[1]];
			})
			.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
	);

/** 可复现的伪随机数（mulberry32），避免 fuzz 用例偶发抖动。 */
const rng = (seed: number) => {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const KEYS = [
	"ocrLang",
	"agentMaxTurns",
	"webSearchEnabled",
	"webSearchBackend",
	"ttsEngine",
	"ttsEngineMode",
	"ttsRate",
	"ttsVoice:sherpa",
	"theme",
	"skillsExecutionEnabled",
];
const VALUES = [
	"0",
	"1",
	"chi_sim+eng",
	"8",
	"auto",
	"brave",
	"edge",
	"sherpa",
	"1.2",
	"dark",
	"local-first",
];

function randomState(clock: () => Stamp, mutate: number, random: () => number): SettingsState {
	const values: Record<string, string> = {};
	const mtimes: Record<string, Stamp> = {};
	for (const key of KEYS) {
		if (random() < 0.5) continue;
		values[key] = VALUES[Math.floor(random() * VALUES.length)];
		mtimes[key] = clock();
	}
	for (const key of KEYS) {
		if (!(key in values)) continue;
		if (random() > mutate) continue;
		if (random() < 0.25) {
			delete values[key];
			delete mtimes[key];
			continue;
		}
		values[key] = VALUES[Math.floor(random() * VALUES.length)];
		mtimes[key] = clock();
	}
	return state(values, mtimes);
}

test("a change made on one side lands without any conflict", () => {
	const A = device("A");
	const base = state({ ocrLang: "chi_sim+eng", agentMaxTurns: "8" });
	const local = state({ ocrLang: "chi_sim+eng", agentMaxTurns: "12" }, { agentMaxTurns: A() });
	const remote = state({ ocrLang: "jpn", agentMaxTurns: "8" }, { ocrLang: A() });

	const { state: merged, conflicts } = mergeSettings(base, local, remote);
	assert.equal(merged.values.ocrLang, "jpn");
	assert.equal(merged.values.agentMaxTurns, "12");
	assert.deepEqual(conflicts, []);
});

test("merge is independent of the pull direction (fuzz)", () => {
	const A = device("A");
	const B = device("B");
	const random = rng(20261125);
	for (let i = 0; i < 1500; i++) {
		const base = randomState(A, 0, random);
		const local = randomState(A, 0.35, random);
		const remote = randomState(B, 0.35, random);
		const one = mergeSettings(base, local, remote);
		const two = mergeSettings(base, remote, local);
		assert.equal(canon(one.state), canon(two.state), `第 ${i} 轮方向相关`);
		assert.equal(
			canonConflicts(one.conflicts),
			canonConflicts(two.conflicts),
			`第 ${i} 轮冲突不对称`,
		);
	}
});

test("merging a state with itself is a no-op (fuzz)", () => {
	const A = device("A");
	const random = rng(7);
	for (let i = 0; i < 800; i++) {
		const base = randomState(A, 0, random);
		const x = randomState(A, 0.35, random);
		const { state: merged, conflicts } = mergeSettings(base, x, x);
		assert.equal(canon(merged), canon(x), `第 ${i} 轮幂等被破坏`);
		assert.deepEqual(conflicts, []);
	}
});

test("delete semantics: untouched side is removed, modified side is preserved", () => {
	const A = device("A");
	const base = state({ ocrLang: "chi_sim+eng", theme: "dark" });

	// 本机删了 theme，另一台没动 → 删除
	const local = state({ ocrLang: "chi_sim+eng" });
	const remoteUntouched = state({ ocrLang: "chi_sim+eng", theme: "dark" });
	const removed = mergeSettings(base, local, remoteUntouched);
	assert.equal("theme" in removed.state.values, false);

	// 本机删了 theme，另一台改过 → 保留并报冲突
	const remoteEdited = state({ ocrLang: "chi_sim+eng", theme: "light" }, { theme: A() });
	const kept = mergeSettings(base, local, remoteEdited);
	assert.equal(kept.state.values.theme, "light");
	assert.equal(kept.conflicts.length, 1);
	assert.equal(kept.conflicts[0].reason, "delete-vs-modify");
});

test("a fresh device does not overwrite the cloud with an empty state", () => {
	const B = device("B");
	const remote = state({ ocrLang: "jpn", theme: "light" }, { ocrLang: B(), theme: B() });

	const fresh = mergeSettings(undefined, state({}), remote);
	assert.equal(fresh.state.values.ocrLang, "jpn");
	assert.deepEqual(fresh.conflicts, []);

	// 反向：云端为空而本机有值，也不能被清空
	const local = state({ ocrLang: "chi_sim+eng" });
	const empty = mergeSettings(undefined, local, state({}));
	assert.equal(empty.state.values.ocrLang, "chi_sim+eng");
});

test("without a baseline the remote wins, and the local value survives in the conflict record", () => {
	const B = device("B");
	// 本机已有配置，但还没建立基线；云端也有一份不同的配置
	const local = state({ ocrLang: "chi_sim+eng" }, { ocrLang: B() });
	const remote = state({ ocrLang: "jpn" }, { ocrLang: { at: 99, dev: "A" } });

	const { state: merged, conflicts } = mergeSettings(undefined, local, remote);
	assert.equal(merged.values.ocrLang, "jpn", "无基线时应接受远端（acceptRemote）");
	assert.equal(conflicts.length, 1, "被覆盖的本机值必须留在冲突里，不能静默丢");
	assert.equal(conflicts[0].local, "chi_sim+eng");
	assert.equal(conflicts[0].winner, "remote");
});

test("without a baseline, keys only present locally still get uploaded", () => {
	const B = device("B");
	const local = state({ agentMaxTurns: "12" }, { agentMaxTurns: B() });
	const remote = state({ ocrLang: "jpn" });
	const { state: merged } = mergeSettings(undefined, local, remote);
	assert.equal(merged.values.agentMaxTurns, "12");
	assert.equal(merged.values.ocrLang, "jpn");
});

test("after a tie-break the next round stops repeating the same conflict", () => {
	const A = device("A");
	const B = device("B");
	const base = state({ agentMaxTurns: "8" });
	const local = state({ agentMaxTurns: "16" }, { agentMaxTurns: A() });
	const remote = state({ agentMaxTurns: "24" }, { agentMaxTurns: B() });

	const onLocal = mergeSettings(base, local, remote);
	const onRemote = mergeSettings(base, remote, local);
	assert.equal(onLocal.state.values.agentMaxTurns, onRemote.state.values.agentMaxTurns);

	const secondRound = mergeSettings(base, onLocal.state, onRemote.state);
	assert.deepEqual(secondRound.conflicts, []);
	assert.equal(canon(secondRound.state), canon(onLocal.state));
});

test("snapshotting for the next baseline drops local-only keys", () => {
	const snapshot = snapshotSettings(
		{ ocrLang: "chi_sim+eng", apiKey: "sk-1", ttsVoices: "a,b" },
		{ ocrLang: { at: 1, dev: "A" }, apiKey: { at: 2, dev: "A" } },
	);
	assert.deepEqual(Object.keys(snapshot.values).sort(), ["ocrLang", "ttsVoices"]);
	assert.equal("apiKey" in snapshot.mtimes, false);
});
