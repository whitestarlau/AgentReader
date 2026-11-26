import assert from "node:assert/strict";
import test from "node:test";
import {
	buildInfinicloudUserRequest,
	classifyFailure,
	normalizeEndpoint,
	parseInfinicloudUser,
	reduceWizard,
	syncRootUrl,
	type WizardState,
} from "./connect.ts";
import { getWebdavPreset } from "./presets.ts";

test("endpoints are normalized without changing case", () => {
	assert.deepEqual(normalizeEndpoint("https://dav.jianguoyun.com/dav"), {
		ok: true,
		url: "https://dav.jianguoyun.com/dav/",
	});
	// Koofr 的 /dav/Koofr 大小写敏感，归一化不能「顺手小写化」
	assert.deepEqual(normalizeEndpoint("https://app.koofr.net/dav/Koofr"), {
		ok: true,
		url: "https://app.koofr.net/dav/Koofr/",
	});
	assert.deepEqual(normalizeEndpoint("  https://x.example.com  "), {
		ok: true,
		url: "https://x.example.com/",
	});
});

test("endpoints that would leak or break auth are rejected", () => {
	assert.equal(normalizeEndpoint("http://x.example.com/dav").ok, false);
	assert.equal(normalizeEndpoint("https://user:pass@x.example.com/dav").ok, false);
	assert.equal(normalizeEndpoint("https://x.example.com/dav?token=1").ok, false);
	assert.equal(normalizeEndpoint("").ok, false);
	assert.equal(normalizeEndpoint("x.example.com/dav").ok, false);
});

test("the sync root is endpoint + app folder", () => {
	assert.equal(
		syncRootUrl("https://dav.jianguoyun.com/dav/", "AgentReader"),
		"https://dav.jianguoyun.com/dav/AgentReader/",
	);
	assert.equal(
		syncRootUrl("https://x.example.com/dav/", "/my folder/"),
		"https://x.example.com/dav/my%20folder/",
	);
});

test("InfiniCLOUD probe request carries basic auth and the app api key", () => {
	const preset = getWebdavPreset("infinicloud");
	assert.ok(preset);
	const request = buildInfinicloudUserRequest(preset, "alice", "apps-pass");
	assert.ok(request);
	assert.ok(request.headers.Authorization.startsWith("Basic "));
	assert.equal(
		Buffer.from(request.headers.Authorization.slice(6), "base64").toString("utf-8"),
		"alice:apps-pass",
	);
	assert.ok("X-InfiniCLOUD-API-KEY" in request.headers);
});

test("InfiniCLOUD probe responses: result must be 0 and the url must be usable", () => {
	const ok = parseInfinicloudUser({
		result: 0,
		node: "ise.teracloud.jp",
		webdav_url: "https://ise.teracloud.jp/dav",
	});
	assert.equal(ok.ok, true);
	assert.equal(ok.ok && ok.webdavUrl, "https://ise.teracloud.jp/dav/");
	assert.equal(ok.ok && ok.node, "ise.teracloud.jp");

	// HTTP 200 但业务失败：必须看 body
	assert.equal(parseInfinicloudUser({ result: 1 }).ok, false);
	assert.equal(parseInfinicloudUser({ result: 0 }).ok, false);
	assert.equal(parseInfinicloudUser(null).ok, false);
});

test("401 always names the app-password requirement", () => {
	const failure = classifyFailure(401, { preset: getWebdavPreset("jianguoyun") });
	assert.equal(failure.code, "unauthorized");
	assert.ok(failure.detail.includes("应用密码"));
	assert.equal(failure.retryable, false);
	assert.equal(failure.action, "open-help");
});

test("the same 429 is rate limiting on 坚果云 but an account lockout on Koofr", () => {
	const jianguoyun = classifyFailure(429, { preset: getWebdavPreset("jianguoyun") });
	assert.equal(jianguoyun.code, "rate-limited");
	assert.equal(jianguoyun.retryable, true);

	const koofr = classifyFailure(429, { preset: getWebdavPreset("koofr") });
	assert.equal(koofr.code, "locked-out");
	assert.equal(koofr.retryable, false, "账号锁定期间重试只会延长锁定");
	assert.ok(koofr.detail.includes("1 小时"));
});

test("412 is a retryable conflict, TLS asks for a trusted certificate", () => {
	const conflict = classifyFailure(412);
	assert.equal(conflict.code, "conflict");
	assert.equal(conflict.retryable, true);
	const tls = classifyFailure("tls");
	assert.equal(tls.action, "trust-cert");
	assert.equal(tls.retryable, false);
	assert.equal(classifyFailure(418).code, "server");
});

test("the wizard cannot skip steps and keeps the failure reason on the credentials step", () => {
	let state: WizardState = { step: "pick-provider" };
	state = reduceWizard(state, { type: "submit" });
	assert.equal(state.step, "pick-provider", "没选服务不能提交");

	state = reduceWizard(state, { type: "pick", presetId: "jianguoyun" });
	state = reduceWizard(state, { type: "submit" });
	assert.equal(state.step, "verify");

	state = reduceWizard(state, { type: "failed", failure: classifyFailure(401) });
	assert.equal(state.step, "credentials");
	assert.equal(state.failure?.code, "unauthorized", "失败原因要带回表单，用于就地提示");

	state = reduceWizard(state, { type: "submit" });
	state = reduceWizard(state, { type: "verified" });
	assert.equal(state.step, "scope");
	assert.equal(reduceWizard(state, { type: "back" }).step, "credentials");
	state = reduceWizard(state, { type: "confirm-scope" });
	state = reduceWizard(state, { type: "synced" });
	assert.equal(state.step, "done");
});
