import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "./types.ts";

export type SessionEntry = AgentMessage & { id: string; parentId?: string; timestamp: number };

export class SessionManager {
	private dir: string;

	constructor(dir: string) {
		this.dir = dir;
		mkdirSync(dir, { recursive: true });
	}

	get filePath() {
		return join(this.dir, "chats.jsonl");
	}

	append(entry: SessionEntry) {
		appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);
	}

	load(): SessionEntry[] {
		if (!existsSync(this.filePath)) return [];
		return readFileSync(this.filePath, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	}

	loadMessages(): AgentMessage[] {
		return this.load().map(({ id, parentId, timestamp, ...msg }) => msg);
	}
}
