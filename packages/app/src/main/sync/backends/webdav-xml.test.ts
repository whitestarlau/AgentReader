import assert from "node:assert/strict";
import test from "node:test";
import { parseMultiStatus } from "./webdav-xml.ts";

const BASE = "https://dav.example.com/dav/AgentReader/";

test("parses a namespaced multistatus with sizes, mtimes, etags and collections", () => {
	const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/AgentReader/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/AgentReader/state/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/AgentReader/state/abc.json</d:href>
    <d:propstat>
      <d:prop>
        <d:getcontentlength>42</d:getcontentlength>
        <d:getlastmodified>Tue, 25 Nov 2026 10:00:00 GMT</d:getlastmodified>
        <d:getetag>"etag-1"</d:getetag>
        <d:resourcetype/>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

	const entries = parseMultiStatus(xml, { baseUrl: BASE });
	assert.equal(entries.length, 3);
	assert.equal(entries[0].path, "");
	assert.equal(entries[0].isDir, true);
	assert.equal(entries[1].path, "state");
	assert.equal(entries[1].isDir, true);
	assert.equal(entries[2].path, "state/abc.json");
	assert.equal(entries[2].size, 42);
	assert.equal(entries[2].etag, '"etag-1"');
	assert.equal(entries[2].isDir, false);
	assert.ok((entries[2].mtime ?? 0) > 0);
});

test("tolerates a default namespace and absolute hrefs on another host", () => {
	const xml = `<multistatus xmlns="DAV:">
  <response>
    <href>https://storage.example.net/dav/AgentReader/settings/state.json</href>
    <propstat><prop><getcontentlength>7</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
</multistatus>`;
	const entries = parseMultiStatus(xml, { baseUrl: BASE });
	assert.equal(entries.length, 1);
	assert.equal(entries[0].path, "settings/state.json");
	assert.equal(entries[0].size, 7);
});

test("percent-encoded Chinese paths are decoded once", () => {
	const xml = `<d:multistatus xmlns:d="DAV:"><d:response>
    <d:href>/dav/AgentReader/books/%E6%B7%B1%E5%85%A5%E7%90%86%E8%A7%A3.pdf</d:href>
    <d:propstat><d:prop><d:getcontentlength>1</d:getcontentlength></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response></d:multistatus>`;
	const entries = parseMultiStatus(xml, { baseUrl: BASE });
	assert.equal(entries[0].path, "books/深入理解.pdf");
});

test("only the 200 propstat is used when a response carries several", () => {
	const xml = `<d:multistatus xmlns:d="DAV:"><d:response>
    <d:href>/dav/AgentReader/state/a.json</d:href>
    <d:propstat><d:prop><d:getcontentlength>999</d:getcontentlength></d:prop>
      <d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
    <d:propstat><d:prop><d:getcontentlength>5</d:getcontentlength></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response></d:multistatus>`;
	const entries = parseMultiStatus(xml, { baseUrl: BASE });
	assert.equal(entries[0].size, 5);
});

test("xml entities in href are unescaped before URL parsing", () => {
	const xml = `<d:multistatus xmlns:d="DAV:"><d:response>
    <d:href>/dav/AgentReader/state/a&amp;b.json</d:href>
    <d:propstat><d:prop><d:getcontentlength>1</d:getcontentlength></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response></d:multistatus>`;
	const entries = parseMultiStatus(xml, { baseUrl: BASE });
	assert.equal(entries[0].path, "state/a&b.json");
});

test("an empty multistatus and a malformed body both yield no entries", () => {
	assert.deepEqual(parseMultiStatus(`<d:multistatus xmlns:d="DAV:"/>`, { baseUrl: BASE }), []);
	assert.deepEqual(parseMultiStatus("not xml at all", { baseUrl: BASE }), []);
});

test("a response without an href is skipped instead of producing an empty path", () => {
	const xml = `<d:multistatus xmlns:d="DAV:"><d:response>
    <d:propstat><d:prop><d:getcontentlength>1</d:getcontentlength></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response></d:multistatus>`;
	assert.deepEqual(parseMultiStatus(xml, { baseUrl: BASE }), []);
});
