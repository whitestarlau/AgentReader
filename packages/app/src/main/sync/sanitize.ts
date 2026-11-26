import type { SettingsState } from "./types.ts";

/**
 * 设置净化：决定一个 key 能不能进同步体。
 *
 * 判断标准不是「这个 key 重不重要」，而是三件事：
 *   1. 值是不是与机器绑定（绝对路径、已下载模型的状态）；
 *   2. 值是不是凭据（API Key、URL 里的 ?key=…）；
 *   3. 值是不是安全决策（信任白名单、权限「always」）。
 *
 * **规则是「剔除」而不是「掩码」。** 把 `?key=REAL` 打成 `?key=***` 再上传，
 * LWW 合并会把掩码值当成一次合法写入，覆盖对方机器上的真值，且用户看不出原因。
 */

/** 显式本机专属 key（与 settings.json 现有键名一一对应）。 */
const LOCAL_ONLY_KEYS = new Set([
	"apiKey", // 旧版单提供商密钥（现在存 auth.json，但老配置里可能残留）
	"deviceId", // 本机身份，由本机自己生成
	"ttsSherpaModelDir", // 本地模型绝对路径
	"ttsSherpaVocoder", // 同上
	"syncPassword", // 同步口令只存在本机 safeStorage 里
]);

const ABS_PATH_RE = /^(?:\/Users\/|\/home\/|\/Volumes\/|\/private\/|\/opt\/|[A-Za-z]:\\)/;
const URL_CRED_RE = /[?&](key|token|api[_-]?key|apikey|access_token|auth)=/i;
const SECRET_WORD_RE =
	/(^|_)(api_?key|apikey|secret|token|passw(or)?d|credential|bearer|auth)($|_)/;

/**
 * key 名里是否含凭据词。先把 `:`/`.`/`-` 归一成 `_`，再把驼峰拆开：
 * `webSearchApiKey`、`tts.api_key`、`apiKey` 都会命中，
 * 而 `ttsMaxChars`、`agentMaxTurns` 不会误伤。
 */
export function hasSecretWord(key: string): boolean {
	const normalized = key
		.replace(/[.:-]/g, "_")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase();
	return SECRET_WORD_RE.test(normalized);
}

export function classifySetting(key: string, value: string): "sync" | "local-only" {
	if (LOCAL_ONLY_KEYS.has(key)) return "local-only";
	if (hasSecretWord(key)) return "local-only";
	if (ABS_PATH_RE.test(value)) return "local-only";
	if (URL_CRED_RE.test(value)) return "local-only";
	return "sync";
}

export function emptySettingsState(): SettingsState {
	return { schema: 1, values: {}, mtimes: {}, tombstones: {} };
}

/** 剔除不可同步的 key；返回值里带上被剔除的名单，便于界面解释「为什么这项没同步」。 */
export function sanitizeSettingsState(state: SettingsState): {
	state: SettingsState;
	dropped: string[];
} {
	const out = emptySettingsState();
	const dropped: string[] = [];
	for (const [key, value] of Object.entries(state.values)) {
		if (classifySetting(key, value) === "local-only") {
			dropped.push(key);
			continue;
		}
		out.values[key] = value;
		const stamp = state.mtimes[key];
		if (stamp) out.mtimes[key] = stamp;
	}
	// 墓碑同样要净化：否则「删掉一个本机专属 key」会被当成同步事件推给别的机器
	for (const [key, stamp] of Object.entries(state.tombstones)) {
		if (LOCAL_ONLY_KEYS.has(key) || hasSecretWord(key)) continue;
		out.tombstones[key] = stamp;
	}
	return { state: out, dropped };
}

/**
 * 把同步回来的值合并进本机原始设置，**覆盖而非替换**。
 *
 * 直接 `writeFileSync(merged.values)` 会把 `ttsSherpaModelDir`、`apiKey` 这些
 * 本机专属 key 一起删掉——这是设置同步最容易犯、且最难在测试里发现的错误。
 */
export function overlaySyncedValues(
	raw: Record<string, string>,
	synced: Record<string, string>,
): Record<string, string> {
	const next: Record<string, string> = { ...raw };
	for (const [key, value] of Object.entries(synced)) {
		// 防御性再判一次：即使上游净化漏了，也不让凭据落到本机设置里
		if (classifySetting(key, value) === "local-only") continue;
		next[key] = value;
	}
	return next;
}

/**
 * 把一次合并结果完整应用到本机设置。
 *
 * 关键点：`merged` 是一份**完整状态**（不是增量），所以「同步 key 在 merged 里不存在」
 * 就等于「应该被删除」。只跳过本机专属 key——它们永远不该被同步逻辑删掉。
 *
 * 这里吃过一次亏：最初的实现只按墓碑删除，于是「远端删除了某项设置、且删除方没有留下
 * 墓碑」时，本机永远删不掉——用户会看到「另一台删了，这台还在」。墓碑只负责远端那一侧
 * 的判断，本机的落地只认「完整状态」。
 */
export function applyMergedSettings(
	raw: Record<string, string>,
	merged: SettingsState,
): Record<string, string> {
	const next: Record<string, string> = { ...raw };
	for (const key of Object.keys(next)) {
		if (classifySetting(key, next[key]) === "local-only") continue;
		if (!(key in merged.values)) delete next[key];
	}
	for (const [key, value] of Object.entries(merged.values)) {
		// 防御性再判一次：即使上游净化漏了，也不让凭据落到本机设置里
		if (classifySetting(key, value) === "local-only") continue;
		next[key] = value;
	}
	return next;
}
