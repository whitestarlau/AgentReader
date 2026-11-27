import assert from "node:assert/strict";
import test from "node:test";
import {
	compareVersionStrings,
	formatVersion,
	isNewer,
	normalizeVersion,
	parseVersion,
} from "./version.ts";

test("parses the tag shapes GitHub actually produces", () => {
	assert.deepEqual(parseVersion("v0.3.0"), {
		raw: "v0.3.0",
		major: 0,
		minor: 3,
		patch: 0,
		pre: [],
	});
	assert.deepEqual(parseVersion("0.4.0-beta.1")?.pre, ["beta", 1]);
	assert.deepEqual(parseVersion("V1.2")?.patch, 0);
	// build metadata 不参与优先级，也不进 pre。
	assert.deepEqual(parseVersion("1.2.3+build.9")?.pre, []);
	assert.equal(parseVersion("release-notes"), null);
	assert.equal(parseVersion("v0.3.0.1"), null);
	assert.equal(normalizeVersion("v1.2"), "1.2.0");
	const rc = parseVersion("v1.2.3-rc.2");
	assert.ok(rc);
	assert.equal(formatVersion(rc), "1.2.3-rc.2");
});

test("stable releases outrank their prereleases", () => {
	assert.equal(compareVersionStrings("1.0.0", "1.0.0-beta.1"), 1);
	assert.equal(compareVersionStrings("1.0.0-beta.1", "1.0.0"), -1);
	assert.equal(compareVersionStrings("1.0.0-beta.1", "1.0.0-beta.2"), -1);
	// 数字标识低于字母标识。
	assert.equal(compareVersionStrings("1.0.0-2", "1.0.0-alpha"), -1);
	// 同前缀，标识更多者更高。
	assert.equal(compareVersionStrings("1.0.0-alpha", "1.0.0-alpha.1"), -1);
	assert.equal(compareVersionStrings("0.10.0", "0.9.9"), 1);
});

test("unparseable versions do not fake an update", () => {
	assert.equal(isNewer("nightly", "0.3.0"), false);
	assert.equal(isNewer("v0.3.0", "0.3.0"), false);
	assert.equal(isNewer("v0.3.1", "0.3.0"), true);
	// 开发版的版本号不是 semver 时，正式版应当能提示。
	assert.equal(isNewer("v0.3.1", "dev"), true);
});
