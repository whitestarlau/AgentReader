import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
	listLibrary: () => ipcRenderer.invoke("library:list"),
	importDoc: () => ipcRenderer.invoke("library:import"),
	removeDoc: (docId: string) => ipcRenderer.invoke("library:remove", docId),
	getAnnotations: (docId: string) => ipcRenderer.invoke("doc:annotations:get", docId),
	saveAnnotations: (docId: string, data: unknown) =>
		ipcRenderer.invoke("doc:annotations:save", docId, data),
	getOcr: (docId: string) => ipcRenderer.invoke("doc:ocr:get", docId),
	saveOcr: (docId: string, page: number, text: string) =>
		ipcRenderer.invoke("doc:ocr:save", docId, page, text),
	getDocPath: (docId: string) => ipcRenderer.invoke("doc:path", docId),
	readFile: (path: string) => ipcRenderer.invoke("doc:read", path),
	chat: (docId: string, convId: string, prompt: string, history: unknown, page?: number) =>
		ipcRenderer.invoke("chat:send", docId, convId, prompt, history, page),
	getChats: (docId: string, convId: string) => ipcRenderer.invoke("chat:list", docId, convId),
	appendChat: (docId: string, convId: string, entry: unknown) =>
		ipcRenderer.invoke("chat:append", docId, convId, entry),
	listConversations: (docId: string) => ipcRenderer.invoke("conversations:list", docId),
	createConversation: (docId: string, title?: string) =>
		ipcRenderer.invoke("conversations:create", docId, title),
	deleteConversation: (docId: string, convId: string) =>
		ipcRenderer.invoke("conversations:delete", docId, convId),
	renameConversation: (docId: string, convId: string, title: string) =>
		ipcRenderer.invoke("conversations:rename", docId, convId, title),
	getSettings: () => ipcRenderer.invoke("settings:get"),
	saveSettings: (s: unknown) => ipcRenderer.invoke("settings:save", s),
	getAiConfig: () => ipcRenderer.invoke("ai:config"),
	saveAiConfig: (text: string) => ipcRenderer.invoke("ai:config:save", text),
	openAiConfig: () => ipcRenderer.invoke("ai:config:open"),
	setModel: (ref: string) => ipcRenderer.invoke("ai:model:set", ref),
	setProviderKey: (providerId: string, key: string) =>
		ipcRenderer.invoke("ai:key:set", providerId, key),
	refreshModels: (providerId?: string) => ipcRenderer.invoke("ai:models:refresh", providerId),
	listCustomProviders: () => ipcRenderer.invoke("ai:custom:list"),
	saveCustomProvider: (input: { id: string; name?: string; baseUrl: string; models: string[] }) =>
		ipcRenderer.invoke("ai:custom:save", input),
	removeCustomProvider: (id: string) => ipcRenderer.invoke("ai:custom:remove", id),
	setWebSearch: (patch: { enabled?: boolean; backend?: string; maxResults?: number }) =>
		ipcRenderer.invoke("ai:websearch:set", patch),
	testWebSearch: (query?: string) => ipcRenderer.invoke("ai:websearch:test", query),
	listSkills: () => ipcRenderer.invoke("skills:list"),
	importSkill: () => ipcRenderer.invoke("skills:import"),
	deleteSkill: (name: string) => ipcRenderer.invoke("skills:delete", name),
	getDocSkills: (docId: string) => ipcRenderer.invoke("skills:doc:get", docId),
	setDocSkills: (docId: string, enabled: string[]) =>
		ipcRenderer.invoke("skills:doc:set", docId, enabled),
	getReading: (docId: string) => ipcRenderer.invoke("reading:get", docId),
	saveReading: (docId: string, patch: unknown) => ipcRenderer.invoke("reading:save", docId, patch),
	onChatDelta: (cb: (d: string) => void) => {
		const h = (_e: unknown, d: string) => cb(d);
		ipcRenderer.on("chat:delta", h);
		return () => ipcRenderer.removeListener("chat:delta", h);
	},
	onChatReasoning: (cb: (d: string) => void) => {
		const h = (_e: unknown, d: string) => cb(d);
		ipcRenderer.on("chat:reasoning_delta", h);
		return () => ipcRenderer.removeListener("chat:reasoning_delta", h);
	},
	onChatDone: (cb: (d: string) => void) => {
		const h = (_e: unknown, d: string) => cb(d);
		ipcRenderer.on("chat:done", h);
		return () => ipcRenderer.removeListener("chat:done", h);
	},
	onToolCall: (cb: (d: unknown) => void) => {
		const h = (_e: unknown, d: unknown) => cb(d);
		ipcRenderer.on("chat:tool_call", h);
		return () => ipcRenderer.removeListener("chat:tool_call", h);
	},
	onToolResult: (cb: (d: unknown) => void) => {
		const h = (_e: unknown, d: unknown) => cb(d);
		ipcRenderer.on("chat:tool_result", h);
		return () => ipcRenderer.removeListener("chat:tool_result", h);
	},
});
