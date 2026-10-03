import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { app } from "electron";

export type SkillInfo = { name: string; description: string; dir: string };

export function skillsRoot(): string {
	return join(app.getPath("userData"), "skills");
}

/** Split YAML frontmatter from a SKILL.md body. Only flat `key: value` pairs are needed. */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return { data: {}, body: normalized };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { data: {}, body: normalized };
	const yaml = normalized.slice(4, end);
	const body = normalized.slice(end + 4).replace(/^\n+/, "");
	const data: Record<string, string> = {};
	for (const line of yaml.split("\n")) {
		const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
		if (!m) continue;
		let value = m[2].trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		data[m[1]] = value;
	}
	return { data, body };
}

/** Coerce a display name into the `a-z0-9-` skill id. */
export function sanitizeSkillName(raw: string): string {
	const s = raw
		.toLowerCase()
		.trim()
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	return s.slice(0, 64) || "skill";
}

function loadSkillDir(dir: string): { skill?: SkillInfo; error?: string } {
	const label = basename(dir);
	const skillFile = join(dir, "SKILL.md");
	if (!existsSync(skillFile)) return { error: `${label}: 缺少 SKILL.md` };
	let text: string;
	try {
		text = readFileSync(skillFile, "utf-8");
	} catch {
		return { error: `${label}: SKILL.md 读取失败` };
	}
	const { data } = parseFrontmatter(text);
	const description = (data.description ?? "").trim();
	if (!description) return { error: `${label}: 缺少 description` };
	const name = sanitizeSkillName(data.name || label);
	return { skill: { name, description: description.slice(0, 1024), dir } };
}

export function loadSkills(): { skills: SkillInfo[]; diagnostics: string[] } {
	const root = skillsRoot();
	const skills: SkillInfo[] = [];
	const diagnostics: string[] = [];
	if (!existsSync(root)) return { skills, diagnostics };
	for (const entry of readdirSync(root)) {
		const dir = join(root, entry);
		try {
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		const { skill, error } = loadSkillDir(dir);
		if (skill) skills.push(skill);
		else if (error) diagnostics.push(error);
	}
	skills.sort((a, b) => a.name.localeCompare(b.name));
	return { skills, diagnostics };
}

/** Full instruction body (frontmatter stripped) for an installed skill. */
export function readSkillBody(name: string): string | undefined {
	const file = join(skillsRoot(), name, "SKILL.md");
	if (!existsSync(file)) return undefined;
	try {
		return parseFrontmatter(readFileSync(file, "utf-8")).body;
	} catch {
		return undefined;
	}
}

export function deleteSkill(name: string): boolean {
	const dir = join(skillsRoot(), name);
	if (!existsSync(dir)) return false;
	rmSync(dir, { recursive: true, force: true });
	return true;
}

function validateAfterImport(name: string): { ok: boolean; name?: string; error?: string } {
	const found = loadSkills().skills.find((s) => s.name === name);
	if (!found) {
		rmSync(join(skillsRoot(), name), { recursive: true, force: true });
		return { ok: false, error: "技能校验失败：缺少有效的 name/description" };
	}
	return { ok: true, name };
}

function importDirectory(src: string): { ok: boolean; name?: string; error?: string } {
	const skillFile = join(src, "SKILL.md");
	if (!existsSync(skillFile)) return { ok: false, error: "所选目录里没有 SKILL.md" };
	const { data } = parseFrontmatter(readFileSync(skillFile, "utf-8"));
	const name = sanitizeSkillName(data.name || basename(src));
	const dest = join(skillsRoot(), name);
	if (existsSync(dest)) return { ok: false, name, error: `已存在同名技能：${name}` };
	mkdirSync(skillsRoot(), { recursive: true });
	cpSync(src, dest, { recursive: true });
	return validateAfterImport(name);
}

function importMdFile(src: string): { ok: boolean; name?: string; error?: string } {
	let text: string;
	try {
		text = readFileSync(src, "utf-8");
	} catch {
		return { ok: false, error: "读取文件失败" };
	}
	const { data } = parseFrontmatter(text);
	if (!(data.description ?? "").trim()) {
		return { ok: false, error: "该 .md 缺少 frontmatter description，无法作为技能导入" };
	}
	const name = sanitizeSkillName(data.name || basename(src).replace(/\.md$/i, ""));
	const dest = join(skillsRoot(), name);
	if (existsSync(dest)) return { ok: false, name, error: `已存在同名技能：${name}` };
	mkdirSync(dest, { recursive: true });
	writeFileSync(join(dest, "SKILL.md"), text);
	return validateAfterImport(name);
}

async function importZip(src: string): Promise<{ ok: boolean; name?: string; error?: string }> {
	const JSZip = (await import("jszip")).default;
	const zip = await JSZip.loadAsync(readFileSync(src)).catch(() => null);
	if (!zip) return { ok: false, error: "zip 解析失败" };
	const files = Object.values(zip.files);
	const skillEntry = files.find(
		(f) => !f.dir && (f.name === "SKILL.md" || f.name.endsWith("/SKILL.md")),
	);
	if (!skillEntry) return { ok: false, error: "zip 里没有 SKILL.md" };
	const rootPrefix = skillEntry.name.includes("/")
		? skillEntry.name.slice(0, skillEntry.name.lastIndexOf("/") + 1)
		: "";
	const text = await skillEntry.async("string");
	const { data } = parseFrontmatter(text);
	const fallback = rootPrefix
		? (rootPrefix.replace(/\/$/, "").split("/").pop() ?? "skill")
		: basename(src).replace(/\.zip$/i, "");
	const name = sanitizeSkillName(data.name || fallback);
	const dest = join(skillsRoot(), name);
	if (existsSync(dest)) return { ok: false, name, error: `已存在同名技能：${name}` };
	mkdirSync(dest, { recursive: true });
	for (const file of files) {
		if (file.dir || !file.name.startsWith(rootPrefix)) continue;
		const rel = file.name.slice(rootPrefix.length);
		if (!rel || rel.includes("..")) continue;
		const target = join(dest, rel);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, await file.async("nodebuffer"));
	}
	return validateAfterImport(name);
}

export async function importSkillFromPath(
	src: string,
): Promise<{ ok: boolean; name?: string; error?: string }> {
	try {
		if (statSync(src).isDirectory()) return importDirectory(src);
	} catch {
		return { ok: false, error: "路径不存在" };
	}
	const lower = src.toLowerCase();
	if (lower.endsWith(".zip")) return importZip(src);
	if (lower.endsWith(".md")) return importMdFile(src);
	return { ok: false, error: "仅支持包含 SKILL.md 的目录、.md 文件或 .zip" };
}

export function readDocSkills(docDir: string): string[] {
	const p = join(docDir, "skills.json");
	if (!existsSync(p)) return [];
	try {
		const parsed = JSON.parse(readFileSync(p, "utf-8")) as { enabled?: unknown };
		if (!Array.isArray(parsed.enabled)) return [];
		return parsed.enabled.filter((x): x is string => typeof x === "string");
	} catch {
		return [];
	}
}

export function writeDocSkills(docDir: string, enabled: string[]): void {
	writeFileSync(join(docDir, "skills.json"), JSON.stringify({ enabled }, null, 2));
}
