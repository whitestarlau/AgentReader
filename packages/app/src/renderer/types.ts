export type SkillInfo = { name: string; description: string; dir: string };

export type SkillsPayload = { skills: SkillInfo[]; diagnostics: string[] };

export type SkillImportResult = {
	ok: boolean;
	canceled?: boolean;
	name?: string;
	error?: string;
	skills: SkillsPayload;
};

export type SkillTrustPayload = { trusted: string[]; executionEnabled: boolean };

export type SkillRuntimeInfo = { python: string | null; node: string };

export type PermissionDecision = "once" | "always" | "deny";

export type PermissionRequest = {
	id: string;
	kind: "skill_exec";
	skill: string;
	command: string;
	cwd: string;
	timeoutMs: number;
};

export type DocMeta = { id: string; title: string; ext?: string };

export type ActivityView = "explorer" | "search" | "annotations";

export type AiModelOption = {
	ref: string;
	id: string;
	provider: string;
	label: string;
	contextWindow: number;
	configured: boolean;
};

export type AiProviderSummary = {
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

export type CustomProvider = {
	name?: string;
	baseUrl: string;
	api: string;
	models: { id: string }[];
};

export type AiWebSearchConfig = {
	enabled: boolean;
	backend: string;
	maxResults: number;
	keySource: "config" | "env" | "stored" | null;
};

export type WebSearchTestResult = {
	ok: boolean;
	backend?: string;
	error?: string;
	results?: { title: string; url: string; snippet: string }[];
	text?: string;
};

export type AiConfig = {
	path: string;
	text: string;
	errors: string[];
	defaultModel: string | null;
	providers: AiProviderSummary[];
	webSearch: AiWebSearchConfig;
	models: AiModelOption[];
};
