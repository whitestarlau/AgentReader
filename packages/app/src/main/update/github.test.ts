import assert from "node:assert/strict";
import test from "node:test";
import { fetchReleaseList, githubHeaders, parseRepo } from "./github.ts";

const repo = { owner: "whitestarlau", repo: "AgentReader" };

test("repo slugs are validated before they reach a URL", () => {
	assert.deepEqual(parseRepo("whitestarlau/AgentReader"), repo);
	assert.equal(parseRepo("whitestarlau/AgentReader/extra"), null);
	assert.equal(parseRepo("https://github.com/whitestarlau/AgentReader"), null);
	assert.equal(parseRepo("../etc/passwd"), null);
});

test("requests carry the API version and a versioned user agent", () => {
	const headers = githubHeaders("0.3.0", "tok");
	assert.equal(headers.Accept, "application/vnd.github+json");
	assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
	assert.equal(headers["User-Agent"], "AgentReader/0.3.0");
	assert.equal(headers.Authorization, "Bearer tok");
});

test("release list is parsed and drafts survive as data", async () => {
	let requested = "";
	const releases = await fetchReleaseList({
		repo,
		appVersion: "0.3.0",
		fetchImpl: async (url) => {
			requested = url;
			return new Response(JSON.stringify([{ tag_name: "v0.4.0", draft: true }, null]), {
				status: 200,
			});
		},
	});
	assert.equal(
		requested,
		"https://api.github.com/repos/whitestarlau/AgentReader/releases?per_page=30",
	);
	assert.equal(releases.length, 1);
	assert.equal(releases[0].tag_name, "v0.4.0");
});

test("404 maps to a not-found error instead of a generic failure", async () => {
	await assert.rejects(
		fetchReleaseList({
			repo,
			appVersion: "0.3.0",
			fetchImpl: async () => new Response("Not Found", { status: 404 }),
		}),
		(error: Error & { code?: string }) => error.code === "not-found",
	);
});

test("rate limiting is reported distinctly", async () => {
	await assert.rejects(
		fetchReleaseList({
			repo,
			appVersion: "0.3.0",
			fetchImpl: async () =>
				new Response("API rate limit exceeded", {
					status: 403,
					headers: {
						"x-ratelimit-remaining": "0",
						"x-ratelimit-reset": "1900000000",
					},
				}),
		}),
		(error: Error & { code?: string }) => error.code === "rate-limited",
	);
});

test("a malformed payload is rejected", async () => {
	await assert.rejects(
		fetchReleaseList({
			repo,
			appVersion: "0.3.0",
			fetchImpl: async () => new Response(JSON.stringify({ message: "nope" }), { status: 200 }),
		}),
		(error: Error & { code?: string }) => error.code === "bad-response",
	);
});

test("a cancelled check reports cancellation", async () => {
	const abort = new AbortController();
	abort.abort();
	await assert.rejects(
		fetchReleaseList({
			repo,
			appVersion: "0.3.0",
			signal: abort.signal,
			fetchImpl: async (_url, init) => {
				if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
				return new Response("[]", { status: 200 });
			},
		}),
		(error: Error & { code?: string }) => error.code === "cancelled",
	);
});
