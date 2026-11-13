import { createHash } from "node:crypto";

/**
 * `Sec-MS-GEC` v2, the token Microsoft's Edge "read aloud" endpoint requires.
 *
 * The scheme is not documented: it is the CS64 checksum of the Edge copyright
 * line plus the epoch input, followed by the SHA-256 of the same bytes. Ported
 * from the analysis in rany2/edge-tts#492 (MIT); the arithmetic is kept
 * word-for-word so it can be diffed against the reference implementation.
 *
 * Everything is date-quantised to five minutes, so a correct clock is required —
 * callers retry once with a server-provided offset on HTTP 403.
 */

const EDGE_COPYRIGHT = "Copyright (C) Microsoft Corporation. All rights reserved.";

const SWAP_FIRST = { swappedWord: 0xef0569fb, swappedSum: 0x76f50f34, swappedProduct: 0xc3efea97 };
const SWAP_SECOND = { swappedWord: 0xc31713db, swappedSum: 0x1881ce3c, swappedProduct: 0x35bd1ec9 };
const MIX_FIRST = [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83];
const MIX_SECOND = [0xa27416f5, 0xd38396ff, 0x7c932b89, 0xbfa49f69];

type Multipliers = { swappedWord: number; swappedSum: number; swappedProduct: number };

function swapHalves(value: number): number {
	return ((value << 16) | (value >>> 16)) >>> 0;
}

function swapTerm(word: number, key: number, multipliers: Multipliers): number {
	const sum = Math.imul(word, key) + Math.imul(swapHalves(word), multipliers.swappedWord);
	const product = Math.imul(swapHalves(sum), multipliers.swappedSum) >>> 0;
	return (Math.imul(swapHalves(product), multipliers.swappedProduct) + product) >>> 0;
}

function swapAndMultiply(value: number, multipliers: readonly number[]): number {
	let out = value;
	for (const multiplier of multipliers) out = Math.imul(swapHalves(out), multiplier) >>> 0;
	return out;
}

export function cs64(message: Uint8Array, digest: Uint8Array): Uint8Array {
	const digestView = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
	const firstKey = (digestView.getUint32(0, true) | 1) >>> 0;
	const secondKey = (digestView.getUint32(4, true) | 1) >>> 0;

	const padded = new Uint8Array(Math.ceil(message.length / 8) * 8);
	padded.set(message);
	const words = new DataView(padded.buffer);

	let swapSum = 0;
	let lastSwap = 0;
	let mix = 0;
	let mixSum = 0;
	for (let offset = 0; offset < padded.length; offset += 8) {
		const firstWord = words.getUint32(offset, true);
		const secondWord = words.getUint32(offset + 4, true);
		const firstSwap = swapTerm(firstWord, firstKey, SWAP_FIRST);
		lastSwap = swapTerm(secondWord, secondKey, SWAP_SECOND);
		swapSum = (swapSum + firstSwap + lastSwap) >>> 0;
		mix = swapAndMultiply(Math.imul(mix + firstWord, firstKey), MIX_FIRST);
		mixSum = (mixSum + mix) >>> 0;
		mix = swapAndMultiply(Math.imul(mix + secondWord, secondKey), MIX_SECOND);
		mixSum = (mixSum + mix) >>> 0;
	}

	const checksum = new Uint8Array(8);
	const view = new DataView(checksum.buffer);
	view.setUint32(0, lastSwap ^ mix, true);
	view.setUint32(4, swapSum ^ mixSum, true);
	return checksum;
}

function toUpperHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase();
}

/** `<checksum>-<sha256>`, both upper-case hex. */
export function hashSecMsGecV2(input: string): string {
	const message = Buffer.from(EDGE_COPYRIGHT + input, "utf8");
	const digest = createHash("sha256").update(message).digest();
	return `${toUpperHex(cs64(message, digest))}-${toUpperHex(digest)}`;
}

const WIN_EPOCH_SECONDS = 11644473600n;

/**
 * Token for "now": Windows file time in 100 ns units, floored to five minutes.
 * BigInt keeps the 17-digit value exact (a float would round it).
 */
export function secMsGec(trustedToken: string, clockOffsetMs = 0, now = Date.now()): string {
	let ticks = BigInt(Math.floor((now + clockOffsetMs) / 1000)) + WIN_EPOCH_SECONDS;
	ticks -= ticks % 300n;
	return hashSecMsGecV2(`${ticks * 10_000_000n}${trustedToken}`);
}
