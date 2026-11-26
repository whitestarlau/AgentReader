import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statfsSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type BackendConfig, type SyncBackend, SyncError } from "../backend.ts";
import type { RemoteEntry } from "../types.ts";

/**
 * 本地文件夹后端。
 *
 * 它不是产品功能，而是**测试替身**：用两个本地目录就能模拟两台机器，
 * 让「pull → merge → push」的全套逻辑在没有网络、没有配额、没有限流的条件下可测。
 *
 * 顺带它也真的有用：把同步根指到 iCloud Drive / OneDrive / 坚果云客户端的目录，
 * 就等于「白嫖」了这些网盘的客户端，零 API、零审核。
 */

const toPosix = (p: string): string => p.split(sep).join("/");

export function createLocalFolderBackend(
	opts: { root: string } & Partial<BackendConfig>,
): SyncBackend {
	const root = resolve(opts.root);

	const resolveInside = (path: string): string => {
		const clean = path.replace(/^\/+/, "");
		const segments = clean.split("/");
		if (segments.some((s) => s === "..")) {
			throw new SyncError("forbidden", 403, false, `路径越界：${path}`);
		}
		const abs = resolve(root, clean);
		if (abs !== root && !abs.startsWith(root + sep)) {
			throw new SyncError("forbidden", 403, false, `路径越界：${path}`);
		}
		return abs;
	};

	const etagOf = (abs: string): string => {
		const st = statSync(abs);
		return `${Math.floor(st.mtimeMs).toString(36)}-${st.size.toString(36)}`;
	};

	/** iCloud 的「优化存储空间」会把文件驱逐成 `.name.icloud` 占位符。 */
	const icloudPlaceholder = (abs: string): string =>
		join(dirname(abs), `.${abs.slice(abs.lastIndexOf(sep) + 1)}.icloud`);

	const walk = (absDir: string, out: RemoteEntry[]): void => {
		for (const name of readdirSync(absDir)) {
			// 跳过点文件：`.icloud` 占位符、`.DS_Store`、以及原子写留下的临时文件
			if (name.startsWith(".")) continue;
			const abs = join(absDir, name);
			const st = statSync(abs);
			if (st.isDirectory()) {
				out.push({ path: toPosix(relative(root, abs)), size: 0, isDir: true, mtime: st.mtimeMs });
				walk(abs, out);
				continue;
			}
			out.push({
				path: toPosix(relative(root, abs)),
				size: st.size,
				mtime: st.mtimeMs,
				etag: etagOf(abs),
			});
		}
	};

	const backend: SyncBackend = {
		id: "local-folder",
		label: "本地文件夹",
		caps: {
			conditionalWrite: true,
			maxObjectSize: 2 * 1024 * 1024 * 1024,
			requestBudgetPerMinute: 1_000_000,
			paginatedListLimit: 10_000,
		},

		async test() {
			try {
				mkdirSync(root, { recursive: true });
				const probe = join(root, `.probe-${process.pid}`);
				writeFileSync(probe, "ok");
				rmSync(probe, { force: true });
				let freeBytes: number | undefined;
				try {
					const st = statfsSync(root);
					freeBytes = st.bsize * st.bavail;
				} catch {}
				return { ok: true, freeBytes };
			} catch (e) {
				return {
					ok: false,
					error: {
						code: "forbidden",
						title: "无法写入该目录",
						detail: e instanceof Error ? e.message : String(e),
						retryable: false,
					},
				};
			}
		},

		async list(prefix: string) {
			const abs = resolveInside(prefix);
			if (!existsSync(abs)) return [];
			const st = statSync(abs);
			if (!st.isDirectory()) {
				throw new SyncError("conflict", 409, false, `不是目录：${prefix}`);
			}
			const out: RemoteEntry[] = [];
			walk(abs, out);
			return out;
		},

		async get(path: string) {
			const abs = resolveInside(path);
			if (existsSync(abs) && statSync(abs).isFile()) return readFileSync(abs);
			if (existsSync(icloudPlaceholder(abs))) {
				throw new SyncError(
					"not-found",
					404,
					true,
					"该文件被 iCloud「优化存储空间」驱逐成了占位符，请先在访达里下载后再同步",
				);
			}
			return null;
		},

		async put(path: string, data: Buffer, putOpts) {
			const abs = resolveInside(path);
			const exists = existsSync(abs);
			if (putOpts?.ifNoneMatch && exists) {
				throw new SyncError("conflict", 412, true, `对象已存在：${path}`);
			}
			if (putOpts?.ifMatch) {
				if (!exists) throw new SyncError("conflict", 412, true, `对象不存在：${path}`);
				const current = etagOf(abs);
				if (current !== putOpts.ifMatch) {
					throw new SyncError("conflict", 412, true, `远端已被修改：${path}`);
				}
			}
			if (data.length > backend.caps.maxObjectSize) {
				throw new SyncError("quota", 413, false, `对象超过单文件上限：${path}`);
			}
			mkdirSync(dirname(abs), { recursive: true });
			// 先写临时文件再 rename：保证读到的永远是完整文件，不会读到半截
			const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
			writeFileSync(tmp, data);
			renameSync(tmp, abs);
			return { etag: etagOf(abs) };
		},

		async del(path: string) {
			const abs = resolveInside(path);
			rmSync(abs, { recursive: true, force: true });
		},

		async mkdir(path: string) {
			mkdirSync(resolveInside(path), { recursive: true });
		},

		async move(from: string, to: string) {
			const src = resolveInside(from);
			const dst = resolveInside(to);
			mkdirSync(dirname(dst), { recursive: true });
			renameSync(src, dst);
		},

		async rmdir(path: string) {
			rmSync(resolveInside(path), { recursive: true, force: true });
		},
	};

	return backend;
}
