import assert from "node:assert/strict";
import test from "node:test";
import { createClock } from "./clock.ts";
import { createSettingsPort, type StampRecord } from "./settings-port.ts";

/** 内存版的端口依赖：把 settings.json 与戳记录都放在 Map 里。 */
function harness(initial: Record<string, string> = {}, stamps: StampRecord = {}) {
	let values = { ...initial };
	let record = { ...stamps };
	let writes = 0;
	const clock = createClock({ deviceId: "A", now: () => 1_000 });
	const port = createSettingsPort({
		clock,
		readValues: () => ({ ...values }),
		writeValues: (next) => {
			values = { ...next };
			writes += 1;
		},
		readStamps: () => ({ ...record }),
		writeStamps: (next) => {
			record = { ...next };
		},
	});
	return {
		port,
		setValue: (key: string, value: string) => {
			values = { ...values, [key]: value };
		},
		deleteValue: (key: string) => {
			const next = { ...values };
			delete next[key];
			values = next;
		},
		values: () => ({ ...values }),
		stamps: () => ({ ...record }),
		writes: () => writes,
	};
}

test("the first read issues a stamp for every key", () => {
	const h = harness({ ocrLang: "chi_sim+eng", ttsRate: "1" });
	const { values, stamps } = h.port.read();
	assert.deepEqual(values, { ocrLang: "chi_sim+eng", ttsRate: "1" });
	assert.ok(stamps.ocrLang && stamps.ttsRate);
	assert.equal(stamps.ocrLang.dev, "A");
	assert.notEqual(stamps.ocrLang.at, stamps.ttsRate.at, "同一设备内的戳必须严格递增");
});

test("reading again does not shuffle stamps when nothing changed", () => {
	const h = harness({ ocrLang: "chi_sim+eng" });
	const first = h.port.read().stamps.ocrLang;
	const second = h.port.read().stamps.ocrLang;
	assert.deepEqual(second, first, "值没变就不能刷新戳，否则三方合并会失效");
});

test("changing a value issues a new stamp only for that key", () => {
	const h = harness({ ocrLang: "chi_sim+eng", ttsRate: "1" });
	const first = h.port.read().stamps;
	// 模拟用户在设置页只改了 OCR 语言
	h.setValue("ocrLang", "jpn");
	const second = h.port.read().stamps;
	assert.notDeepEqual(second.ocrLang, first.ocrLang, "改过的 key 必须换新戳");
	assert.deepEqual(second.ttsRate, first.ttsRate, "没改的 key 不能换戳");
});

test("a stamp records the value it was issued for, so a revert issues a fresh stamp", () => {
	const h = harness({ theme: "dark" });
	const first = h.port.read().stamps.theme;
	h.port.write({ theme: "light" }, { theme: first });
	const afterWrite = h.port.read().stamps.theme;
	assert.equal(h.values().theme, "light");
	assert.deepEqual(afterWrite, first, "写回时沿用了合并给出的戳");

	// 用户又改回 dark：值变了，必须换一个新戳，否则另一台机器会以为它比自己的新
	const again = harness({ theme: "dark" }, { theme: { at: 1, dev: "A", v: "light" } });
	const reissued = again.port.read().stamps.theme;
	assert.notEqual(reissued.at, 1);
});

test("deleted keys drop their stamps", () => {
	const h = harness({ ocrLang: "chi_sim+eng" });
	h.port.read();
	h.deleteValue("ocrLang");
	h.port.read();
	assert.deepEqual(h.stamps(), {});
});

test("write persists values and keeps the merged stamps", () => {
	const h = harness({ ocrLang: "chi_sim+eng", apiKey: "sk-local" });
	h.port.write({ ocrLang: "jpn", apiKey: "sk-local" }, { ocrLang: { at: 42, dev: "B" } });
	assert.deepEqual(h.values(), { ocrLang: "jpn", apiKey: "sk-local" });
	assert.equal(h.stamps().ocrLang.at, 42);
	assert.equal(h.stamps().ocrLang.dev, "B");
	assert.equal(h.stamps().apiKey.v, "sk-local", "本机专属 key 也要留住戳，供下次读回沿用");
	assert.equal(h.writes(), 1);
});
