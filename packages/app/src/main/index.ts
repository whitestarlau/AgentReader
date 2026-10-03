import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentLoop } from "@agentreader/agent";
import {
	createModelRuntime,
	getBuiltinProvider,
	type Model,
	type ModelRuntime,
	type ModelsFile,
	type StreamFn,
} from "@agentreader/ai";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { getProviderKey, hasStoredKey, setProviderKey } from "./ai-auth.ts";
import {
	type CustomProvider,
	configPath,
	ensureConfig,
	readConfig,
	readCustomProviders,
	readModelCache,
	writeConfigText,
	writeCustomProviders,
	writeModelCache,
} from "./ai-config.ts";
import { readSettings, writeSettings } from "./settings.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const LIBRARY_ROOT = join(app.getPath("userData"), "library");

function getDocDir(docId: string) {
	return join(LIBRARY_ROOT, docId);
}

function ensureLibrary() {
	mkdirSync(LIBRARY_ROOT, { recursive: true });
}

ipcMain.handle("library:list", () => {
	ensureLibrary();
	if (!existsSync(LIBRARY_ROOT)) return [];
	return readdirSync(LIBRARY_ROOT)
		.filter((id) => existsSync(join(LIBRARY_ROOT, id, "doc.json")))
		.map((id) => JSON.parse(readFileSync(join(LIBRARY_ROOT, id, "doc.json"), "utf-8")));
});

ipcMain.handle("library:import", async () => {
	ensureLibrary();
	const { canceled, filePaths } = await dialog.showOpenDialog({
		properties: ["openFile"],
		filters: [{ name: "Documents", extensions: ["pdf", "epub"] }],
	});
	if (canceled || !filePaths[0]) return null;
	const src = filePaths[0];
	const buf = readFileSync(src);
	const hash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
	const docId = hash;
	const dir = getDocDir(docId);
	mkdirSync(dir, { recursive: true });
	const ext = src.split(".").pop() ?? "pdf";
	copyFileSync(src, join(dir, `original.${ext}`));
	const meta = {
		id: docId,
		title: src.split("/").pop() ?? docId,
		ext,
		hash,
		importedAt: Date.now(),
		originalPath: src,
	};
	writeFileSync(join(dir, "doc.json"), JSON.stringify(meta, null, 2));
	if (!existsSync(join(dir, "annotations.json")))
		writeFileSync(join(dir, "annotations.json"), "[]");
	return meta;
});

ipcMain.handle("library:remove", async (_e, docId: string) => {
	const dir = getDocDir(docId);
	// Release in-memory handles/caches before deleting the folder from disk.
	const pdf = pdfDocCache.get(docId);
	if (pdf) {
		pdfDocCache.delete(docId);
		pdf.then((d) => d.destroy?.()).catch(() => {});
	}
	docTextCache.delete(docId);
	rawPageCache.delete(docId);
	ocrCache.delete(docId);
	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	return true;
});

ipcMain.handle("doc:annotations:get", (_e, docId: string) => {
	const p = join(getDocDir(docId), "annotations.json");
	if (!existsSync(p)) return [];
	return JSON.parse(readFileSync(p, "utf-8"));
});

ipcMain.handle("doc:annotations:save", (_e, docId: string, annotations: unknown) => {
	writeFileSync(join(getDocDir(docId), "annotations.json"), JSON.stringify(annotations, null, 2));
});

function ocrFile(docId: string) {
	return join(getDocDir(docId), "ocr.json");
}
const ocrCache = new Map<string, Record<string, string>>();
function readOcr(docId: string): Record<string, string> {
	const cached = ocrCache.get(docId);
	if (cached) return cached;
	const p = ocrFile(docId);
	let data: Record<string, string> = {};
	if (existsSync(p)) {
		try {
			data = JSON.parse(readFileSync(p, "utf-8"));
		} catch {
			data = {};
		}
	}
	ocrCache.set(docId, data);
	return data;
}
ipcMain.handle("doc:ocr:get", (_e, docId: string) => readOcr(docId));
ipcMain.handle("doc:ocr:save", (_e, docId: string, page: number, text: string) => {
	const data = readOcr(docId);
	data[String(page)] = text;
	writeFileSync(ocrFile(docId), JSON.stringify(data, null, 2));
	// Force the assembled view (pages[] / isScanned / ocrCount) to be rebuilt lazily.
	docTextCache.delete(docId);
});

ipcMain.handle("doc:path", (_e, docId: string) => {
	const dir = getDocDir(docId);
	if (!existsSync(join(dir, "doc.json"))) return null;
	const meta = JSON.parse(readFileSync(join(dir, "doc.json"), "utf-8"));
	return join(dir, `original.${meta.ext}`);
});

ipcMain.handle("doc:read", (_e, path: string) => {
	return readFileSync(path);
});

function conversationsFile(docId: string) {
	return join(getDocDir(docId), "conversations.json");
}
function chatFile(docId: string, convId: string) {
	return join(getDocDir(docId), "chats", `${convId}.jsonl`);
}
function ensureConversations(docId: string) {
	const dir = getDocDir(docId);
	const convFile = conversationsFile(docId);
	const chatsDir = join(dir, "chats");
	mkdirSync(chatsDir, { recursive: true });
	if (!existsSync(convFile)) {
		const oldPath = join(dir, "chats.jsonl");
		if (existsSync(oldPath)) {
			const id = randomUUID();
			const oldContent = readFileSync(oldPath, "utf-8");
			writeFileSync(join(chatsDir, `${id}.jsonl`), oldContent);
			writeFileSync(
				convFile,
				JSON.stringify(
					[{ id, title: "默认对话", createdAt: Date.now(), updatedAt: Date.now() }],
					null,
					2,
				),
			);
			unlinkSync(oldPath);
			return [{ id, title: "默认对话", createdAt: Date.now(), updatedAt: Date.now() }];
		}
		writeFileSync(convFile, JSON.stringify([], null, 2));
		return [];
	}
	return JSON.parse(readFileSync(convFile, "utf-8"));
}
function saveConversations(docId: string, list: unknown) {
	writeFileSync(conversationsFile(docId), JSON.stringify(list, null, 2));
}

/** Merge GUI-managed custom providers under the models.json providers (file wins on id conflict). */
function mergeCustomProviders(
	file: ModelsFile,
	custom: Record<string, CustomProvider>,
): ModelsFile {
	const declared =
		file.providers && typeof file.providers === "object" && !Array.isArray(file.providers)
			? file.providers
			: {};
	return { ...file, providers: { ...custom, ...declared } };
}

/** Build a model runtime from models.json + GUI providers + the encrypted auth store + env. */
function buildRuntime(): {
	runtime: ModelRuntime;
	file: ModelsFile;
	custom: Record<string, CustomProvider>;
} {
	const cfg = readConfig();
	const custom = readCustomProviders();
	const file = mergeCustomProviders(cfg.file, custom);
	const runtime = createModelRuntime({
		file,
		configErrors: cfg.errors,
		modelCache: readModelCache(),
		resolveSecret: (providerId, provider) => {
			const stored = getProviderKey(providerId);
			if (stored) return stored;
			for (const env of provider.envVars) {
				const value = process.env[env];
				if (value) return value;
			}
			return undefined;
		},
	});
	return { runtime, file, custom };
}

/** Current model: app-selected ref → models.json defaultModel → first available. */
function resolveCurrentModel(runtime: ModelRuntime, file: ModelsFile): Model | undefined {
	const settings = readSettings();
	return (
		runtime.getModel(settings.model) ?? runtime.getModel(file.defaultModel) ?? runtime.models[0]
	);
}

function modelRef(model: Model): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Ask the model for a short title summarizing the conversation's first message.
 * Returns the cleaned title, or null if anything goes wrong (the caller then
 * keeps the placeholder title).
 */
async function generateConversationTitle(
	runtime: ModelRuntime,
	model: Model,
	userPrompt: string,
): Promise<string | null> {
	if (!runtime.resolveApiKey(model.provider)) return null;
	let raw = "";
	let reasoning = "";
	try {
		for await (const evt of runtime.stream(
			model,
			{
				systemPrompt:
					"你是对话命名助手。请根据用户的第一条消息，用简短的中文（或与用户语言一致）为这次对话起一个标题。只输出标题本身，不要引号、不要标点、不要解释，最多 12 个字。",
				messages: [{ role: "user", content: userPrompt.slice(0, 400) }],
			},
			{ maxTokens: 512, temperature: 0.3 },
		)) {
			if (evt.type === "text_delta") raw += evt.delta;
			else if (evt.type === "reasoning_delta") reasoning += evt.delta;
			else if (evt.type === "done") break;
		}
	} catch {
		return null;
	}
	// Reasoning models may put the answer in content; if content is empty, the
	// last non-empty line of the reasoning often still carries the title.
	const source = raw.trim() || reasoning.trim();
	let title = cleanTitle(source);
	if (!title) return null;
	if (title.length > 24) title = title.slice(0, 24);
	return title || null;
}

/** Strip code fences, wrapping quotes, and trailing punctuation from a model reply. */
function cleanTitle(input: string): string {
	const lastLine = input
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.pop();
	const base = (lastLine ?? input).trim();
	return base
		.replace(/^```[\s\S]*?\n|```$/g, "")
		.replace(/^["“”'‘’《【\s]+|["“”'‘’》】\s]+$/g, "")
		.replace(/^(标题|title)\s*[:：]\s*/i, "")
		.replace(/[。.,，!！?？、；;：:\n\r]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

type DocText = {
	/** First pages/chapters extracted eagerly, for the system prompt and current-page hint. */
	pages: string[];
	/** Real page/chapter count of the whole document (not capped by `pages.length`). */
	numPages: number;
	toc: { label: string; href: string }[];
	title: string;
	ext: string;
	isScanned: boolean;
	ocrCount: number;
	/** Reads any page/chapter by number, extracting (and caching) on demand. */
	getPage: (n: number) => Promise<string>;
};

const docTextCache = new Map<string, DocText>();
const rawPageCache = new Map<string, Map<number, string>>();

/** How many pages to extract up-front; the rest are lazily extracted by tools. */
const EAGER_PAGES = 80;

type PdfDocLike = {
	numPages: number;
	getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: { str?: string }[] }> }>;
	destroy?: () => Promise<void>;
};
const pdfDocCache = new Map<string, Promise<PdfDocLike>>();

function getPdfDoc(docId: string): Promise<PdfDocLike> {
	const cached = pdfDocCache.get(docId);
	if (cached) return cached;
	const p = (async () => {
		const dir = getDocDir(docId);
		const meta = JSON.parse(readFileSync(join(dir, "doc.json"), "utf-8"));
		const buf = readFileSync(join(dir, `original.${meta.ext}`));
		const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
			getDocument: (opts: { data: Uint8Array }) => { promise: Promise<PdfDocLike> };
		};
		return pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
	})().catch((e) => {
		pdfDocCache.delete(docId);
		throw e;
	});
	pdfDocCache.set(docId, p);
	return p;
}

/** Embedded (non-OCR) text of one page, cached per document. */
async function getRawPage(docId: string, pageNo: number): Promise<string> {
	const pages = rawPageCache.get(docId) ?? new Map<number, string>();
	rawPageCache.set(docId, pages);
	const hit = pages.get(pageNo);
	if (hit !== undefined) return hit;
	let text = "";
	try {
		const doc = await getPdfDoc(docId);
		const page = await doc.getPage(pageNo);
		const content = await page.getTextContent();
		text = content.items
			.map((it) => it.str ?? "")
			.join(" ")
			.slice(0, 4000);
	} catch (e) {
		console.error("[docText] page error", pageNo, e);
	}
	pages.set(pageNo, text);
	return text;
}

/** Second track: fall back to OCR wherever the embedded text layer is empty. */
function withOcr(docId: string, pageNo: number, raw: string): string {
	if (raw.trim()) return raw;
	return readOcr(docId)[String(pageNo)] ?? raw;
}

async function getDocText(docId: string): Promise<DocText> {
	const cached = docTextCache.get(docId);
	if (cached !== undefined) return cached;
	const dir = getDocDir(docId);
	const meta = JSON.parse(readFileSync(join(dir, "doc.json"), "utf-8"));
	const ext = meta.ext as string;

	if (ext === "epub") {
		try {
			const JSZip = (await import("jszip")).default;
			const buf = readFileSync(join(dir, `original.${ext}`));
			const zip = await JSZip.loadAsync(buf);
			const containerXml = await zip.file("META-INF/container.xml")?.async("string");
			const rootfileMatch = containerXml?.match(/full-path="([^"]+)"/);
			const opfPath = rootfileMatch ? rootfileMatch[1] : "OEBPS/content.opf";
			const opfText = (await zip.file(opfPath)?.async("string")) ?? "";
			const spineMatches = [...opfText.matchAll(/<item[^>]*href="([^"]+)"[^>]*>/g)].map(
				(m) => m[1],
			);
			const baseDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
			const pages: string[] = [];
			for (const href of spineMatches.slice(0, 50)) {
				const fullPath = baseDir + href;
				const content = await zip.file(fullPath)?.async("string");
				if (content) {
					const text = content
						.replace(/<[^>]+>/g, " ")
						.replace(/\s+/g, " ")
						.trim()
						.slice(0, 4000);
					if (text) pages.push(text);
				}
			}
			const ncxMatch = opfText.match(
				/<item[^>]*media-type="application\/x-dtbncx\+xml"[^>]*href="([^"]+)"/,
			);
			let toc: { label: string; href: string }[] = [];
			if (ncxMatch) {
				const ncxPath = baseDir + ncxMatch[1];
				const ncxText = (await zip.file(ncxPath)?.async("string")) ?? "";
				toc = [...ncxText.matchAll(/<text>([^<]+)<\/text>/g)].map((m, i) => ({
					label: m[1],
					href: `chapter-${i}`,
				}));
			}
			const result: DocText = {
				pages,
				numPages: pages.length,
				toc,
				title: meta.title,
				ext,
				isScanned: false,
				ocrCount: 0,
				getPage: async (n) => pages[Math.max(1, Math.min(pages.length, n)) - 1] ?? "",
			};
			docTextCache.set(docId, result);
			return result;
		} catch (e) {
			console.error("[docText] epub error", e);
		}
	}

	try {
		const doc = await getPdfDoc(docId);
		const numPages = doc.numPages;
		const pages: string[] = [];
		let hasTextLayer = false;
		for (let i = 1; i <= Math.min(numPages, EAGER_PAGES); i++) {
			const raw = await getRawPage(docId, i);
			if (raw.trim()) hasTextLayer = true;
			pages.push(withOcr(docId, i, raw));
		}
		const result: DocText = {
			pages,
			numPages,
			toc: [],
			title: meta.title,
			ext,
			isScanned: numPages > 0 && !hasTextLayer,
			ocrCount: Object.keys(readOcr(docId)).length,
			getPage: async (n) => {
				const p = Math.max(1, Math.min(numPages, n));
				return withOcr(docId, p, await getRawPage(docId, p));
			},
		};
		docTextCache.set(docId, result);
		return result;
	} catch (e) {
		console.error("[docText] pdf error", e);
	}
	const fallback: DocText = {
		pages: [],
		numPages: 0,
		toc: [],
		title: meta.title,
		ext,
		isScanned: false,
		ocrCount: 0,
		getPage: async () => "",
	};
	docTextCache.set(docId, fallback);
	return fallback;
}

ipcMain.handle("conversations:list", (_e, docId: string) => ensureConversations(docId));
ipcMain.handle("conversations:create", (_e, docId: string, title?: string) => {
	const list = ensureConversations(docId);
	const conv = {
		id: randomUUID(),
		title: title || `对话 ${list.length + 1}`,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	list.unshift(conv);
	saveConversations(docId, list);
	writeFileSync(chatFile(docId, conv.id), "");
	return conv;
});
ipcMain.handle("conversations:delete", (_e, docId: string, convId: string) => {
	const list = ensureConversations(docId);
	const next = list.filter((c: { id: string }) => c.id !== convId);
	saveConversations(docId, next);
	const p = chatFile(docId, convId);
	if (existsSync(p)) rmSync(p, { force: true });
	return next;
});
ipcMain.handle("conversations:rename", (_e, docId: string, convId: string, title: string) => {
	const list = ensureConversations(docId);
	const conv = list.find((c: { id: string }) => c.id === convId);
	if (conv) {
		conv.title = title;
		conv.updatedAt = Date.now();
		saveConversations(docId, list);
	}
	return conv;
});

ipcMain.handle("chat:list", (_e, docId: string, convId?: string) => {
	if (!convId) {
		const list = ensureConversations(docId);
		if (list.length === 0) return [];
		convId = list[0].id;
	}
	const p = chatFile(docId, convId as string);
	if (!existsSync(p)) return [];
	const raw = readFileSync(p, "utf-8").trim();
	if (!raw) return [];
	return raw
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
});

ipcMain.handle("chat:append", (_e, docId: string, convId: string, entry: unknown) => {
	if (!convId) return;
	const p = chatFile(docId, convId);
	mkdirSync(join(getDocDir(docId), "chats"), { recursive: true });
	appendFileSync(
		p,
		`${JSON.stringify({ id: randomUUID(), timestamp: Date.now(), ...(entry as object) })}\n`,
	);
	const list = ensureConversations(docId);
	const conv = list.find((c: { id: string }) => c.id === convId);
	if (conv) {
		conv.updatedAt = Date.now();
		if (!conv.title || conv.title.startsWith("对话 ")) {
			const firstText = (entry as { content?: string })?.content?.slice(0, 20);
			if (firstText) conv.title = firstText;
		}
		saveConversations(docId, list);
	}
});

ipcMain.handle("settings:get", () => readSettings());

ipcMain.handle("settings:save", (_e, settings: Record<string, string>) => {
	writeSettings(settings);
});

type ProviderSummary = {
	id: string;
	name: string;
	baseUrl: string;
	api: string;
	isBuiltin: boolean;
	source: "builtin" | "file" | "gui";
	configured: boolean;
	keySource: "stored" | "env" | null;
	modelCount: number;
};

function buildConfigPayload() {
	const cfg = readConfig();
	const { runtime, file, custom } = buildRuntime();
	const declared =
		cfg.file.providers &&
		typeof cfg.file.providers === "object" &&
		!Array.isArray(cfg.file.providers)
			? cfg.file.providers
			: {};
	const providers: ProviderSummary[] = runtime.providers.map((p) => {
		const envVar = p.envVars.find((e) => process.env[e]);
		const stored = hasStoredKey(p.id);
		return {
			id: p.id,
			name: p.name,
			baseUrl: p.baseUrl,
			api: p.api,
			isBuiltin: p.isBuiltin,
			source: p.isBuiltin ? "builtin" : declared[p.id] ? "file" : custom[p.id] ? "gui" : "builtin",
			configured: Boolean(p.apiKey || stored || envVar),
			keySource: stored ? "stored" : envVar ? "env" : null,
			modelCount: p.models.length,
		};
	});
	const configuredById = new Map(providers.map((p) => [p.id, p.configured]));
	const current = resolveCurrentModel(runtime, file);
	return {
		path: cfg.path,
		text: cfg.text,
		errors: runtime.errors,
		defaultModel: current ? modelRef(current) : null,
		providers,
		models: runtime.models.map((m) => ({
			ref: modelRef(m),
			id: m.id,
			provider: m.provider,
			label: m.label,
			contextWindow: m.contextWindow,
			configured: configuredById.get(m.provider) ?? false,
		})),
	};
}

ipcMain.handle("ai:config", () => buildConfigPayload());

ipcMain.handle("ai:config:save", (_e, text: string) => writeConfigText(text));

ipcMain.handle("ai:config:open", async () => {
	const settings = readSettings();
	ensureConfig({ baseUrl: settings.baseUrl, model: settings.model });
	await shell.openPath(configPath());
	return configPath();
});

ipcMain.handle("ai:model:set", (_e, ref: string) => {
	const settings = readSettings();
	settings.model = ref;
	writeSettings(settings);
	return true;
});

ipcMain.handle("ai:key:set", (_e, providerId: string, key: string) => {
	setProviderKey(providerId, key);
	return true;
});

ipcMain.handle("ai:custom:list", () => readCustomProviders());

ipcMain.handle(
	"ai:custom:save",
	(_e, input: { id: string; name?: string; baseUrl: string; models: string[] }) => {
		const id = String(input?.id ?? "")
			.trim()
			.toLowerCase();
		if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
			return { ok: false, error: "标识 ID 只能包含小写字母、数字和连字符" };
		}
		if (getBuiltinProvider(id))
			return { ok: false, error: `"${id}" 与内置提供商冲突，请换一个 ID` };
		const baseUrl = String(input?.baseUrl ?? "").trim();
		if (!baseUrl) return { ok: false, error: "请填写 Base URL" };
		const modelIds = (input?.models ?? [])
			.map((m) => String(m).trim())
			.filter(Boolean)
			.filter((m, i, arr) => arr.indexOf(m) === i);
		if (modelIds.length === 0) return { ok: false, error: "请至少填写一个模型 ID" };
		const data = readCustomProviders();
		data[id] = {
			name: String(input?.name ?? "").trim() || id,
			baseUrl,
			api: "openai-completions",
			models: modelIds.map((m) => ({ id: m })),
		};
		writeCustomProviders(data);
		return { ok: true, id };
	},
);

ipcMain.handle("ai:custom:remove", (_e, id: string) => {
	const data = readCustomProviders();
	delete data[id];
	writeCustomProviders(data);
	return true;
});

ipcMain.handle("ai:models:refresh", async (_e, providerId?: string) => {
	const { runtime } = buildRuntime();
	const cache = readModelCache();
	const results: { provider: string; added?: number; error?: string }[] = [];
	for (const p of runtime.providers) {
		if (providerId && p.id !== providerId) continue;
		if (p.api !== "openai-completions" || !p.baseUrl) continue;
		const key = runtime.resolveApiKey(p.id);
		try {
			const base = p.baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
			// Fetching /models is a public read for most OpenAI-compatible gateways.
			const res = await fetch(`${base}/models`, {
				headers: key ? { Authorization: `Bearer ${key}` } : {},
			});
			if (!res.ok) {
				results.push({ provider: p.id, error: `HTTP ${res.status}` });
				continue;
			}
			const json = (await res.json()) as { data?: { id?: unknown }[] };
			const ids = Array.isArray(json.data)
				? json.data.map((m) => m?.id).filter((x): x is string => typeof x === "string")
				: [];
			cache[p.id] = ids;
			results.push({ provider: p.id, added: ids.length });
		} catch (e) {
			results.push({ provider: p.id, error: e instanceof Error ? e.message : String(e) });
		}
	}
	writeModelCache(cache);
	return results;
});

// Remember the last read position so reopening a document resumes where the user left off.
ipcMain.handle("reading:get", (_e, docId: string) => {
	try {
		const m = JSON.parse(readFileSync(join(getDocDir(docId), "doc.json"), "utf-8")) as {
			lastPage?: number;
			lastLocation?: string;
		};
		return { page: m.lastPage ?? null, location: m.lastLocation ?? null };
	} catch {
		return { page: null, location: null };
	}
});

ipcMain.handle("reading:save", (_e, docId: string, patch: { page?: number; location?: string }) => {
	try {
		const p = join(getDocDir(docId), "doc.json");
		const meta = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
		if (typeof patch.page === "number" && patch.page > 0) meta.lastPage = patch.page;
		if (typeof patch.location === "string" && patch.location) meta.lastLocation = patch.location;
		writeFileSync(p, JSON.stringify(meta, null, 2));
	} catch {}
});

ipcMain.handle(
	"chat:send",
	async (
		event,
		docId: string,
		convId: string,
		prompt: string,
		history: { role: string; content: string }[],
		page?: number,
	) => {
		const { runtime, file } = buildRuntime();
		const model = resolveCurrentModel(runtime, file);
		if (!model) return { error: "未配置可用模型，请在设置中添加提供商与模型" };
		if (!runtime.resolveApiKey(model.provider)) {
			return { error: `未配置 ${model.provider} 的 API Key，请在设置中填写` };
		}

		// First user message in this conversation -> let the model name it.
		// Determine "first" from the on-disk transcript rather than trusting the
		// renderer's history array (which can be stale right after creating a chat).
		let generatedTitle: string | null = null;
		let isFirstMessage = false;
		try {
			const p = chatFile(docId, convId);
			const raw = existsSync(p) ? readFileSync(p, "utf-8").trim() : "";
			isFirstMessage = raw.split("\n").filter(Boolean).length === 0;
		} catch {
			isFirstMessage = history.length === 0;
		}
		if (isFirstMessage && prompt.trim()) {
			generatedTitle = await generateConversationTitle(runtime, model, prompt);
			console.log("[chat] title generated", JSON.stringify(generatedTitle));
			// Fall back to a snippet of the user's message so the title is never
			// left as the generic "对话 N" placeholder.
			if (!generatedTitle) {
				const snippet = prompt
					.replace(/^【[\s\S]*?】\s*/, "")
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, 16);
				if (snippet) generatedTitle = snippet;
			}
			if (generatedTitle) {
				try {
					const list = ensureConversations(docId);
					const conv = list.find((c: { id: string }) => c.id === convId);
					if (conv) {
						conv.title = generatedTitle;
						conv.updatedAt = Date.now();
						saveConversations(docId, list);
					}
				} catch {}
			}
		}

		const docText = await getDocText(docId).catch(() => ({
			pages: [] as string[],
			numPages: 0,
			toc: [] as { label: string; href: string }[],
			title: docId,
			ext: "pdf",
			isScanned: false,
			ocrCount: 0,
			getPage: async () => "",
		}));
		const tocStr =
			docText.toc
				.slice(0, 20)
				.map((t, i) => `${i + 1}. ${t.label}`)
				.join("\n") || "无目录";
		const hintPage =
			typeof page === "number" && page > 0 ? Math.min(page, docText.numPages || page) : undefined;
		const hintText = hintPage ? await docText.getPage(hintPage) : "";
		const currentPageHint = hintPage
			? `用户当前在第 ${hintPage} 页，该页文本: ${(hintText || "（无文本，可能为扫描版，建议用 read_page 或让用户 OCR）").slice(0, 800)}`
			: "";
		const ocrNote = docText.isScanned
			? docText.ocrCount > 0
				? `\n注意: 本文档为扫描版，正文来自 OCR（已识别 ${docText.ocrCount} 页），可能存在识别误差。`
				: "\n注意: 本文档为扫描版且尚未 OCR，正文可能为空。请提示用户点击「OCR 本页 / OCR 全书」。"
			: "";

		const systemPrompt = `你是 AgentReader 文档助手。基于以下书籍上下文回答，必要时可调用工具进一步检索。

书籍: ${docText.title} (${docText.ext}, 共${docText.numPages}页/章)${ocrNote}
目录:
${tocStr}
${currentPageHint ? `\n${currentPageHint}` : ""}
可用工具: get_document_info, search_document, read_page。若引用不足，请调用 search_document 检索相关段落再回答。保持简洁、准确。`;

		const messages = [...history, { role: "user", content: prompt }];
		console.log(
			"[chat] messages",
			messages.map((m) => `${m.role}: ${String(m.content).slice(0, 120)}`),
		);

		console.log("[chat] request", {
			model: modelRef(model),
			historyLen: history.length,
			title: docText.title,
		});

		const tools = [
			{
				name: "get_document_info",
				description: "获取书籍元信息、页数、目录",
				parameters: { type: "object", properties: {}, required: [] },
				execute: async () =>
					JSON.stringify({
						title: docText.title,
						ext: docText.ext,
						totalPages: docText.numPages,
						toc: docText.toc.slice(0, 20),
					}),
			},
			{
				name: "search_document",
				description: "在全书中搜索关键词，返回相关段落与页码（按命中次数排序）",
				parameters: {
					type: "object",
					properties: { query: { type: "string" }, limit: { type: "number" } },
					required: ["query"],
				},
				execute: async (params: unknown) => {
					const { query, limit = 5 } = params as { query: string; limit?: number };
					const q = String(query ?? "")
						.trim()
						.toLowerCase();
					if (!q) return JSON.stringify({ hint: "查询为空" });
					const max = Math.max(1, Math.min(20, Number(limit) || 5));
					const terms = q.split(/\s+/).filter(Boolean);
					const byPage = new Map<number, { page: number; count: number; snippets: string[] }>();

					const record = (pageNo: number, positions: number[], text: string) => {
						const h = byPage.get(pageNo) ?? { page: pageNo, count: 0, snippets: [] };
						h.count += positions.length;
						for (const idx of positions) {
							if (h.snippets.length >= 3) break;
							const snippet = text
								.slice(Math.max(0, idx - 120), idx + 280)
								.replace(/\s+/g, " ")
								.trim();
							if (snippet && !h.snippets.includes(snippet)) h.snippets.push(snippet);
						}
						byPage.set(pageNo, h);
					};

					// Lazy per-page text: covers the whole book, not just the eagerly loaded pages.
					for (let n = 1; n <= docText.numPages; n++) {
						const text = await docText.getPage(n);
						if (!text) continue;
						const lower = text.toLowerCase();
						const positions: number[] = [];
						let from = 0;
						for (;;) {
							const idx = lower.indexOf(q, from);
							if (idx === -1) break;
							positions.push(idx);
							from = idx + q.length;
						}
						if (positions.length) {
							record(n, positions, text);
							continue;
						}
						// Multi-term fallback: all terms present (handles spacing / plural / line breaks).
						if (terms.length > 1 && terms.every((t) => lower.includes(t))) {
							record(n, [Math.max(0, lower.indexOf(terms[0]))], text);
						}
					}

					const results = [...byPage.values()]
						.sort((a, b) => b.count - a.count || a.page - b.page)
						.slice(0, max);
					if (results.length === 0) return JSON.stringify({ hint: "未找到相关段落", query });
					return JSON.stringify({
						query,
						matchedPages: byPage.size,
						totalPages: docText.numPages,
						results,
					});
				},
			},
			{
				name: "read_page",
				description: "读取指定页/章的文本",
				parameters: {
					type: "object",
					properties: { page: { type: "number" } },
					required: ["page"],
				},
				execute: async (params: unknown) => {
					const { page } = params as { page: number };
					const n = Math.max(1, Math.min(docText.numPages || 1, Number(page) || 1));
					return (await docText.getPage(n)) || "该页无文本";
				},
			},
		];

		const win = BrowserWindow.fromWebContents(event.sender);
		let full = "";
		const streamFn: StreamFn = (m, c, o) => runtime.stream(m, c, { ...o, sessionId: convId });

		// 结构化记录本轮对话（思考 / 工具调用 / 最终回答），用于持久化与回放。
		type StoredTimelineItem =
			| { kind: "reasoning"; content: string }
			| { kind: "tool"; id: string; name: string; args: string; result?: string; pending: boolean };
		const timeline: StoredTimelineItem[] = [];
		let timelineReasoning: Extract<StoredTimelineItem, { kind: "reasoning" }> | null = null;
		const pushReasoning = (delta: string) => {
			if (!timelineReasoning) {
				timelineReasoning = { kind: "reasoning", content: "" };
				timeline.push(timelineReasoning);
			}
			timelineReasoning.content += delta;
		};
		const persistAssistant = () => {
			if (!full && timeline.length === 0) return;
			appendFileSync(
				chatFile(docId, convId),
				`${JSON.stringify({
					id: randomUUID(),
					timestamp: Date.now(),
					role: "assistant",
					content: full,
					timeline,
				})}\n`,
			);
		};

		let lastError: string | null = null;
		try {
			for await (const evt of runAgentLoop(
				messages as never,
				model as never,
				streamFn as never,
				{ systemPrompt, tools } as never,
			)) {
				if (evt.type === "message_delta") {
					full += (evt as { delta: string }).delta;
					win?.webContents.send("chat:delta", (evt as { delta: string }).delta);
				} else if (evt.type === "reasoning_delta") {
					const delta = (evt as { delta: string }).delta;
					pushReasoning(delta);
					win?.webContents.send("chat:reasoning_delta", delta);
				} else if (evt.type === "tool_call") {
					const t = evt as { id: string; name: string; args: string };
					timeline.push({ kind: "tool", id: t.id, name: t.name, args: t.args, pending: true });
					win?.webContents.send("chat:tool_call", { id: t.id, name: t.name, args: t.args });
					console.log("[tool] call", t.name, t.args);
				} else if (evt.type === "tool_result") {
					const r = evt as { id: string; name?: string; result: string };
					const item = timeline.find((it) => it.kind === "tool" && it.id === r.id) as
						| Extract<StoredTimelineItem, { kind: "tool" }>
						| undefined;
					if (item) {
						item.result = r.result;
						item.pending = false;
					}
					win?.webContents.send("chat:tool_result", {
						id: r.id,
						name: r.name ?? item?.name ?? "",
						result: r.result,
					});
					console.log("[tool] result", r.id, r.result.slice(0, 200));
				} else if (evt.type === "done") {
					const d = evt as { stopReason: string; error?: string };
					console.log("[chat] agent done", d);
					if (d.stopReason === "error") {
						lastError = d.error || "unknown";
						console.error("[chat] agent error", JSON.stringify(d));
					}
				}
			}
			if (lastError) {
				console.error("[chat] final error", lastError);
				console.log("[chat] retry without tools");
				full = "";
				try {
					const fallbackStream = streamFn;
					const fallbackContext = {
						systemPrompt,
						messages: [...history, { role: "user", content: prompt }] as never,
					};
					for await (const e of fallbackStream(model, fallbackContext as never, {} as never)) {
						if (e.type === "text_delta") {
							full += (e as { delta: string }).delta;
							win?.webContents.send("chat:delta", (e as { delta: string }).delta);
						} else if (e.type === "reasoning_delta") {
							const delta = (e as { delta: string }).delta;
							pushReasoning(delta);
							win?.webContents.send("chat:reasoning_delta", delta);
						} else if (e.type === "done" && (e as { stopReason: string }).stopReason === "error") {
							return { error: (e as { error?: string }).error || lastError };
						}
					}
					persistAssistant();
					win?.webContents.send("chat:done", full);
					return { ok: true, content: full, title: generatedTitle ?? undefined };
				} catch (e) {
					console.error("[chat] fallback error", e);
					return { error: lastError };
				}
			}
			persistAssistant();
			win?.webContents.send("chat:done", full);
			return { ok: true, content: full, title: generatedTitle ?? undefined };
		} catch (e) {
			console.error("[chat] fetch error", e);
			persistAssistant();
			return { error: String(e) };
		}
	},
);

function createWindow() {
	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		webPreferences: {
			preload: join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	// Dev: talk to the Vite server. Packaged: load the bundled renderer over file://.
	// main.js lives in dist-electron/, the renderer bundle in dist/.
	if (app.isPackaged) {
		win
			.loadFile(join(__dirname, "../dist/index.html"))
			.catch((e) => console.error("load failed", e));
	} else {
		win.loadURL("http://localhost:5173").catch(() => {
			setTimeout(() => win.loadURL("http://localhost:5173").catch(() => {}), 1000);
		});
	}
	win.webContents.on("did-fail-load", (_e, code, desc, url) => {
		console.error("load failed", code, desc, url);
	});
}

app.whenReady().then(() => {
	// Seed models.json on first run, migrating the legacy single-provider settings
	// (and moving its encrypted key into the auth store) when present.
	const legacy = readSettings();
	const created = ensureConfig({ baseUrl: legacy.baseUrl, model: legacy.model });
	if (created && legacy.apiKey) setProviderKey("legacy", legacy.apiKey);
	createWindow();
});
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
