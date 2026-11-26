/**
 * 从 EPUB 的 OPF 里找出封面图。
 *
 * 放在独立模块而不是 `covers.ts` 里，是因为这里没有任何 electron / 原生依赖 ——
 * 于是它能在 `node --experimental-strip-types --test` 下直接测，而封面渲染那部分只能真机验。
 */

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 三种来源按可靠性排序：
 * 1. EPUB3：manifest item 上标了 `properties="cover-image"`；
 * 2. EPUB2：`<meta name="cover" content="封面 item 的 id"/>` 指向的清单项；
 * 3. 兜底：任何图片类型、文件名含 cover 的清单项。
 *
 * 返回的是 OPF 里的原始 href（相对 OPF 所在目录，未解码）。
 */
export function findEpubCoverHref(opfText: string): string | undefined {
	const items = [...opfText.matchAll(/<item\b[^>]*>/gi)].map((match) => match[0]);
	const hrefOf = (tag: string) => tag.match(/\bhref\s*=\s*"([^"]+)"/i)?.[1];

	for (const tag of items) {
		if (!/properties\s*=\s*"[^"]*cover-image/i.test(tag)) continue;
		const href = hrefOf(tag);
		if (href) return href;
	}

	const metaId = /<meta\b[^>]*\bname\s*=\s*"cover"[^>]*\bcontent\s*=\s*"([^"]+)"/i.exec(
		opfText,
	)?.[1];
	if (metaId) {
		const idPattern = new RegExp(`\\bid\\s*=\\s*"${escapeRegExp(metaId)}"`, "i");
		for (const tag of items) {
			if (!idPattern.test(tag)) continue;
			const href = hrefOf(tag);
			if (href) return href;
		}
	}

	for (const tag of items) {
		if (!/media-type\s*=\s*"image\//i.test(tag)) continue;
		const href = hrefOf(tag);
		if (href && /cover/i.test(href)) return href;
	}

	return undefined;
}
