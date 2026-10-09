import { dialog, ipcMain } from "electron";
import { getDocDir } from "./paths.ts";
import { readSettings, updateSettings } from "./settings.ts";
import {
	deleteSkill,
	detectRuntimes,
	importSkillFromPath,
	loadSkills,
	readDocSkills,
	readTrusted,
	writeDocSkills,
	writeTrusted,
} from "./skills.ts";

/** IPC for the prompt/script skill library. */

export function registerSkillsIpc() {
	ipcMain.handle("skills:list", () => loadSkills());

	ipcMain.handle("skills:import", async () => {
		const { canceled, filePaths } = await dialog.showOpenDialog({
			properties: ["openFile", "openDirectory"],
			filters: [{ name: "Skill", extensions: ["md", "zip"] }],
		});
		if (canceled || !filePaths[0]) return { ok: false, canceled: true, skills: loadSkills() };
		const result = await importSkillFromPath(filePaths[0]);
		return { ...result, skills: loadSkills() };
	});

	ipcMain.handle("skills:delete", (_e, name: string) => {
		deleteSkill(name);
		return loadSkills();
	});

	ipcMain.handle("skills:doc:get", (_e, docId: string) => readDocSkills(getDocDir(docId)));

	ipcMain.handle("skills:doc:set", (_e, docId: string, enabled: string[]) => {
		const list = Array.isArray(enabled) ? enabled.filter((x) => typeof x === "string") : [];
		writeDocSkills(getDocDir(docId), list);
		return true;
	});

	ipcMain.handle("skills:trust:get", () => ({
		trusted: readTrusted(),
		executionEnabled: readSettings().skillsExecutionEnabled === "1",
	}));

	ipcMain.handle("skills:trust:set", (_e, name: string, trusted: boolean) => {
		const list = readTrusted();
		const next = trusted ? [...list, name] : list.filter((n) => n !== name);
		return writeTrusted(next);
	});

	ipcMain.handle("skills:execution:set", (_e, enabled: boolean) => {
		updateSettings({ skillsExecutionEnabled: enabled ? "1" : "0" });
		return true;
	});

	ipcMain.handle("skills:runtime", () => detectRuntimes());
}
