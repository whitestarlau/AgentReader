import assert from "node:assert/strict";
import test from "node:test";
import { secMsGec } from "./edge-token.ts";

const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

test("token has the checksum-sha256 shape", () => {
	const value = secMsGec(TOKEN, 0, 1_760_000_000_000);
	assert.match(value, /^[0-9A-F]{16}-[0-9A-F]{64}$/);
});

test("token is stable inside a five-minute window and changes across one", () => {
	const base = 1_760_000_000_000;
	assert.equal(secMsGec(TOKEN, 0, base), secMsGec(TOKEN, 0, base + 60_000));
	assert.notEqual(secMsGec(TOKEN, 0, base), secMsGec(TOKEN, 0, base + 300_000));
});

test("clock offset shifts the window", () => {
	const base = 1_760_000_000_000;
	assert.equal(secMsGec(TOKEN, 600_000, base), secMsGec(TOKEN, 0, base + 600_000));
});

test("different trusted tokens produce different values", () => {
	assert.notEqual(
		secMsGec(TOKEN, 0, 1_760_000_000_000),
		secMsGec("another-token", 0, 1_760_000_000_000),
	);
});
