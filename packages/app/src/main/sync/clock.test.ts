import assert from "node:assert/strict";
import test from "node:test";
import { compareStamps, createClock, maxStamp, newDeviceId } from "./clock.ts";

test("stamps strictly increase even within the same millisecond", () => {
	const clock = createClock({ deviceId: "A", now: () => 1_000 });
	let previous = 0;
	for (let i = 0; i < 1_000; i++) {
		const { at } = clock.next();
		assert.ok(at > previous, `第 ${i} 次取值没有递增：${at} <= ${previous}`);
		previous = at;
	}
});

test("a wall-clock rollback cannot make stamps go backwards", () => {
	let now = 10_000;
	const clock = createClock({ deviceId: "A", now: () => now });
	const first = clock.next();
	now = 5_000; // 用户改了系统时间，或 NTP 回拨
	const second = clock.next();
	assert.ok(second.at > first.at);
});

test("a restart continues above the persisted value", () => {
	const persisted = createClock({ deviceId: "A", now: () => 7_000 }).next().at;
	// 重启后系统时间反而更小（时区/时钟问题），也必须继续递增
	const restarted = createClock({ deviceId: "A", initialAt: persisted, now: () => 1_000 });
	assert.ok(restarted.next().at > persisted);
});

test("compareStamps is a total order on (at, dev)", () => {
	const a = { at: 1, dev: "A" };
	const b = { at: 1, dev: "B" };
	const c = { at: 2, dev: "A" };
	assert.equal(compareStamps(a, b), -1);
	assert.equal(compareStamps(b, a), 1);
	assert.equal(compareStamps(a, a), 0);
	assert.equal(compareStamps(c, b), 1);
	// 交换律的符号对称：同一对戳在两个方向上符号相反
	assert.equal(Math.sign(compareStamps(a, c)), -Math.sign(compareStamps(c, a)));
});

test("maxStamp tolerates missing stamps", () => {
	const a = { at: 5, dev: "A" };
	assert.deepEqual(maxStamp(undefined, a), a);
	assert.deepEqual(maxStamp(a, undefined), a);
	assert.equal(maxStamp(undefined, undefined), undefined);
	assert.deepEqual(maxStamp({ at: 1, dev: "A" }, { at: 2, dev: "A" }), { at: 2, dev: "A" });
});

test("newDeviceId returns distinct ids", () => {
	const ids = new Set(Array.from({ length: 50 }, () => newDeviceId()));
	assert.equal(ids.size, 50);
});
