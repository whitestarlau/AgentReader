import assert from "node:assert/strict";
import test from "node:test";
import { findEpubCoverHref } from "./epub-cover.ts";

test("EPUB3: properties=cover-image wins", () => {
	const opf = `<package><manifest>
    <item id="img1" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
    <item id="img2" href="images/other.jpg" media-type="image/jpeg"/>
  </manifest></package>`;
	assert.equal(findEpubCoverHref(opf), "images/cover.jpg");
});

test("EPUB2: meta[name=cover] points at the manifest id", () => {
	const opf = `<package><metadata><meta name="cover" content="cover-img"/></metadata>
    <manifest><item id="cover-img" href="Text/cover.png" media-type="image/png"/></manifest></package>`;
	assert.equal(findEpubCoverHref(opf), "Text/cover.png");
});

test("attribute order does not matter", () => {
	const opf = `<manifest><item href="c.jpg" id="cid" properties="cover-image" media-type="image/jpeg"/></manifest>`;
	assert.equal(findEpubCoverHref(opf), "c.jpg");
});

test("falls back to any image whose name mentions cover", () => {
	const opf = `<manifest>
    <item id="a" href="images/cover-front.jpeg" media-type="image/jpeg"/>
    <item id="b" href="images/spot.png" media-type="image/png"/>
  </manifest>`;
	assert.equal(findEpubCoverHref(opf), "images/cover-front.jpeg");
});

test("no cover found returns undefined instead of guessing", () => {
	const opf = `<manifest>
    <item id="a" href="images/spot.png" media-type="image/png"/>
    <item id="b" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>`;
	assert.equal(findEpubCoverHref(opf), undefined);
	assert.equal(findEpubCoverHref(""), undefined);
});

test("a dangling meta[name=cover] does not shadow the fallback", () => {
	const opf = `<metadata><meta name="cover" content="missing-id"/></metadata>
    <manifest><item id="x" href="pics/the-cover.jpg" media-type="image/jpeg"/></manifest>`;
	assert.equal(findEpubCoverHref(opf), "pics/the-cover.jpg");
});
