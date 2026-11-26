/**
 * WebDAV 的 `multistatus` 解析。
 *
 * 只要四个属性（长度 / 修改时间 / ETag / 是否集合），所以手写解析而不是引一个 XML 库 ——
 * 报文结构稳定，依赖越少越好。注意三件事：
 * - 标签前缀不固定（`<d:response>` / `<D:response>` / 默认命名空间），正则必须容忍；
 * - 同一个 `response` 里可能有多个 `propstat`（部分属性 404），只取 200 的那个；
 * - `href` 可能是绝对 URL、绝对路径或百分号编码，统一用 `new URL(href, base)` 归一。
 */

export type DavEntry = {
	/** 原始 href（用于排查） */
	href: string;
	/** 相对同步根的 POSIX 路径，不带前导 `/`；根自身为空串 */
	path: string;
	size: number;
	mtime?: number;
	etag?: string;
	isDir: boolean;
};

const RESPONSE_RE = /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi;

function tagInner(block: string, name: string): string | undefined {
	const paired = new RegExp(
		`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}>`,
		"i",
	);
	const match = paired.exec(block);
	if (match) return match[1];
	// 自闭合空标签：<d:getcontentlength/>
	const selfClosing = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*\\/>`, "i");
	return selfClosing.test(block) ? "" : undefined;
}

function unescapeXml(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&amp;/g, "&");
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** 取 200 的 propstat；没有 200 时退回第一个（有些服务对已删除项返回 404 属性块）。 */
function pickPropstat(block: string): string {
	const blocks = [
		...block.matchAll(/<(?:[\w.-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?propstat>/gi),
	];
	if (blocks.length === 0) return block;
	for (const entry of blocks) {
		const status = tagInner(entry[1], "status") ?? "";
		if (/200/.test(status)) return entry[1];
	}
	return blocks[0][1];
}

export function parseMultiStatus(xml: string, opts: { baseUrl: string }): DavEntry[] {
	const base = opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`;
	const basePath = safeDecode(new URL(base).pathname);
	const entries: DavEntry[] = [];

	for (const match of xml.matchAll(RESPONSE_RE)) {
		const block = match[1];
		const hrefRaw = tagInner(block, "href");
		if (hrefRaw === undefined) continue;
		const href = unescapeXml(hrefRaw).trim();
		if (!href) continue;

		let resolved: URL;
		try {
			resolved = new URL(href, base);
		} catch {
			continue;
		}
		const decodedPath = safeDecode(resolved.pathname);
		let relative = decodedPath;
		if (decodedPath.startsWith(basePath)) relative = decodedPath.slice(basePath.length);
		// 目录 href 常带尾斜杠；统一去掉，与后端接口「path 不带前导/尾随斜杠」的约定一致
		relative = relative.replace(/^\/+/, "").replace(/\/+$/, "");

		const propstat = pickPropstat(block);
		const sizeText = tagInner(propstat, "getcontentlength");
		const size = sizeText ? Number.parseInt(sizeText, 10) : Number.NaN;
		const mtimeText = tagInner(propstat, "getlastmodified");
		const mtime = mtimeText ? Date.parse(mtimeText) : Number.NaN;
		const etagText = tagInner(propstat, "getetag");
		const resourceType = tagInner(propstat, "resourcetype") ?? "";

		entries.push({
			href,
			path: relative,
			size: Number.isFinite(size) ? size : 0,
			mtime: Number.isFinite(mtime) ? mtime : undefined,
			etag: etagText ? unescapeXml(etagText).trim() : undefined,
			isDir: /collection/i.test(resourceType),
		});
	}

	return entries;
}
