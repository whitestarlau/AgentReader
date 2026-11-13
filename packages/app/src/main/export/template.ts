/** Standalone HTML shell and styles for exported conversations. */

const CSS = `
:root {
	color-scheme: light dark;
	--bg: #f6f7f9;
	--panel: #ffffff;
	--fg: #1f2328;
	--muted: #667085;
	--border: #e4e7ec;
	--border-strong: #d0d5dd;
	--accent: #2563eb;
	--accent-soft: rgba(37, 99, 235, 0.08);
	--code-bg: #0d1117;
	--code-fg: #e6edf3;
	--quote-bg: #f8fafc;
	--notice-bg: rgba(217, 119, 6, 0.09);
	--notice-fg: #b45309;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #14161b;
		--panel: #1b1e25;
		--fg: #e6e6e6;
		--muted: #9aa4b2;
		--border: #2b303a;
		--border-strong: #3a4150;
		--accent: #7aa2ff;
		--accent-soft: rgba(122, 162, 255, 0.12);
		--code-bg: #0d1117;
		--code-fg: #e6edf3;
		--quote-bg: #1f232b;
		--notice-bg: rgba(245, 158, 11, 0.1);
		--notice-fg: #fbbf24;
	}
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
	margin: 0;
	background: var(--bg);
	color: var(--fg);
	font: 15px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
		"Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
}
.page {
	max-width: 920px;
	margin: 0 auto;
	padding: 44px 24px 72px;
}
.page-head {
	padding-bottom: 22px;
	margin-bottom: 10px;
	border-bottom: 1px solid var(--border);
}
.eyebrow {
	font-size: 12px;
	font-weight: 600;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: var(--accent);
}
.page-head h1 {
	margin: 8px 0 10px;
	font-size: 28px;
	line-height: 1.3;
	letter-spacing: -0.01em;
}
.meta {
	display: flex;
	flex-wrap: wrap;
	gap: 6px 18px;
	color: var(--muted);
	font-size: 13px;
}
.notice-line {
	margin: 0;
	padding: 10px 14px;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--panel);
	color: var(--muted);
}
.turn {
	display: grid;
	grid-template-columns: 76px minmax(0, 1fr);
	gap: 14px;
	padding: 22px 0;
	border-bottom: 1px solid var(--border);
}
.turn:last-child { border-bottom: 0; }
.turn-head {
	display: flex;
	flex-direction: column;
	gap: 4px;
	padding-top: 3px;
	font-size: 12px;
	color: var(--muted);
}
.role { font-size: 13px; font-weight: 650; color: var(--fg); }
.turn-head time { font-variant-numeric: tabular-nums; }
.turn-body { min-width: 0; }
.turn.user .turn-body {
	padding: 14px 16px;
	border: 1px solid var(--border);
	border-radius: 10px;
	background: var(--panel);
}
.turn.assistant .turn-body { padding-top: 2px; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p, .md li { white-space: pre-wrap; }
.md p { margin: 0 0 12px; }
.md h1, .md h2, .md h3, .md h4 {
	margin: 22px 0 10px;
	line-height: 1.35;
}
.md h1 { font-size: 22px; }
.md h2 { font-size: 19px; }
.md h3 { font-size: 17px; }
.md h4 { font-size: 15px; }
.md ul, .md ol { margin: 0 0 12px; padding-left: 22px; }
.md li + li { margin-top: 4px; }
.md blockquote {
	margin: 0 0 12px;
	padding: 8px 14px;
	border-left: 3px solid var(--border-strong);
	background: var(--quote-bg);
	color: var(--muted);
}
.md blockquote > :last-child { margin-bottom: 0; }
.md a { color: var(--accent); text-decoration: none; }
.md a:hover { text-decoration: underline; }
.md code {
	padding: 1px 5px;
	border-radius: 4px;
	background: var(--accent-soft);
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
	font-size: 0.9em;
}
.md pre {
	margin: 0 0 14px;
	padding: 13px 15px;
	overflow: auto;
	border-radius: 8px;
	background: var(--code-bg);
	color: var(--code-fg);
}
.md pre code {
	padding: 0;
	background: transparent;
	color: inherit;
	font-size: 13px;
	line-height: 1.6;
}
.md table {
	display: block;
	width: 100%;
	margin: 0 0 14px;
	overflow-x: auto;
	border-collapse: collapse;
	font-size: 13.5px;
}
.md th, .md td {
	padding: 6px 10px;
	border: 1px solid var(--border);
	text-align: left;
	vertical-align: top;
}
.md th { background: var(--quote-bg); font-weight: 600; }
.md hr { margin: 20px 0; border: 0; border-top: 1px solid var(--border); }
.md img { max-width: 100%; height: auto; border-radius: 6px; }
details {
	margin-top: 14px;
	padding: 9px 13px;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--panel);
}
details summary {
	cursor: pointer;
	color: var(--muted);
	font-size: 13px;
	user-select: none;
}
details[open] summary { margin-bottom: 10px; }
.ref + .ref { margin-top: 12px; }
.ref-head { margin-bottom: 5px; font-size: 12px; font-weight: 600; color: var(--muted); }
.ref-body, .trace pre {
	margin: 0;
	padding: 0;
	border: 0;
	background: transparent;
	color: var(--fg);
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 12.5px;
	line-height: 1.65;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.step + .step { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
.step h4 { margin: 0 0 8px; font-size: 13px; color: var(--muted); }
.step pre + pre { margin-top: 8px; }
.pending { margin-left: 6px; color: var(--notice-fg); font-size: 12px; }
.notice {
	margin-top: 12px;
	padding: 9px 13px;
	border-left: 3px solid var(--notice-fg);
	border-radius: 0 6px 6px 0;
	background: var(--notice-bg);
	color: var(--notice-fg);
	font-size: 13px;
}
.muted { color: var(--muted); font-size: 13px; }
footer {
	margin-top: 34px;
	padding-top: 16px;
	border-top: 1px solid var(--border);
	color: var(--muted);
	font-size: 12px;
}
.print-btn {
	position: fixed;
	right: 22px;
	bottom: 22px;
	padding: 9px 14px;
	border: 1px solid var(--border-strong);
	border-radius: 999px;
	background: var(--panel);
	color: var(--fg);
	font: inherit;
	font-size: 13px;
	cursor: pointer;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}
.print-btn:hover { border-color: var(--accent); color: var(--accent); }
@media (max-width: 640px) {
	.page { padding: 28px 16px 56px; }
	.page-head h1 { font-size: 23px; }
	.turn { grid-template-columns: 1fr; gap: 6px; }
	.turn-head { flex-direction: row; align-items: baseline; gap: 8px; }
}
@media print {
	:root {
		--bg: #fff;
		--panel: #fff;
		--fg: #111;
		--muted: #555;
		--border: #ddd;
		--border-strong: #bbb;
		--code-bg: #f3f4f6;
		--code-fg: #111;
		--quote-bg: #fafafa;
	}
	body { background: #fff; color: #111; }
	.page { max-width: none; padding: 0; }
	.print-btn { display: none !important; }
	.turn { break-inside: avoid; page-break-inside: avoid; }
	details { break-inside: avoid; page-break-inside: avoid; }
	.md pre { border: 1px solid #ddd; }
	.md a { color: inherit; text-decoration: underline; }
}
`;

export function escapeHtml(value: string): string {
	return String(value ?? "").replace(
		/[&<>"']/g,
		(char) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[char] ?? char,
	);
}

export function htmlDocument(input: {
	title: string;
	heading: string;
	meta: string[];
	body: string;
	footer: string;
}): string {
	const meta = input.meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("");
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="AgentReader">
<title>${escapeHtml(input.title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">
<header class="page-head">
<div class="eyebrow">AgentReader · 对话导出</div>
<h1>${escapeHtml(input.heading)}</h1>
<div class="meta">${meta}</div>
</header>
<main>
${input.body}
</main>
<footer>${escapeHtml(input.footer)}</footer>
</div>
<button class="print-btn no-print" type="button" onclick="window.print()">打印 / 另存为 PDF</button>
<script>
addEventListener("beforeprint", () => {
	for (const details of document.querySelectorAll("details")) details.open = true;
});
</script>
</body>
</html>
`;
}
