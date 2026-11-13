import type { ExportBundle } from "../../shared/chat-export.ts";

/** Full-fidelity backup: raw transcript rows, no truncation. */
export function renderJson(bundle: ExportBundle): string {
	return `${JSON.stringify(bundle, null, 2)}\n`;
}
