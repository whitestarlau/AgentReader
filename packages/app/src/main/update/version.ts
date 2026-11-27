/**
 * 版本号解析与比较。
 *
 * GitHub 的 tag 不受控制（`v0.3.0`、`0.4.0-beta.1`、`v1.2` 都可能出现），
 * 而 `semver` 这种依赖只为一次比较引入并不划算，所以这里实现一个够用的子集：
 * - 可选前导 `v`；
 * - 1–3 段数字（缺省补 0）；
 * - 预发布标识按 SemVer 2.0.0 比较（数字段 < 字母段，逐段比较）；
 * - `+build` 元数据忽略。
 *
 * 关键语义：**只做比较，不做安装决策**。发布方的 tag 解析失败时 `isNewer` 返回 false，
 * 宁可漏掉一次更新，也不让坏 tag 造成「永远有新版本」的循环提示；本机版本号解析失败
 * （开发版）则视为可更新。
 */

export type ParsedVersion = {
	raw: string;
	major: number;
	minor: number;
	patch: number;
	/** 预发布标识；稳定版为空数组。 */
	pre: (string | number)[];
};

const VERSION_RE =
	/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** 解析 tag / 版本号；不是版本号返回 null。 */
export function parseVersion(input: string): ParsedVersion | null {
	if (typeof input !== "string") return null;
	const text = input.trim().replace(/^[vV]/, "");
	const match = VERSION_RE.exec(text);
	if (!match) return null;
	const major = Number(match[1]);
	const minor = Number(match[2] ?? "0");
	const patch = Number(match[3] ?? "0");
	if (
		!Number.isSafeInteger(major) ||
		!Number.isSafeInteger(minor) ||
		!Number.isSafeInteger(patch)
	) {
		return null;
	}
	const pre = (match[4] ?? "")
		.split(".")
		.filter((part) => part.length > 0)
		.map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
	return { raw: input, major, minor, patch, pre };
}

/** 归一化展示：`v0.3.0` → `0.3.0`。无法解析时原样返回。 */
export function normalizeVersion(input: string): string {
	const parsed = parseVersion(input);
	return parsed ? formatVersion(parsed) : input.trim();
}

export function formatVersion(version: ParsedVersion): string {
	const core = `${version.major}.${version.minor}.${version.patch}`;
	return version.pre.length > 0 ? `${core}-${version.pre.join(".")}` : core;
}

/** SemVer 比较：a < b 返回负数，相等 0，a > b 正数。 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
	if (a.major !== b.major) return a.major < b.major ? -1 : 1;
	if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
	if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
	// 稳定版高于同号的预发布版。
	if (a.pre.length === 0 && b.pre.length === 0) return 0;
	if (a.pre.length === 0) return 1;
	if (b.pre.length === 0) return -1;
	return comparePre(a.pre, b.pre);
}

function comparePre(a: (string | number)[], b: (string | number)[]): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const x = a[i];
		const y = b[i];
		if (x === y) continue;
		const xNum = typeof x === "number";
		const yNum = typeof y === "number";
		// 数字标识的优先级低于字母标识。
		if (xNum && !yNum) return -1;
		if (!xNum && yNum) return 1;
		if (xNum && yNum) return (x as number) < (y as number) ? -1 : 1;
		return (x as string) < (y as string) ? -1 : 1;
	}
	// 前缀相同时，标识更多的版本更高（1.0.0-alpha < 1.0.0-alpha.1）。
	if (a.length === b.length) return 0;
	return a.length < b.length ? -1 : 1;
}

/** 比较两个版本字符串；任一无法解析返回 null。 */
export function compareVersionStrings(a: string, b: string): number | null {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (!left || !right) return null;
	return compareVersions(left, right);
}

/**
 * candidate 是否比 current 新。
 *
 * current 解析失败时返回 true：开发版（`0.0.0-dev`、`dev`）应当能收到正式版更新。
 * candidate 解析失败时返回 false：发布方的 tag 写坏了，不能据此弹「有新版本」。
 */
export function isNewer(candidate: string, current: string): boolean {
	const next = parseVersion(candidate);
	if (!next) return false;
	const cur = parseVersion(current);
	if (!cur) return true;
	return compareVersions(next, cur) > 0;
}
