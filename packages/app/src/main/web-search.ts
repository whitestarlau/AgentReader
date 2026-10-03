import type { WebSearchBackend } from "@agentreader/ai";

export type WebSearchResult = { title: string; url: string; snippet: string };

export type WebSearchRequest = {
	query: string;
	count: number;
	signal?: AbortSignal;
	apiKey?: string;
	/** Conversation id; used for stable provider selection and Parallel's session id. */
	sessionId?: string;
};

export type WebSearchResponse = {
	backend: WebSearchBackend;
	results: WebSearchResult[];
	/** Model-facing text for MCP backends that return a formatted blob instead of structured rows. */
	text?: string;
};

const USER_AGENT = "agentreader/0.1.0";

// Public, key-less MCP search endpoints used by OpenCode. Anonymous use is
// best-effort: they may rate-limit or start requiring keys.
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";

/** Default environment variable per backend. The MCP backends read theirs directly (optional). */
export const BACKEND_ENV: Partial<Record<WebSearchBackend, string>> = {
	brave: "BRAVE_API_KEY",
	tavily: "TAVILY_API_KEY",
	exa: "EXA_API_KEY",
};

function truncate(text: string, max = 400): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function normalize(results: WebSearchResult[]): WebSearchResult[] {
	return results
		.filter((r) => r.url)
		.map((r) => ({ title: r.title || r.url, url: r.url, snippet: truncate(r.snippet ?? "") }));
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Cap MCP text fed to the model; Exa/Parallel blobs can be tens of KB. */
const MAX_MCP_TEXT = 12000;
function clampText(text: string): string {
	return text.length > MAX_MCP_TEXT ? `${text.slice(0, MAX_MCP_TEXT)}\n…（已截断）` : text;
}

/** Deterministic 32-bit hash for stable per-conversation provider selection. */
function hashSeed(seed: string): number {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

// ---------------------------------------------------------------- API backends

async function searchBrave(req: WebSearchRequest): Promise<WebSearchResult[]> {
	if (!req.apiKey) throw new Error("Brave 需要 API Key");
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", req.query);
	url.searchParams.set("count", String(req.count));
	const res = await fetch(url, {
		headers: {
			Accept: "application/json",
			"X-Subscription-Token": req.apiKey,
			"User-Agent": USER_AGENT,
		},
		signal: req.signal,
	});
	if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
	const json = (await res.json()) as {
		web?: { results?: { title?: string; url?: string; description?: string }[] };
	};
	return normalize(
		(json.web?.results ?? []).map((r) => ({
			title: r.title ?? "",
			url: r.url ?? "",
			snippet: r.description ?? "",
		})),
	);
}

async function searchTavily(req: WebSearchRequest): Promise<WebSearchResult[]> {
	if (!req.apiKey) throw new Error("Tavily 需要 API Key");
	const res = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${req.apiKey}`,
			"User-Agent": USER_AGENT,
		},
		body: JSON.stringify({
			api_key: req.apiKey,
			query: req.query,
			max_results: req.count,
			search_depth: "basic",
		}),
		signal: req.signal,
	});
	if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
	const json = (await res.json()) as {
		results?: { title?: string; url?: string; content?: string }[];
	};
	return normalize(
		(json.results ?? []).map((r) => ({
			title: r.title ?? "",
			url: r.url ?? "",
			snippet: r.content ?? "",
		})),
	);
}

async function searchExa(req: WebSearchRequest): Promise<WebSearchResult[]> {
	if (!req.apiKey) throw new Error("Exa 需要 API Key");
	const res = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": req.apiKey,
			"User-Agent": USER_AGENT,
		},
		body: JSON.stringify({
			query: req.query,
			numResults: req.count,
			contents: { text: { maxCharacters: 600 } },
		}),
		signal: req.signal,
	});
	if (!res.ok) throw new Error(`Exa HTTP ${res.status}`);
	const json = (await res.json()) as {
		results?: { title?: string; url?: string; text?: string }[];
	};
	return normalize(
		(json.results ?? []).map((r) => ({
			title: r.title ?? "",
			url: r.url ?? "",
			snippet: r.text ?? "",
		})),
	);
}

function stripTags(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Parse DuckDuckGo HTML results. Exported for testing; DDG is best-effort. */
export function parseDuckDuckGoHtml(html: string, count: number): WebSearchResult[] {
	const results: WebSearchResult[] = [];
	const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
	const links: { url: string; title: string }[] = [];
	let m: RegExpExecArray | null = linkRe.exec(html);
	while (m) {
		let href = m[1];
		const uddg = /[?&]uddg=([^&]+)/.exec(href);
		if (uddg) href = decodeURIComponent(uddg[1]);
		links.push({ url: href, title: stripTags(m[2]) });
		if (links.length >= count) break;
		m = linkRe.exec(html);
	}
	const snippets: string[] = [];
	let s: RegExpExecArray | null = snippetRe.exec(html);
	while (s) {
		snippets.push(stripTags(s[1]));
		s = snippetRe.exec(html);
	}
	for (let i = 0; i < links.length; i++) {
		results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? "" });
	}
	return normalize(results);
}

async function searchDuckDuckGo(req: WebSearchRequest): Promise<WebSearchResult[]> {
	const url = new URL("https://html.duckduckgo.com/html/");
	url.searchParams.set("q", req.query);
	const res = await fetch(url, {
		headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
		signal: req.signal,
	});
	if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
	return parseDuckDuckGoHtml(await res.text(), req.count);
}

// ------------------------------------------------------------- MCP backends

/** Parse a JSON-RPC MCP response, accepting both plain JSON and SSE `data:` frames. */
export function parseMcpResponse(body: string): string | undefined {
	const extract = (payload: string): string | undefined => {
		const trimmed = payload.trim();
		if (!trimmed.startsWith("{")) return undefined;
		try {
			const json = JSON.parse(trimmed) as {
				result?: { content?: { type?: string; text?: string }[] };
			};
			return json.result?.content?.find((item) => item?.text)?.text;
		} catch {
			return undefined;
		}
	};
	const direct = extract(body);
	if (direct) return direct;
	for (const line of body.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const text = extract(line.slice(6));
		if (text) return text;
	}
	return undefined;
}

async function callMcp(
	url: string,
	tool: string,
	args: Record<string, unknown>,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
): Promise<string> {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...headers,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: tool, arguments: args },
		}),
		signal: withTimeout(signal, 25000),
	});
	if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
	const text = parseMcpResponse(await res.text());
	if (!text) throw new Error("MCP 返回为空");
	return text;
}

/** Best-effort extraction of structured rows from Exa's formatted text block. */
function exaTextToResults(text: string): WebSearchResult[] {
	const results: WebSearchResult[] = [];
	const re = /Title:\s*(.*)\r?\nURL:\s*(\S+)/g;
	let m: RegExpExecArray | null = re.exec(text);
	while (m) {
		results.push({ title: m[1].trim(), url: m[2].trim(), snippet: "" });
		m = re.exec(text);
	}
	return results.slice(0, 20);
}

/** Parallel returns a JSON string inside the MCP text field. */
function parallelTextToResults(text: string): WebSearchResult[] {
	try {
		const json = JSON.parse(text) as {
			results?: { title?: string; url?: string; excerpts?: string[] | string }[];
		};
		return (json.results ?? []).map((r) => ({
			title: r.title ?? r.url ?? "",
			url: r.url ?? "",
			snippet: Array.isArray(r.excerpts) ? r.excerpts.join(" ") : (r.excerpts ?? ""),
		}));
	} catch {
		return [];
	}
}

async function searchExaMcp(req: WebSearchRequest, key?: string): Promise<WebSearchResponse> {
	const apiKey = key ?? process.env.EXA_API_KEY;
	const url = apiKey ? `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(apiKey)}` : EXA_MCP_URL;
	const text = await callMcp(
		url,
		"web_search_exa",
		{
			query: req.query,
			type: "auto",
			numResults: req.count,
			livecrawl: "fallback",
			contextMaxCharacters: 6000,
		},
		{},
		req.signal,
	);
	return { backend: "exa-mcp", results: normalize(exaTextToResults(text)), text: clampText(text) };
}

async function searchParallelMcp(req: WebSearchRequest, key?: string): Promise<WebSearchResponse> {
	const apiKey = key ?? process.env.PARALLEL_API_KEY;
	const text = await callMcp(
		PARALLEL_MCP_URL,
		"web_search",
		{
			objective: req.query,
			search_queries: [req.query],
			session_id: req.sessionId ?? "agentreader",
		},
		{ "User-Agent": `${USER_AGENT}`, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
		req.signal,
	);
	return {
		backend: "parallel-mcp",
		results: normalize(parallelTextToResults(text)),
		text: clampText(text),
	};
}

async function runBackend(
	backend: Exclude<WebSearchBackend, "auto" | "native">,
	req: WebSearchRequest,
): Promise<WebSearchResponse> {
	switch (backend) {
		case "exa-mcp":
			return searchExaMcp(req, req.apiKey);
		case "parallel-mcp":
			return searchParallelMcp(req, req.apiKey);
		case "brave":
			return { backend, results: await searchBrave(req) };
		case "tavily":
			return { backend, results: await searchTavily(req) };
		case "exa":
			return { backend, results: await searchExa(req) };
		case "duckduckgo":
			return { backend, results: await searchDuckDuckGo(req) };
	}
}

/** Try the two key-less MCP backends, preferring one deterministically per conversation. */
async function searchAuto(req: WebSearchRequest): Promise<WebSearchResponse> {
	const first: Exclude<WebSearchBackend, "auto" | "native"> =
		hashSeed(req.sessionId ?? req.query) % 2 === 0 ? "exa-mcp" : "parallel-mcp";
	const order = [first, first === "exa-mcp" ? "parallel-mcp" : "exa-mcp"] as const;
	let lastError: unknown;
	for (const backend of order) {
		try {
			return await runBackend(backend, req);
		} catch (e) {
			lastError = e;
		}
	}
	throw lastError instanceof Error ? lastError : new Error("所有搜索后端均失败");
}

/** Run a web search against the selected backend. `native` is handled by the model provider. */
export async function searchWeb(
	backend: WebSearchBackend,
	req: WebSearchRequest,
): Promise<WebSearchResponse> {
	const withCount = { ...req, count: Math.max(1, Math.min(10, req.count || 5)) };
	if (backend === "auto") return searchAuto(withCount);
	if (backend === "native") throw new Error("后端 native 需要由模型服务商处理，无法本地调用");
	return runBackend(backend, withCount);
}
