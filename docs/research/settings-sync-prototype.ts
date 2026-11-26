// AgentReader 设置同步（L0 层）：净化策略 + key 级三方合并 的原型与验证
//
// 这不是产品代码，而是 docs/sync-research.md §4 的结论的可复现验证：
//   P1 单侧变更：只有一台机器改过的 key，必须原样落地
//   P2 收敛性：merge(base, L, R) 与 merge(base, R, L) 结果一致（与拉取方向无关）
//   P3 幂等：merge(base, X, X) === X
//   P4 无丢失：任何一方写过的 key，都不会凭空消失
//   P5 删除语义：一侧删、另一侧没动 → 删；一侧删、另一侧改过 → 保留并报冲突
//   P6 净化：凭据 / 绝对路径 / 本机专属 key 永不进入同步体
//   P7 首装：base 缺失时不会拿本机状态覆盖云端
//
// 运行：node --experimental-strip-types docs/research/settings-sync-prototype.ts
// 预期：以 ok 开头的若干行，最后一行 summary

import assert from "node:assert";

// ---------------------------------------------------------------- types

/** 每台设备维护的混合逻辑时钟：同一设备内严格递增（HLC 最简形式）。 */
export type Stamp = { at: number; dev: string };
export type SyncSettings = {
	schema: 1;
	/** 净化后的 settings.json 键值（全部为字符串，与现有 AppSettings 一致）。 */
	values: Record<string, string>;
	/** 每个 key 最后一次写入的戳，用于兜底裁决。 */
	mtimes: Record<string, Stamp>;
	/** 删除墓碑：只在一侧删除、另一侧又没基线可比时保证「删除」不复活。 */
	tombstones: Record<string, Stamp>;
};

export type Conflict = {
	key: string;
	reason: "both-changed" | "delete-vs-modify";
	local?: string;
	remote?: string;
	winner: "local" | "remote";
};

const emptyState = (): SyncSettings => ({ schema: 1, values: {}, mtimes: {}, tombstones: {} });

// ------------------------------------------------------- P6. 净化（先于合并）

/**
 * 本机专属 key：值本身与这台机器绑定，同步过去只会污染另一台机器。
 * 注意这里用的是「剔除」而不是「掩码」——掩码值一旦被推上云端，
 * 就会把另一台机器上的真实配置覆盖成 `***`（见 demoMaskingIsWrong）。
 */
const LOCAL_ONLY_KEYS = new Set([
	"apiKey", // 旧版单提供商密钥（现在存 auth.json，但 settings 里可能残留）
	"deviceId", // 本机身份，由本机自己生成
	"ttsSherpaModelDir", // 本地模型绝对路径
	"ttsSherpaVocoder", // 同上
	"syncPassword", // 同步口令只在本机 safeStorage 里
]);

const ABS_PATH_RE = /^(?:\/Users\/|\/home\/|\/Volumes\/|\/private\/|\/opt\/|[A-Za-z]:\\)/;
/** URL 里带凭据（`?key=…`、`&token=…`）的值同样属于本机专属。 */
const URL_CRED_RE = /[?&](key|token|api[_-]?key|apikey|access_token|auth)=/i;

/**
 * 判断 key 名里是否含凭据词。先把 `:`/`.`/`-` 归一成 `_`，再把驼峰拆开，
 * 这样 `webSearchApiKey`、`tts.api_key`、`apiKey` 都会命中，
 * 而 `ttsMaxChars`、`agentMaxTurns` 不会误伤。
 */
const SECRET_WORD_RE = /(^|_)(api_?key|apikey|secret|token|passw(or)?d|credential|bearer|auth)($|_)/;
export function hasSecretWord(key: string): boolean {
	const normalized = key
		.replace(/[.:-]/g, "_")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase();
	return SECRET_WORD_RE.test(normalized);
}

export function classify(key: string, value: string): "sync" | "local-only" {
	if (LOCAL_ONLY_KEYS.has(key)) return "local-only";
	if (hasSecretWord(key)) return "local-only";
	if (ABS_PATH_RE.test(value)) return "local-only";
	if (URL_CRED_RE.test(value)) return "local-only";
	return "sync";
}

export function sanitizeState(s: SyncSettings): { state: SyncSettings; dropped: string[] } {
	const out = emptyState();
	const dropped: string[] = [];
	for (const [k, v] of Object.entries(s.values)) {
		if (classify(k, v) === "local-only") {
			dropped.push(k);
			continue;
		}
		out.values[k] = v;
		if (s.mtimes[k]) out.mtimes[k] = s.mtimes[k];
	}
	// 墓碑同样要净化：否则「删掉一个本机专属 key」会被当成同步事件推给别人
	for (const [k, st] of Object.entries(s.tombstones)) {
		if (LOCAL_ONLY_KEYS.has(k) || hasSecretWord(k)) continue;
		out.tombstones[k] = st;
	}
	return { state: out, dropped };
}

/** 反例演示：如果改用「掩码」，会把另一台机器的真值覆盖掉。 */
export function demoMaskingIsWrong(): { masked: string; loss: boolean } {
	const real = "https://tts.example.com/v1?key=REAL_SECRET";
	const masked = real.replace(/([?&]key=)[^&]*/, "$1***");
	const loss = masked !== real ? !masked.includes("REAL_SECRET") : false;
	return { masked, loss };
}

// ------------------------------------------------------------- P1-P5. 合并

const cmpStamp = (a: Stamp, b: Stamp) =>
	a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.dev < b.dev ? -1 : a.dev > b.dev ? 1 : 0;

const maxStamp = (a: Stamp | undefined, b: Stamp | undefined): Stamp | undefined => {
	if (!a) return b;
	if (!b) return a;
	return cmpStamp(a, b) >= 0 ? a : b;
};

/**
 * 设置合并：以「上次同步成功的快照」为基线，逐 key 判定。
 *
 * 设置是扁平的 `Record<string, string>`，所以「一条记录」的粒度就是单个 key ——
 * 这也是这里与书库同步（记录级三方合并）的唯一区别：粒度更细，冲突面更小。
 *
 * @param base 上次同步成功的快照；缺失时退化为「有值的一方胜出」，绝不删数据
 */
export function mergeSettings(
	base: SyncSettings | undefined,
	localRaw: SyncSettings,
	remoteRaw: SyncSettings,
): { state: SyncSettings; conflicts: Conflict[] } {
	const b0 = base ? sanitizeState(base).state : undefined;
	const l0 = sanitizeState(localRaw).state;
	const r0 = sanitizeState(remoteRaw).state;

	const out = emptyState();
	const conflicts: Conflict[] = [];
	const keys = new Set([
		...Object.keys(b0?.values ?? {}),
		...Object.keys(l0.values),
		...Object.keys(r0.values),
		...Object.keys(l0.tombstones),
		...Object.keys(r0.tombstones),
	]);

	const put = (k: string, v: string | undefined, st: Stamp | undefined) => {
		if (v === undefined) {
			delete out.values[k];
			if (st) out.tombstones[k] = st;
			return;
		}
		out.values[k] = v;
		delete out.tombstones[k];
		if (st) out.mtimes[k] = st;
	};

	for (const k of keys) {
		const bv = b0?.values[k];
		const lv = l0.values[k];
		const rv = r0.values[k];
		const lt = l0.mtimes[k];
		const rt = r0.mtimes[k];

		// 两侧一致（含两侧都删）
		if (lv === rv) {
			put(k, lv, maxStamp(lt, rt));
			continue;
		}

		// 有基线时：只有一侧偏离基线，直接采纳偏离的那一侧
		if (b0 && lv === bv) {
			put(k, rv, rt);
			continue;
		}
		if (b0 && rv === bv) {
			put(k, lv, lt);
			continue;
		}

		// 没有基线时：缺席不等于删除，有值的一方胜出，避免新设备清空云端
		if (!b0 && lv === undefined) {
			put(k, rv, rt);
			continue;
		}
		if (!b0 && rv === undefined) {
			put(k, lv, lt);
			continue;
		}

		// 真冲突 1：一侧删除、一侧改过 → 保留数据（宁可多留不可误删），并报冲突
		if (lv === undefined || rv === undefined) {
			const keepSide: "local" | "remote" = lv !== undefined ? "local" : "remote";
			put(k, keepSide === "local" ? lv : rv, maxStamp(lt, rt));
			conflicts.push({ key: k, reason: "delete-vs-modify", local: lv, remote: rv, winner: keepSide });
			continue;
		}

		// 真冲突 2：两侧都改且值不同 → 全序键兜底
		let winner: "local" | "remote";
		if (lt && rt && cmpStamp(lt, rt) !== 0) winner = cmpStamp(lt, rt) > 0 ? "local" : "remote";
		// 戳完全相同时用值本身做末位键，保证结果与达成顺序无关
		else winner = lv > rv ? "local" : "remote";
		put(k, winner === "local" ? lv : rv, maxStamp(lt, rt));
		conflicts.push({ key: k, reason: "both-changed", local: lv, remote: rv, winner });
	}

	return { state: out, conflicts };
}

// ------------------------------------------------- 文件型配置（整文件 LWW）

export type FileSlot = { text: string; at: number; dev: string };
export type FileMap = Record<string, FileSlot>;

/**
 * `custom-providers.json` / `model-overrides.json` 这类「应用维护、纯 JSON、
 * 没有细粒度语义」的文件按整份处理：谁的最后写入戳更大谁赢，输的一方进冲突列表。
 * 这是 VSCode 对 settings/snippets 这类资源分桶后「整资源 push/pull」的同一套语义。
 */
export function mergeFileMap(
	base: FileMap | undefined,
	local: FileMap,
	remote: FileMap,
): { files: FileMap; conflicts: Conflict[] } {
	const files: FileMap = {};
	const conflicts: Conflict[] = [];
	const paths = new Set([
		...Object.keys(base ?? {}),
		...Object.keys(local),
		...Object.keys(remote),
	]);
	for (const p of paths) {
		const b = base?.[p];
		const l = local[p];
		const r = remote[p];
		const ls = l ? `${l.at}:${l.dev}` : "";
		const rs = r ? `${r.at}:${r.dev}` : "";
		const bs = b ? `${b.at}:${b.dev}` : "";
		if (ls === rs) {
			if (l) files[p] = l;
			continue;
		}
		if (base && ls === bs) {
			if (r) files[p] = r;
			continue;
		}
		if (base && rs === bs) {
			if (l) files[p] = l;
			continue;
		}
		if (!l) {
			if (r) files[p] = r;
			continue;
		}
		if (!r) {
			files[p] = l;
			continue;
		}
		const winner = l.at !== r.at ? (l.at > r.at ? l : r) : l.dev >= r.dev ? l : r;
		files[p] = winner;
		conflicts.push({
			key: p,
			reason: "both-changed",
			local: l.text,
			remote: r.text,
			winner: winner === l ? "local" : "remote",
		});
	}
	return { files, conflicts };
}

// --------------------------------------------------------------- 测试脚手架

const dev = (name: string) => {
	let last = 0;
	return () => ({ at: (last = Math.max(Date.now() % 1000, last + 1)), dev: name });
};

const state = (values: Record<string, string>, mtimes: Record<string, Stamp> = {}): SyncSettings => ({
	...emptyState(),
	values,
	mtimes,
});

const canonState = (s: SyncSettings) =>
	JSON.stringify({
		values: Object.keys(s.values)
			.sort()
			.map((k) => [k, s.values[k]]),
		mtimes: Object.keys(s.mtimes)
			.sort()
			.map((k) => [k, s.mtimes[k].at, s.mtimes[k].dev]),
		tombstones: Object.keys(s.tombstones)
			.sort()
			.map((k) => [k, s.tombstones[k].at, s.tombstones[k].dev]),
	});

/** 冲突按「key + 两个值（排序后）」归一，忽略 local/remote 这种方向性字段。 */
const canonConflicts = (cs: Conflict[]) =>
	JSON.stringify(
		cs
			.map((c) => {
				const pair = [c.local ?? null, c.remote ?? null].sort((x, y) => String(x).localeCompare(String(y)));
				return [c.key, c.reason, pair[0], pair[1]];
			})
			.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
	);

const KEYS = [
	"ocrLang",
	"agentMaxTurns",
	"webSearchEnabled",
	"webSearchBackend",
	"webSearchMaxResults",
	"ttsEngine",
	"ttsRate",
	"ttsVoice:sherpa",
	"ttsVoice:edge",
	"theme",
	"skillsExecutionEnabled",
	"ttsEndpoint",
];
const VALUES = ["0", "1", "chi_sim+eng", "8", "auto", "brave", "5", "edge", "sherpa", "1.2", "dark", "light"];

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const randState = (clock: () => Stamp, mutate: number) => {
	const values: Record<string, string> = {};
	const mtimes: Record<string, Stamp> = {};
	for (const k of KEYS) {
		if (Math.random() < 0.55) continue;
		values[k] = pick(VALUES);
		mtimes[k] = clock();
	}
	for (const k of KEYS) {
		if (!(k in values)) continue;
		if (Math.random() > mutate) continue;
		if (Math.random() < 0.25) {
			delete values[k];
			delete mtimes[k];
			continue;
		}
		values[k] = pick(VALUES);
		mtimes[k] = clock();
	}
	return state(values, mtimes);
};

// ------------------------------------------------------------------ P1

{
	const A = dev("A");
	const base = state({ ocrLang: "chi_sim+eng", agentMaxTurns: "8" }, {});
	const local = state({ ocrLang: "chi_sim+eng", agentMaxTurns: "12" }, { agentMaxTurns: A() });
	const remote = state({ ocrLang: "jpn", agentMaxTurns: "8" }, { ocrLang: A() });
	const { state: m, conflicts } = mergeSettings(base, local, remote);
	assert.equal(m.values.ocrLang, "jpn", "远端单侧变更必须落地");
	assert.equal(m.values.agentMaxTurns, "12", "本机单侧变更必须落地");
	assert.equal(conflicts.length, 0, "单侧变更不该产生冲突");
	console.log("ok P1 单侧变更自动合并，冲突 0 条");
}

// ------------------------------------------------------------------ P2

{
	let checked = 0;
	const A = dev("A");
	const B = dev("B");
	for (let i = 0; i < 3000; i++) {
		const base = randState(A, 0);
		const local = randState(A, 0.35);
		const remote = randState(B, 0.35);
		const m1 = mergeSettings(base, local, remote);
		const m2 = mergeSettings(base, remote, local);
		assert.equal(canonState(m1.state), canonState(m2.state), `方向无关性在第 ${i} 轮被破坏`);
		assert.equal(canonConflicts(m1.conflicts), canonConflicts(m2.conflicts), `冲突集合在第 ${i} 轮不对称`);
		checked++;
	}
	console.log(`ok P2 收敛性：${checked} 轮随机用例，两个拉取方向结果一致`);
}

// ------------------------------------------------------------------ P3

{
	let checked = 0;
	const A = dev("A");
	for (let i = 0; i < 2000; i++) {
		const base = randState(A, 0);
		const x = randState(A, 0.35);
		const { state: m, conflicts } = mergeSettings(base, x, x);
		const clean = state(x.values, x.mtimes);
		for (const k of Object.keys(clean.mtimes)) if (!(k in clean.values)) delete clean.mtimes[k];
		assert.equal(canonState(m), canonState(clean), `幂等在第 ${i} 轮被破坏`);
		assert.equal(conflicts.length, 0, "两侧相同不该报冲突");
		checked++;
	}
	console.log(`ok P3 幂等：${checked} 轮，merge(base, X, X) === X`);
}

// ------------------------------------------------------------------ P4 + P5

{
	const A = dev("A");
	const base = state({ ocrLang: "chi_sim+eng", theme: "dark", ttsRate: "1" });
	// 本机删了 theme（另一台没动）→ 应当删除
	const local = state({ ocrLang: "chi_sim+eng", ttsRate: "1" });
	const remote = state({ ocrLang: "chi_sim+eng", theme: "dark", ttsRate: "1.2" }, { ttsRate: A() });
	const r1 = mergeSettings(base, local, remote);
	assert.equal("theme" in r1.state.values, false, "一侧删除、另一侧未动 → 应删除");
	assert.equal(r1.state.values.ttsRate, "1.2");

	// 本机删了 theme，另一台改过 theme → 保留并报冲突
	const remote2 = state({ ocrLang: "chi_sim+eng", theme: "light", ttsRate: "1" }, { theme: A() });
	const r2 = mergeSettings(base, local, remote2);
	assert.equal(r2.state.values.theme, "light", "删除 vs 修改必须保留数据");
	assert.equal(r2.conflicts.length, 1);
	assert.equal(r2.conflicts[0].reason, "delete-vs-modify");
	console.log("ok P4/P5 删除语义：未动的一侧被删除，改过的一侧被保留并报冲突");
}

// ------------------------------------------------------------------ P6

{
	const A = dev("A");
	const dirty = state(
		{
			ocrLang: "chi_sim+eng",
			apiKey: "sk-live-xxx",
			deviceId: "dev-aaa",
			ttsSherpaModelDir: "/Users/whitelau/models/sherpa",
			ttsEndpoint: "https://tts.example.com/v1?key=REAL_SECRET",
			"webSearchApiKey": "tvly-123",
			ttsEngine: "edge",
		},
		{},
	);
	const { state: clean, dropped } = sanitizeState(dirty);
	assert.deepEqual(Object.keys(clean.values).sort(), ["ocrLang", "ttsEngine"].sort());
	assert.equal(dropped.length, 5);
	assert.ok(!JSON.stringify(clean.values).includes("REAL_SECRET"));
	const { loss } = demoMaskingIsWrong();
	assert.ok(loss, "反例应当演示出数据丢失");
	console.log(`ok P6 净化：剔除 ${dropped.length} 个本机专属 key，同步体里不含任何凭据`);
}

// ------------------------------------------------------------------ P7

{
	const B = dev("B");
	const remote = state({ ocrLang: "jpn", theme: "light" }, { ocrLang: B(), theme: B() });
	// 新设备：本地空、没有基线
	const r = mergeSettings(undefined, emptyState(), remote);
	assert.equal(r.state.values.ocrLang, "jpn");
	assert.equal(r.conflicts.length, 0, "首装应静默接受云端，而不是报冲突");
	// 反向：本地有值、云端空（云端被误清空）时也不能拿空覆盖本地
	const r2 = mergeSettings(undefined, state({ ocrLang: "chi_sim+eng" }), emptyState());
	assert.equal(r2.state.values.ocrLang, "chi_sim+eng");
	console.log("ok P7 首装：无基线时不丢数据、不报冲突");
}

// ------------------------------------------------- 两轮收敛：冲突后能对齐

{
	const A = dev("A");
	const B = dev("B");
	let a = state({ agentMaxTurns: "8" });
	let b = state({ agentMaxTurns: "8" });
	// 两台机器同时把 agentMaxTurns 改成不同值
	a = state({ agentMaxTurns: "16" }, { agentMaxTurns: A() });
	b = state({ agentMaxTurns: "24" }, { agentMaxTurns: B() });
	const base = state({ agentMaxTurns: "8" });

	// 第一轮：双方各自合并（拿到同一个胜出者）
	const onA = mergeSettings(base, a, b);
	const onB = mergeSettings(base, b, a);
	assert.equal(onA.state.values.agentMaxTurns, onB.state.values.agentMaxTurns);
	// 第二轮：把结果作为新的本地 + 对方为本轮远端，应当不再报冲突
	const round2 = mergeSettings(base, onA.state, onB.state);
	assert.equal(round2.conflicts.length, 0, "第二轮不应再报同一冲突");
	assert.equal(canonState(round2.state), canonState(onA.state));
	console.log("ok 收敛：冲突裁决后第二轮不再重复报冲突");
}

// ------------------------------------------------- 文件型配置：整文件裁决

{
	const base: FileMap = {
		"custom-providers.json": { text: '{"a":1}', at: 10, dev: "A" },
		"model-overrides.json": { text: "{}", at: 5, dev: "A" },
	};
	// 只有本机改了 custom-providers，另一台改了 model-overrides
	const local: FileMap = {
		"custom-providers.json": { text: '{"a":2}', at: 20, dev: "A" },
		"model-overrides.json": { text: "{}", at: 5, dev: "A" },
	};
	const remote: FileMap = {
		"custom-providers.json": { text: '{"a":1}', at: 10, dev: "A" },
		"model-overrides.json": { text: '{"deepseek":{}}', at: 30, dev: "B" },
	};
	const r = mergeFileMap(base, local, remote);
	assert.equal(r.files["custom-providers.json"].text, '{"a":2}', "本机单侧变更应落地");
	assert.equal(r.files["model-overrides.json"].text, '{"deepseek":{}}', "远端单侧变更应落地");
	assert.equal(r.conflicts.length, 0);
	// 两侧都改同一文件 → 报冲突、取更晚的一份
	const r2 = mergeFileMap(base, local, {
		"custom-providers.json": { text: '{"a":3}', at: 40, dev: "B" },
		"model-overrides.json": { text: '{"deepseek":{}}', at: 30, dev: "B" },
	});
	assert.equal(r2.files["custom-providers.json"].text, '{"a":3}');
	assert.equal(r2.conflicts.length, 1);
	console.log("ok P8 文件型配置：单侧变更自动落地，双侧变更取更晚一份并报冲突");
}

console.log("summary: 设置同步的净化 + key 级三方合并原型全部通过");
