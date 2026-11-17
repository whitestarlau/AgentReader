import assert from "node:assert/strict";
import test from "node:test";
import type { TtsSynthesizeReply } from "../shared/tts.ts";
import { ReadAloud, type ReadState } from "./read-aloud.ts";

// Node has Blob but not always the object-URL helpers the player relies on.
const urlApi = URL as unknown as {
	createObjectURL?: (blob: Blob) => string;
	revokeObjectURL?: (url: string) => void;
};
if (!urlApi.createObjectURL) urlApi.createObjectURL = () => "blob:test";
if (!urlApi.revokeObjectURL) urlApi.revokeObjectURL = () => {};

type FakeAudio = HTMLAudioElement & { fireEnded: () => void };

function fakeAudio(): FakeAudio {
	const audio = {
		src: "",
		currentTime: 0,
		preload: "",
		onended: null as null | (() => void),
		onerror: null as null | (() => void),
		async play() {
			return undefined;
		},
		pause() {},
		removeAttribute() {
			audio.src = "";
		},
		load() {},
		fireEnded() {
			audio.onended?.();
		},
	};
	return audio as unknown as FakeAudio;
}

const okReply = (): TtsSynthesizeReply => ({
	ok: true,
	engineId: "fake",
	cached: false,
	format: "mp3",
	sampleRate: 24_000,
	boundaries: [],
	data: new Uint8Array([1, 2, 3]),
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeReader(synth: (text: string) => Promise<TtsSynthesizeReply>) {
	const audio = fakeAudio();
	const states: ReadState[] = [];
	const spoken: (string | null)[] = [];
	let ended = 0;
	const reader = new ReadAloud({
		synthesize: synth,
		onState: (s) => states.push(s),
		onSegment: (seg) => spoken.push(seg?.text ?? null),
		onEnd: () => {
			ended++;
		},
		createAudio: () => audio,
	});
	return { reader, audio, states, spoken, endedCount: () => ended };
}

test("plays sentences in order and reports the end of the text", async () => {
	const { reader, audio, states, endedCount } = makeReader(async () => okReply());
	assert.equal(reader.load("第一句。第二句。"), true);

	reader.play();
	await flush();
	assert.equal(reader.getState().status, "playing");
	assert.equal(reader.getState().index, 0);
	assert.equal(states.at(-1)?.status, "playing");

	audio.fireEnded();
	await flush();
	assert.equal(reader.getState().index, 1);

	audio.fireEnded();
	assert.equal(endedCount(), 1, "the reader asks for the next page when text runs out");
});

test("prefetches the next sentences while the current one plays", async () => {
	const calls: string[] = [];
	const { reader } = makeReader(async (text) => {
		calls.push(text);
		return okReply();
	});
	reader.load("一。二。三。四。");
	reader.play();
	await flush();
	// One spoken + two prefetched.
	assert.deepEqual(calls, ["一。", "二。", "三。"]);
});

test("a synthesis failure becomes an error state instead of silence", async () => {
	const { reader, states } = makeReader(async () => ({
		ok: false,
		kind: "not-configured",
		message: "还没有配置朗读引擎",
	}));
	reader.load("测试。");
	reader.play();
	await flush();
	assert.equal(reader.getState().status, "error");
	assert.equal(reader.getState().error, "还没有配置朗读引擎");
	assert.equal(states.at(-1)?.status, "error");
});

test("pause and resume keep the current sentence", async () => {
	const { reader } = makeReader(async () => okReply());
	reader.load("一。二。");
	reader.play();
	await flush();
	reader.pause();
	assert.equal(reader.getState().status, "paused");
	reader.resume();
	await flush();
	assert.equal(reader.getState().status, "playing");
	assert.equal(reader.getState().index, 0);
});

test("stop clears the highlight and the queue", async () => {
	const { reader, spoken } = makeReader(async () => okReply());
	reader.load("一。二。");
	reader.play();
	await flush();
	reader.stop();
	assert.equal(reader.getState().status, "idle");
	assert.equal(reader.getState().total, 0);
	assert.equal(spoken.at(-1), null, "the highlight is cleared on stop");
});

test("exposes the loaded segments", () => {
	const { reader } = makeReader(async () => okReply());
	reader.load("一。二。三。");
	assert.deepEqual(
		reader.getSegments().map((s) => s.text),
		["一。", "二。", "三。"],
	);
});

test("can start reading from the middle", async () => {
	const { reader } = makeReader(async () => okReply());
	reader.load("一。二。三。", 1);
	reader.play();
	await flush();
	assert.equal(reader.getState().index, 1);

	reader.playFrom(2);
	await flush();
	assert.equal(reader.getState().index, 2);
});

test("playFrom clamps out-of-range indexes", async () => {
	const { reader } = makeReader(async () => okReply());
	reader.load("一。二。");
	reader.playFrom(99);
	await flush();
	assert.equal(reader.getState().index, 1);
});

test("empty text is not readable", () => {
	const { reader } = makeReader(async () => okReply());
	assert.equal(reader.load("   \n  "), false);
});

test("a late ended event after stop does not advance the reader", async () => {
	const { reader, audio, endedCount } = makeReader(async () => okReply());
	reader.load("一。二。");
	reader.play();
	await flush();
	reader.stop();
	audio.fireEnded();
	assert.equal(endedCount(), 0, "stopping must not turn the page behind the user's back");
	assert.equal(reader.getState().status, "idle");
});
