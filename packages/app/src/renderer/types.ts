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

export type AiConfig = {
	path: string;
	text: string;
	errors: string[];
	defaultModel: string | null;
	providers: AiProviderSummary[];
	models: AiModelOption[];
};
