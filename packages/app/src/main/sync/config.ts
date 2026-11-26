import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SyncScope } from "../../shared/sync-types.ts";
import { newDeviceId } from "./clock.ts";

/**
 * 同步后端的本地配置。
 *
 * 两个文件，职责刻意分开：
 * - `config.json`  —— 端点 / 账号 / 同步范围，明文，可读可改。
 * - `secrets.json` —— 密码 / PAT / OAuth token，经 safeStorage 加密。
 *
 * 两者都**不进同步体**：否则「同步设置」会把「同步用的凭据」也同步出去，形成自我指涉。
 * 这个文件从结构上就不在同步范围内，不靠过滤规则去排除。
 */

/** 注入式编码器：主进程传 safeStorage，单测传假实现。 */
export type SecretCodec = {
	readonly available: boolean;
	encrypt(plain: string): string;
	decrypt(cipher: string): string;
};

export type SyncBackendConfig = {
	id: string;
	label?: string;
	presetId?: string;
	/** WebDAV 根端点，已归一化（https、无 userinfo、带尾斜杠）。 */
	endpoint: string;
	account: string;
	/** 同步根目录名，默认 `AgentReader`。 */
	rootName: string;
};

export type { SyncScope };

export type SyncConfig = {
	version: 1;
	/** 用户是否已启用同步（未配置后端前为 false）。 */
	enabled: boolean;
	deviceId: string;
	backend: SyncBackendConfig | null;
	scope: SyncScope;
	lastSyncAt?: number;
};

export const DEFAULT_SCOPE: SyncScope = { settings: true, notes: true, books: false };

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** 宽容解析：坏字段回退默认值，绝不让一个畸形 config.json 把同步卡死。 */
export function normalizeConfig(raw: unknown): SyncConfig {
	const o = isRecord(raw) ? raw : {};
	const backendRaw = o.backend;
	const backend: SyncBackendConfig | null = isRecord(backendRaw)
		? {
				id: str(backendRaw.id),
				label: typeof backendRaw.label === "string" ? backendRaw.label : undefined,
				presetId: typeof backendRaw.presetId === "string" ? backendRaw.presetId : undefined,
				endpoint: str(backendRaw.endpoint),
				account: str(backendRaw.account),
				rootName: str(backendRaw.rootName, "AgentReader") || "AgentReader",
			}
		: null;
	const scopeRaw = isRecord(o.scope) ? o.scope : {};
	return {
		version: 1,
		enabled: o.enabled === true && backend !== null && backend.endpoint !== "",
		deviceId: str(o.deviceId) || newDeviceId(),
		backend: backend?.endpoint ? backend : null,
		scope: {
			settings: scopeRaw.settings !== false,
			notes: scopeRaw.notes !== false,
			books: scopeRaw.books === true,
		},
		lastSyncAt: typeof o.lastSyncAt === "number" ? o.lastSyncAt : undefined,
	};
}

function writeAtomic(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

export type ConfigStore = {
	readonly configFile: string;
	readonly secretsFile: string;
	read(): SyncConfig;
	/** 局部更新；`backend: null` 表示断开。 */
	patch(next: Partial<SyncConfig>): SyncConfig;
	readSecret(): string | null;
	writeSecret(secret: string | null): void;
	/** `none` 表示未保存；`plain` 表示当前环境没有可用的系统钥匙串（仅 base64，不加密）。 */
	secretState(): "none" | "encrypted" | "plain";
};

export function createConfigStore(opts: { dir: string; codec: SecretCodec }): ConfigStore {
	const configFile = join(opts.dir, "config.json");
	const secretsFile = join(opts.dir, "secrets.json");

	const readConfigFile = (): SyncConfig => {
		if (!existsSync(configFile)) return normalizeConfig({});
		try {
			return normalizeConfig(JSON.parse(readFileSync(configFile, "utf-8")));
		} catch {
			return normalizeConfig({});
		}
	};

	const readSecretsFile = (): { encrypted: boolean; value: string } | null => {
		if (!existsSync(secretsFile)) return null;
		try {
			const parsed = JSON.parse(readFileSync(secretsFile, "utf-8")) as unknown;
			if (!isRecord(parsed) || typeof parsed.value !== "string") return null;
			return { encrypted: parsed.encrypted === true, value: parsed.value };
		} catch {
			return null;
		}
	};

	return {
		configFile,
		secretsFile,
		read() {
			const config = readConfigFile();
			// 首次读取即固化 deviceId，避免每次启动都换一个身份
			if (!existsSync(configFile)) writeAtomic(configFile, JSON.stringify(config, null, 2));
			return config;
		},
		patch(next) {
			const merged: SyncConfig = { ...readConfigFile(), ...next };
			const normalized = normalizeConfig(merged);
			writeAtomic(configFile, JSON.stringify(normalized, null, 2));
			return normalized;
		},
		readSecret() {
			const stored = readSecretsFile();
			if (!stored) return null;
			if (!stored.encrypted) return Buffer.from(stored.value, "base64").toString("utf8");
			try {
				return opts.codec.decrypt(stored.value);
			} catch {
				// 换了机器 / 钥匙串条目丢失：解不开就当没有，让用户重填，而不是把密文当密码用
				return null;
			}
		},
		writeSecret(secret) {
			if (!secret) {
				rmSync(secretsFile, { force: true });
				return;
			}
			const payload = opts.codec.available
				? { version: 1, encrypted: true, value: opts.codec.encrypt(secret) }
				: {
						version: 1,
						encrypted: false,
						value: Buffer.from(secret, "utf8").toString("base64"),
					};
			writeAtomic(secretsFile, JSON.stringify(payload, null, 2));
		},
		secretState() {
			const stored = readSecretsFile();
			if (!stored) return "none";
			return stored.encrypted ? "encrypted" : "plain";
		},
	};
}
