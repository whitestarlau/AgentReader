import assert from "node:assert/strict";
import test from "node:test";
import { checkBackendContract, SyncError } from "../backend.ts";
import { createWebdavBackend, type FetchLike } from "./webdav.ts";

/**
 * 一个内存版的 WebDAV 服务器。
 *
 * 有了它，「WebDAV 后端」的全部语义（条件写、404、MKCOL 逐级、DTO 解析、错误映射）
 * 都能离线验证 —— 不用真账号、不受网络与配额影响，也不会因为服务方抽风而红灯。
 */

const PREFIX = "/dav/AgentReader/";
const AUTH = `Basic ${Buffer.from("me@example.com:app-pass", "utf-8").toString("base64")}`;

type FileNode = { data: Buffer; mtime: number; etag: number };

class FakeDav {
	files = new Map<string, FileNode>();
	dirs = new Set<string>([""]);
	etagSeq = 0;
	status = new Map<string, number>();
	requests: Array<{ method: string; path: string }> = [];

	url(path: string): string {
		return `https://dav.example.com${PREFIX}${path}`;
	}

	fetch: FetchLike = async (input, init) => {
		const url = new URL(String(input));
		const method = (init?.method ?? "GET").toUpperCase();
		const relative = decodeURIComponent(url.pathname.slice(PREFIX.length)).replace(/\/+$/, "");
		this.requests.push({ method, path: relative });

		const headers = new Headers(init?.headers as Record<string, string> | undefined);
		if (headers.get("authorization") !== AUTH) return new Response(null, { status: 401 });

		const forced = this.status.get(`${method} ${relative}`);
		if (forced) return new Response(null, { status: forced });

		switch (method) {
			case "MKCOL": {
				if (this.dirs.has(relative)) return new Response(null, { status: 405 });
				const parent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
				if (!this.dirs.has(parent)) return new Response(null, { status: 409 });
				this.dirs.add(relative);
				return new Response(null, { status: 201 });
			}
			case "PROPFIND": {
				const depth = headers.get("depth") ?? "1";
				if (!this.dirs.has(relative)) return new Response(null, { status: 404 });
				const parts: string[] = [];
				const pushDir = (path: string) => {
					parts.push(`<d:response><d:href>${PREFIX}${path}</d:href><d:propstat><d:prop>
            <d:resourcetype><d:collection/></d:resourcetype>
            <d:quota-available-bytes>1073741824</d:quota-available-bytes>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
				};
				const pushFile = (path: string, node: FileNode) => {
					parts.push(`<d:response><d:href>${PREFIX}${path}</d:href><d:propstat><d:prop>
            <d:getcontentlength>${node.data.length}</d:getcontentlength>
            <d:getlastmodified>${new Date(node.mtime).toUTCString()}</d:getlastmodified>
            <d:getetag>"e${node.etag}"</d:getetag>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
				};
				pushDir(relative);
				if (depth === "1") {
					const childDirs = [...this.dirs].filter(
						(dir) =>
							dir !== relative &&
							dir.startsWith(relative ? `${relative}/` : "") &&
							!dir.slice(relative ? relative.length + 1 : 0).includes("/"),
					);
					for (const dir of childDirs) pushDir(dir);
					for (const [path, node] of this.files) {
						const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
						if (parent === relative) pushFile(path, node);
					}
				}
				return new Response(
					`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${parts.join("")}</d:multistatus>`,
					{ status: 207, headers: { "content-type": "application/xml" } },
				);
			}
			case "GET": {
				const node = this.files.get(relative);
				if (!node) return new Response(null, { status: 404 });
				return new Response(node.data as unknown as BodyInit, {
					status: 200,
					headers: { etag: `"e${node.etag}"` },
				});
			}
			case "PUT": {
				const node = this.files.get(relative);
				const ifMatch = headers.get("if-match");
				const ifNone = headers.get("if-none-match");
				if (ifNone === "*" && node) return new Response(null, { status: 412 });
				if (ifMatch && (!node || ifMatch !== `"e${node.etag}"`)) {
					return new Response(null, { status: 412 });
				}
				this.etagSeq += 1;
				this.files.set(relative, {
					data: Buffer.from(init?.body as Buffer),
					mtime: Date.now(),
					etag: this.etagSeq,
				});
				return new Response(null, {
					status: node ? 204 : 201,
					headers: { etag: `"e${this.etagSeq}"` },
				});
			}
			case "DELETE": {
				if (!this.files.delete(relative)) return new Response(null, { status: 404 });
				return new Response(null, { status: 204 });
			}
			case "MOVE": {
				const node = this.files.get(relative);
				if (!node) return new Response(null, { status: 404 });
				const destination = new URL(headers.get("destination") ?? "");
				const to = decodeURIComponent(destination.pathname.slice(PREFIX.length));
				this.files.delete(relative);
				this.files.set(to, node);
				return new Response(null, { status: 201 });
			}
			default:
				return new Response(null, { status: 405 });
		}
	};
}

function backendFor(dav: FakeDav, presetId = "jianguoyun") {
	return createWebdavBackend({
		config: {
			endpoint: "https://dav.example.com/dav/",
			account: "me@example.com",
			secret: "app-pass",
			rootName: "AgentReader",
		},
		presetId,
		fetchImpl: dav.fetch,
		now: () => Date.now(),
	});
}

test("the webdav backend satisfies the backend contract", async () => {
	const dav = new FakeDav();
	const backend = backendFor(dav);
	assert.deepEqual(await checkBackendContract(backend), []);
});

test("requests carry preemptive basic auth and never wait for a 401 challenge", async () => {
	const dav = new FakeDav();
	const backend = backendFor(dav);
	await backend.put("state/a.json", Buffer.from("x"));
	const put = dav.requests.find((r) => r.method === "PUT");
	assert.ok(put, "应当发出过 PUT");
	assert.equal(dav.requests[0].method, "MKCOL", "写文件前应先逐级建目录");
});

test("paths are percent-encoded per segment, not as a whole string", async () => {
	const dav = new FakeDav();
	const backend = backendFor(dav);
	await backend.put("books/深入理解 计算机.pdf", Buffer.from("pdf"));
	assert.ok(dav.files.has("books/深入理解 计算机.pdf"), "服务端应收到解码后的路径");
});

test("a stale If-Match surfaces as a retryable 412 conflict", async () => {
	const dav = new FakeDav();
	const backend = backendFor(dav);
	const { etag } = await backend.put("state/a.json", Buffer.from("v1"));
	assert.ok(etag);
	await backend.put("state/a.json", Buffer.from("v2"));
	await assert.rejects(
		() => backend.put("state/a.json", Buffer.from("v3"), { ifMatch: etag }),
		(error: unknown) => error instanceof SyncError && error.status === 412 && error.retryable,
	);
});

test("wrong credentials map to a non-retryable unauthorized error", async () => {
	const dav = new FakeDav();
	const backend = createWebdavBackend({
		config: {
			endpoint: "https://dav.example.com/dav/",
			account: "me@example.com",
			secret: "wrong",
			rootName: "AgentReader",
		},
		presetId: "jianguoyun",
		fetchImpl: dav.fetch,
	});
	await assert.rejects(
		() => backend.get("state/a.json"),
		(error: unknown) =>
			error instanceof SyncError && error.code === "unauthorized" && !error.retryable,
	);
});

test("a missing object returns null, a missing directory lists as empty", async () => {
	const dav = new FakeDav();
	const backend = backendFor(dav);
	assert.equal(await backend.get("state/none.json"), null);
	assert.deepEqual(await backend.list("never-created"), []);
});

test("list skips the directory itself and reports children relative to the sync root", async () => {
	const dav = new FakeDav();
	const backend = backendFor(dav);
	await backend.put("state/a.json", Buffer.from("{}"));
	await backend.put("state/b.json", Buffer.from("{}"));
	const entries = await backend.list("state");
	assert.deepEqual(entries.map((e) => e.path).sort(), ["state/a.json", "state/b.json"]);
	assert.equal(
		entries.every((e) => !e.path.startsWith("/")),
		true,
	);
});

test("the same 429 means different things per preset: Koofr locks the account", async () => {
	const dav = new FakeDav();
	dav.status.set("GET state/a.json", 429);

	const jianguoyun = backendFor(dav, "jianguoyun");
	await assert.rejects(
		() => jianguoyun.get("state/a.json"),
		(error: unknown) =>
			error instanceof SyncError && error.code === "rate-limited" && error.retryable,
	);

	const koofr = backendFor({ ...dav, fetch: dav.fetch } as FakeDav, "koofr");
	await assert.rejects(
		() => koofr.get("state/a.json"),
		(error: unknown) =>
			error instanceof SyncError && error.code === "locked-out" && !error.retryable,
	);
});

test("test() reports free space from quota-available-bytes", async () => {
	const dav = new FakeDav();
	const backend = backendFor(dav);
	const result = await backend.test();
	assert.equal(result.ok, true);
	assert.equal(result.ok && result.freeBytes, 1073741824);
});

test("a 507 is reported as a quota problem, not as a generic server error", async () => {
	const dav = new FakeDav();
	dav.status.set("PUT state/a.json", 507);
	const backend = backendFor(dav);
	await assert.rejects(
		() => backend.put("state/a.json", Buffer.from("x")),
		(error: unknown) => error instanceof SyncError && error.code === "quota" && !error.retryable,
	);
});
