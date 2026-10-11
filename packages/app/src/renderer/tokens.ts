/**
 * Rough token estimate for the context indicator, used until the provider
 * reports exact usage. CJK glyphs count as one token each; Latin text averages
 * ~4 characters per token.
 */
export function estimateTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef)) cjk++;
		else other++;
	}
	return cjk + Math.ceil(other / 4);
}

/** Format a token count compactly: 1234 → "1.2k", 200000 → "200k". */
export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
	return `${(n / 1000000).toFixed(1)}M`;
}
