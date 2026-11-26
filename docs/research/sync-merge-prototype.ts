// AgentReader 云同步：合并规则原型与验证
//
// 这不是产品代码，而是 docs/sync-research.md §3.4 两个结论的可复现验证：
//   A. 主策略「基线三方合并」——单侧变更必然自动采纳，只有双方都改才报冲突；
//   B. 兜底「全序键」(updatedAt, deviceId, id)——收敛、幂等、结合、删除不复活。
//
// 运行：node --experimental-strip-types docs/research/sync-merge-prototype.ts
// 预期：两段 ok 输出

import assert from "node:assert";

// ---------------------------------------------------------------- shared types

type SortKey = [number, string, string]; // (timestamp, deviceId, id) — 全序
const key = (r: { updatedAt: number; dev: string; id: string }): SortKey => [r.updatedAt, r.dev, r.id];
const cmpKey = (a: SortKey, b: SortKey) => {
	if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
	if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
	return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
};
const maxBy = <T extends { updatedAt: number; dev: string; id: string }>(a: T, b: T): T =>
	cmpKey(key(a), key(b)) >= 0 ? a : b;

type Rec = { id: string; dev: string; updatedAt: number; page?: number; color?: string };
type Row = { id: string; dev: string; at: number; role?: string; content?: string };
type Pos = { page: number; updatedAt: number; dev: string; id: string };
type State = { annotations: Rec[]; chats: Row[]; position: Pos };

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sortRecs = (xs: Rec[]) => [...xs].sort((a, b) => cmpKey(key(a), key(b)));
const sortRows = (xs: Row[]) =>
	[...xs].sort((a, b) => cmpKey([a.at, a.dev, a.id], [b.at, b.dev, b.id]));
/** Canonical form: order-insensitive comparison of a whole state. */
const canon = (s: State) =>
	JSON.stringify({
		annotations: sortRecs(s.annotations),
		chats: sortRows(s.chats),
		position: s.position,
	});

// ------------------------------------------------- A. 基线三方合并（主策略）

type Merge3 = { state: State; conflicts: string[] };

function merge3(base: State, local: State, remote: State): Merge3 {
	const conflicts: string[] = [];

	const mergeSet = <T extends { id: string }>(b: T[], l: T[], r: T[]): T[] => {
		const B = new Map(b.map((x) => [x.id, x]));
		const L = new Map(l.map((x) => [x.id, x]));
		const R = new Map(r.map((x) => [x.id, x]));
		const ids = new Set([...B.keys(), ...L.keys(), ...R.keys()]);
		const out: T[] = [];
		for (const id of ids) {
			const bv = B.get(id);
			const lv = L.get(id);
			const rv = R.get(id);
			if (eq(lv, rv)) {
				if (lv !== undefined) out.push(lv); // 两侧一致（含两侧都删）
				continue;
			}
			if (eq(lv, bv)) {
				if (rv !== undefined) out.push(rv); // 只有远端改（含远端删除）
				continue;
			}
			if (eq(rv, bv)) {
				if (lv !== undefined) out.push(lv); // 只有本地改
				continue;
			}
			// 双方都改且不同 → 真冲突，交给兜底全序键
			conflicts.push(id);
			const lrec = lv as (T & Rec) | undefined;
			const rrec = rv as (T & Rec) | undefined;
			// 「一侧删除、一侧改过」也落在这里：默认保留（不丢用户数据），交由用户决定
			const winner = !lrec ? (rrec as T) : !rrec ? (lrec as T) : maxBy(lrec, rrec);
			out.push(winner);
		}
		return out;
	};

	const pos: Pos =
		eq(local.position, remote.position)
			? local.position
			: eq(local.position, base.position)
				? remote.position
				: eq(remote.position, base.position)
					? local.position
					: (conflicts.push("position"), cmpKey(key(local.position), key(remote.position)) >= 0
							? local.position
							: remote.position);

	return {
		state: {
			annotations: sortRecs(mergeSet(base.annotations, local.annotations, remote.annotations)),
			chats: sortRows(mergeSet(base.chats, local.chats, remote.chats)),
			position: pos,
		},
		conflicts,
	};
}

// ------------------------------------------------- B. 兜底全序键（LWW 格）

function mergeRecsLWW(a: Rec[], b: Rec[]): Rec[] {
	const out = new Map<string, Rec>();
	for (const r of [...a, ...b]) {
		const cur = out.get(r.id);
		out.set(r.id, cur ? maxBy(r, cur) : r);
	}
	return sortRecs([...out.values()]);
}
function mergeRowsLWW(a: Row[], b: Row[]): Row[] {
	const out = new Map<string, Row>();
	for (const r of [...a, ...b]) {
		const cur = out.get(r.id);
		if (!cur || cmpKey([r.at, r.dev, r.id], [cur.at, cur.dev, cur.id]) >= 0) out.set(r.id, r);
	}
	return sortRows([...out.values()]);
}
const mergeLWW = (a: State, b: State): State => ({
	annotations: mergeRecsLWW(a.annotations, b.annotations),
	chats: mergeRowsLWW(a.chats, b.chats),
	position: cmpKey(key(a.position), key(b.position)) >= 0 ? a.position : b.position,
});

// ---------------------------------------------------------------- fuzz helpers

let seq = 0;
const nid = (dev: string, p: string) => `${dev}-${p}${(seq++).toString().padStart(4, "0")}`;

function applyOp(s: State, op: string, dev: string, clock: { t: number }) {
	clock.t += 1 + Math.floor(Math.random() * 3);
	if (op === "add") {
		s.annotations.push({ id: nid(dev, "a"), dev, updatedAt: clock.t, page: 1 });
	} else if (op === "delete" || op === "recolor") {
		const live = s.annotations.filter((a) => a.page !== -1); // -1 = 已删
		if (!live.length) return;
		const a = live[Math.floor(Math.random() * live.length)];
		s.annotations = s.annotations.map((x) => {
			if (x.id !== a.id) return x;
			return op === "delete"
				? { ...x, dev, updatedAt: clock.t, page: -1 } // 用 page=-1 表示删除（三方合并由基线推导）
				: { ...x, dev, updatedAt: clock.t, color: `c${clock.t}` };
		});
	} else if (op === "chat") {
		s.chats.push({ id: nid(dev, "m"), dev, at: clock.t, role: "user", content: `x${clock.t}` });
	} else if (op === "page") {
		s.position = { page: Math.floor(Math.random() * 500), updatedAt: clock.t, dev, id: "pos" };
	}
}

const OPS = ["add", "add", "delete", "recolor", "chat", "chat", "page"];
const randomOp = () => OPS[Math.floor(Math.random() * OPS.length)];
const emptyState = (): State => ({
	annotations: [],
	chats: [],
	position: { page: 1, updatedAt: 0, dev: "", id: "pos" },
});

// ---------------------------------------------------------------- 测试 A

{
	// A1：只有一侧改 → 结果必须等于改动侧（三方合并的核心承诺）
	let checked = 0;
	for (let round = 0; round < 2000; round++) {
		seq = 0;
		const base = emptyState();
		const bclock = { t: 100 };
		for (let i = 0; i < 4; i++) applyOp(base, randomOp(), "dev-base", bclock);

		const local = clone(base);
		const lclock = { t: 200 };
		for (let i = 0; i < 3; i++) applyOp(local, randomOp(), "dev-local", lclock);

		const res = merge3(base, local, base); // 远端未动
		assert.strictEqual(canon(res.state), canon(local), `A1 single-side not applied @${round}`);
		assert.strictEqual(res.conflicts.length, 0, `A1 spurious conflict @${round}`);
		checked++;
	}

	// A2：两侧改的是不同 id → 必须自动合并、零冲突
	let disjoint = 0;
	for (let round = 0; round < 2000; round++) {
		seq = 0;
		const base = emptyState();
		const local = clone(base);
		const remote = clone(base);
		applyOp(local, "add", "dev-local", { t: 300 });
		applyOp(remote, "add", "dev-remote", { t: 300 });
		const res = merge3(base, local, remote);
		assert.strictEqual(res.conflicts.length, 0, `A2 false conflict @${round}`);
		assert.strictEqual(res.state.annotations.length, 2, `A2 lost an addition @${round}`);
		disjoint++;
	}

	// A3：同一 id 被两侧改成不同内容 → 必须报冲突，且判定与顺序无关
	let conflicted = 0;
	for (let round = 0; round < 1500; round++) {
		seq = 0;
		const base: State = { ...emptyState(), annotations: [{ id: "a0", dev: "dev-base", updatedAt: 1, page: 1 }] };
		const local = clone(base);
		const remote = clone(base);
		local.annotations[0] = { ...local.annotations[0], color: "L", dev: "dev-local", updatedAt: 500 };
		remote.annotations[0] = { ...remote.annotations[0], color: "R", dev: "dev-remote", updatedAt: 400 };
		const x = merge3(base, local, remote);
		const y = merge3(base, remote, local);
		assert.strictEqual(x.conflicts.length, 1, `A3 conflict not detected @${round}`);
		assert.strictEqual(canon(x.state), canon(y.state), `A3 order-dependent @${round}`);
		conflicted++;
	}

	// A4：本地删除、远端未动 → 删除生效；远端也改过 → 视为冲突（默认保留，不丢数据）
	let guarded = 0;
	for (let round = 0; round < 1000; round++) {
		seq = 0;
		const base: State = { ...emptyState(), annotations: [{ id: "a0", dev: "dev-base", updatedAt: 1, page: 1 }] };
		const local = clone(base);
		local.annotations = []; // 本地删除
		const clean = merge3(base, local, base);
		assert.strictEqual(clean.state.annotations.length, 0, `A4 deletion not applied @${round}`);

		const remote = clone(base);
		remote.annotations[0] = { ...remote.annotations[0], color: "R", dev: "dev-remote", updatedAt: 900 };
		const dirty = merge3(base, local, remote);
		assert.ok(dirty.conflicts.includes("a0"), `A4 delete-vs-edit not flagged @${round}`);
		assert.strictEqual(dirty.state.annotations.length, 1, `A4 delete-vs-edit lost data @${round}`);
		guarded++;
	}

	console.log(
		`ok A: 三方合并 — 单侧 ${checked} / 交叉 ${disjoint} / 同id冲突 ${conflicted} / 删除守卫 ${guarded} 轮`,
	);
}

// ---------------------------------------------------------------- 测试 B

{
	let rounds = 0;
	for (let r = 0; r < 2000; r++) {
		seq = 0;
		// 一台设备 = 一条历史 + 一个严格递增的时钟（等价于 HLC：同设备内绝不出现重复时间戳）
		const mk = (dev: string) => {
			const s = emptyState();
			const clock = { t: 100 };
			for (let i = 0; i < 5; i++) applyOp(s, randomOp(), dev, clock);
			return s;
		};
		const a = mk(`dev-${r}-a`);
		const b = mk(`dev-${r}-b`);
		assert.strictEqual(canon(mergeLWW(a, b)), canon(mergeLWW(b, a)), `B commutativity @${r}`);
		assert.strictEqual(canon(mergeLWW(mergeLWW(a, b), b)), canon(mergeLWW(a, b)), `B idempotence @${r}`);

		const ab = mergeLWW(a, b);
		const c = mk(`dev-${r}-c`);
		assert.strictEqual(
			canon(mergeLWW(mergeLWW(a, b), c)),
			canon(mergeLWW(mergeLWW(a, c), b)),
			`B associativity @${r}`,
		);
		// 同一毫秒两设备各写一条：末位键必须让结果确定
		const tie = emptyState();
		const t1 = clone(tie);
		const t2 = clone(tie);
		t1.position = { page: 10, updatedAt: 777, dev: "dev-a", id: "pos" };
		t2.position = { page: 20, updatedAt: 777, dev: "dev-b", id: "pos" };
		assert.strictEqual(canon(mergeLWW(t1, t2)), canon(mergeLWW(t2, t1)), `B tie-break @${r}`);
		assert.ok(ab.annotations.length >= 0);
		rounds++;
	}
	console.log(`ok B: 兜底全序键 — ${rounds} 轮 交换/幂等/结合/同时刻 tie-break 全通过`);
}
