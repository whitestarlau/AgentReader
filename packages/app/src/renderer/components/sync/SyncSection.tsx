import { useCallback, useEffect, useMemo, useState } from "react";
import type { DocMeta } from "../../types.ts";
import type {
	RemoteBookInfo,
	SyncPresetInfo,
	SyncRunResult,
	SyncStatus,
} from "../../../shared/sync-types.ts";
import { Icon } from "../Icons.tsx";

/**
 * 设置页的「云同步」分区。
 *
 * 两种后端：本地文件夹（不需要凭据，用来验证链路）与 WebDAV（坚果云 / InfiniCLOUD / Koofr / 自建）。
 * 服务方差异全部来自预设表 —— 端点能不能改、要不要先生成应用密码、帮助页在哪，
 * 都由 `syncPresets()` 返回的元数据决定，界面不写死任何一家。
 */

function formatTime(ts?: number): string {
	if (!ts) return "从未";
	const date = new Date(ts);
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${hh}:${mm}`;
}

function describeRun(run: SyncRunResult): string {
	if (!run.ok) return run.error.title;
	const { pulled, pushed, requests, conflicts } = run.report;
	const parts = [pulled ? "拉取了远端改动" : "本地没有落后"];
	if (pushed) parts.push("已推送本机改动");
	parts.push(`本次 ${requests} 次请求`);
	if (conflicts.length) parts.push(`${conflicts.length} 条冲突`);
	return parts.join(" · ");
}

const fieldStyle = { display: "flex", gap: 8, alignItems: "center" } as const;

/** 冲突里存的是原始值：设置是纯字符串，文档记录是 JSON —— 都压成一眼能读的短文本。 */
function describeValue(raw?: string): string {
	if (raw === undefined) return "（已删除）";
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (parsed && typeof parsed === "object") {
			const text = parsed.text ?? parsed.content ?? parsed.title ?? parsed.page ?? parsed.value;
			if (text !== undefined) return String(text).slice(0, 24);
		}
	} catch {}
	return raw.slice(0, 24);
}

export function SyncSection() {
	const [status, setStatus] = useState<SyncStatus | null>(null);
	const [presets, setPresets] = useState<SyncPresetInfo[]>([]);
	const [providerId, setProviderId] = useState("local-folder");
	const [dir, setDir] = useState("");
	const [endpoint, setEndpoint] = useState("");
	const [account, setAccount] = useState("");
	const [secret, setSecret] = useState("");
	const [probeNote, setProbeNote] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [lastRun, setLastRun] = useState<SyncRunResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [localDocs, setLocalDocs] = useState<DocMeta[]>([]);
	const [remoteBooks, setRemoteBooks] = useState<RemoteBookInfo[]>([]);
	/** 每本书的权威同步状态（本地有没有原书），避免用旧的本地列表去过滤云端列表 */
	const [bookState, setBookState] = useState<Map<string, boolean>>(new Map());
	const [bookBusy, setBookBusy] = useState<string | null>(null);

	useEffect(() => {
		void window.api.syncStatus().then(setStatus);
		void window.api.syncPresets().then(setPresets);
		return window.api.onSyncStatus(setStatus);
	}, []);

	/** 三个来源一起刷新：本地书库、云端原书、每本书的权威状态。 */
	const refreshBooks = useCallback(async () => {
		const [list, remote, states] = await Promise.all([
			window.api.listLibrary(),
			window.api.syncBooksList(),
			window.api.syncLibraryState(),
		]);
		setLocalDocs(list);
		setRemoteBooks(remote.remote);
		setBookState(new Map(states.map((entry) => [entry.docId, entry.localOriginal])));
	}, []);

	// 每次进入设置页都重新拉一次：别的地方（书架删除、另一台设备）可能已经改过书库
	useEffect(() => {
		if (!status?.configured) return;
		void refreshBooks();
	}, [status?.configured, refreshBooks]);

	async function uploadBook(docId: string) {
		setBookBusy(docId);
		setError(null);
		try {
			const result = await window.api.syncBookUpload(docId);
			if (!result.ok) setError(result.error.detail || result.error.title);
			await refreshBooks();
		} finally {
			setBookBusy(null);
		}
	}

	async function downloadBook(docId: string) {
		setBookBusy(docId);
		setError(null);
		try {
			const result = await window.api.syncBookDownload(docId);
			if (!result.ok) setError(result.error.detail || result.error.title);
			await refreshBooks();
		} finally {
			setBookBusy(null);
		}
	}

	const preset = useMemo(
		() => presets.find((entry) => entry.id === providerId),
		[presets, providerId],
	);
	const isWebdav = providerId !== "local-folder";
	const needsAppPassword = preset?.authKind === "app-password";

	async function pick() {
		const picked = await window.api.syncPickDirectory();
		if (picked) {
			setDir(picked);
			setError(null);
		}
	}

	async function readClipboard() {
		const text = await window.api.syncReadClipboard();
		if (text) {
			setSecret(text);
			setError(null);
		} else {
			setError("剪贴板里没有可用的文本（请先复制应用密码）");
		}
	}

	async function probe() {
		if (!preset) return;
		setBusy(true);
		setProbeNote("正在向服务方查询你的 WebDAV 地址…");
		try {
			const result = await window.api.syncProbe({
				presetId: preset.id,
				account,
				secret,
			});
			if (result.ok) {
				setEndpoint(result.webdavUrl);
				setProbeNote(`已识别：${result.webdavUrl}`);
			} else {
				setProbeNote(result.message);
			}
		} finally {
			setBusy(false);
		}
	}

	async function connect() {
		setBusy(true);
		setError(null);
		try {
			const result = await window.api.syncConfigure(
				isWebdav
					? {
							backendId: "webdav",
							presetId: providerId,
							endpoint: endpoint || preset?.endpoint || "",
							account,
							secret,
						}
					: { backendId: "local-folder", endpoint: dir, rootName: "AgentReader" },
			);
			if (!result.ok) setError(result.error.detail || result.error.title);
			setStatus(await window.api.syncStatus());
		} finally {
			setBusy(false);
		}
	}

	async function syncNow() {
		setBusy(true);
		setError(null);
		try {
			const run = await window.api.syncNow();
			setLastRun(run);
			if (!run.ok) setError(run.error.detail || run.error.title);
			setStatus(await window.api.syncStatus());
		} finally {
			setBusy(false);
		}
	}

	async function resolve(id: string, choice: "local" | "remote") {
		setBusy(true);
		setError(null);
		try {
			const result = await window.api.syncResolve(id, choice);
			if (result.ok) setStatus(result.status);
			else setError(result.error.detail || result.error.title);
		} finally {
			setBusy(false);
		}
	}

	async function disconnect() {
		setBusy(true);
		try {
			setStatus(await window.api.syncDisconnect());
			setLastRun(null);
		} finally {
			setBusy(false);
		}
	}

	if (!status) {
		return (
			<section className="settings-card">
				<header className="settings-card-head">
					<div className="settings-card-heading">
						<h4>云同步</h4>
					</div>
				</header>
				<div className="settings-card-body">正在读取同步状态…</div>
			</section>
		);
	}

	const configured = status.configured && status.backend !== null;
	const pendingLabel = status.pending.settings
		? "设置有改动待推送"
		: status.pending.docs.length > 0
			? `${status.pending.docs.length} 本书有改动待推送`
			: "没有待同步的改动";

	return (
		<section className="settings-card">
			<header className="settings-card-head">
				<div className="settings-card-heading">
					<h4>云同步</h4>
					<div className="settings-card-desc">
						同步阅读进度、笔记与应用设置。数据留在你自己的云盘里，不经过任何服务器。
					</div>
				</div>
				<div className="settings-card-actions">
					{configured ? (
						<>
							<button type="button" onClick={disconnect} disabled={busy}>
								断开
							</button>
							<button
								type="button"
								className="primary"
								onClick={syncNow}
								disabled={busy || status.state === "syncing"}
							>
								{status.state === "syncing" ? "同步中…" : "立即同步"}
							</button>
						</>
					) : null}
				</div>
			</header>

			<div className="settings-card-body">
				{configured ? (
					<>
						<div className="settings-field">
							<div className="settings-label">
								<span className="settings-label-text">状态</span>
							</div>
							<div className="settings-control">
								<div style={fieldStyle}>
									<Icon name="cloud" size={13} />
									<span>
										{status.state === "syncing"
											? "正在同步…"
											: status.state === "error"
												? "同步出错"
												: "已连接"}
									</span>
									<span className="settings-hint">
										· {status.backend?.label} · {status.backend?.endpoint}
									</span>
								</div>
								<div className="settings-hint">
									上次同步：{formatTime(status.lastSyncAt)} · {pendingLabel} · 凭据：
									{status.secretState === "encrypted"
										? "已加密保存"
										: status.secretState === "plain"
											? "仅 base64（系统钥匙串不可用）"
											: "无需凭据"}
								</div>
							</div>
						</div>

						<div className="settings-field">
							<div className="settings-label">
								<span className="settings-label-text">同步内容</span>
							</div>
							<div className="settings-control">
								<div className="settings-hint">
									设置（已启用）· 笔记（下一阶段）· 原书（下一阶段，默认关闭）
								</div>
							</div>
						</div>

						{status.conflicts.length > 0 ? (
							<div className="settings-field">
								<div className="settings-label">
									<span className="settings-label-text">冲突</span>
									<span className="settings-label-hint">{status.conflicts.length} 条待处理</span>
								</div>
								<div className="settings-control">
									<div className="settings-hint">
										两台设备改了同一处。默认保留内容、不静默覆盖，请逐条决定。
									</div>
									<ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0" }}>
										{status.conflicts.map((conflict) => (
											<li
												key={conflict.id}
												style={{
													display: "flex",
													alignItems: "center",
													gap: 8,
													padding: "4px 0",
													borderTop: "1px solid rgba(255,255,255,0.06)",
												}}
											>
												<span style={{ flex: 1 }}>{conflict.label}</span>
												<code
													title={conflict.local ?? "（本机已删除）"}
													style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
												>
													本机：{describeValue(conflict.local)}
												</code>
												<code
													title={conflict.remote ?? "（远端已删除）"}
													style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
												>
													远端：{describeValue(conflict.remote)}
												</code>
												<button type="button" disabled={busy} onClick={() => resolve(conflict.id, "local")}>
													用本机
												</button>
												<button type="button" disabled={busy} onClick={() => resolve(conflict.id, "remote")}>
													用远端
												</button>
											</li>
										))}
									</ul>
								</div>
							</div>
						) : null}

						<div className="settings-field">
							<div className="settings-label">
								<span className="settings-label-text">原书</span>
								<span className="settings-label-hint">默认不同步</span>
							</div>
							<div className="settings-control">
								<div className="settings-hint">
									笔记很小、原书很大：这里按需上传/下载，不参与每轮同步。云端 {remoteBooks.length} 本。
								</div>
								<ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0", maxHeight: 220, overflowY: "auto" }}>
									{localDocs.map((docMeta) => {
										const uploaded = bookState.has(docMeta.id) && remoteBooks.some((book) => book.docId === docMeta.id);
										return (
											<li key={docMeta.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
												<span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
													{docMeta.title}
												</span>
												<span className="settings-hint">{uploaded ? "已在云端" : ""}</span>
												<button
													type="button"
													disabled={bookBusy !== null || uploaded}
													onClick={() => uploadBook(docMeta.id)}
												>
													{bookBusy === docMeta.id ? "上传中…" : "上传"}
												</button>
											</li>
										);
									})}
									{remoteBooks
										.filter((book) => !bookState.get(book.docId))
										.map((book) => (
											<li key={book.docId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
												<span style={{ flex: 1 }}>
													{book.title ?? `云端书 ${book.docId.slice(0, 8)}`} · {book.ext} ·{" "}
													{(book.size / 1024 ** 2).toFixed(1)}MB
												</span>
												<button
													type="button"
													disabled={bookBusy !== null}
													onClick={() => downloadBook(book.docId)}
												>
													{bookBusy === book.docId ? "下载中…" : "下载"}
												</button>
											</li>
										))}
								</ul>
							</div>
						</div>

						{lastRun?.ok ? (
							<div className="settings-field">
								<div className="settings-label">
									<span className="settings-label-text">本次结果</span>
								</div>
								<div className="settings-control">
									<div className="settings-hint">{describeRun(lastRun)}</div>
								</div>
							</div>
						) : null}
					</>
				) : (
					<>
						<div className="settings-field">
							<div className="settings-label">
								<span className="settings-label-text">云盘</span>
							</div>
							<div className="settings-control">
								<select
									value={providerId}
									onChange={(event) => {
										setProviderId(event.target.value);
										setEndpoint("");
										setProbeNote(null);
										setError(null);
									}}
								>
									<option value="local-folder">本地文件夹（不联网，用于验证）</option>
									{presets.map((entry) => (
										<option key={entry.id} value={entry.id}>
											{entry.label} · {entry.quotaNote}
										</option>
									))}
								</select>
								{preset && preset.caveats.length > 0 ? (
									<div className="settings-hint">
										{preset.caveats.map((caveat) => (
											<div key={caveat}>· {caveat}</div>
										))}
									</div>
								) : null}
							</div>
						</div>

						{isWebdav ? (
							<>
								<div className="settings-field">
									<div className="settings-label">
										<span className="settings-label-text">服务器</span>
									</div>
									<div className="settings-control">
										{preset?.endpoint ? (
											<code>{preset.endpoint}</code>
										) : (
											<div style={fieldStyle}>
												<input
													style={{ flex: 1 }}
													value={endpoint}
													onChange={(event) => setEndpoint(event.target.value)}
													placeholder="https://your.host/dav/"
													spellCheck={false}
												/>
												{preset?.id === "infinicloud" ? (
													<button type="button" onClick={probe} disabled={busy || !account || !secret}>
														识别地址
													</button>
												) : null}
											</div>
										)}
										{probeNote ? <div className="settings-hint">{probeNote}</div> : null}
									</div>
								</div>

								<div className="settings-field">
									<div className="settings-label">
										<span className="settings-label-text">账号</span>
									</div>
									<div className="settings-control">
										<input
											value={account}
											onChange={(event) => setAccount(event.target.value)}
											placeholder="登录邮箱"
											spellCheck={false}
										/>
									</div>
								</div>

								<div className="settings-field">
									<div className="settings-label">
										<span className="settings-label-text">
											{needsAppPassword ? "应用密码" : "密码"}
										</span>
										<span className="settings-label-hint">
											{needsAppPassword ? "不是登录密码" : ""}
										</span>
									</div>
									<div className="settings-control">
										<div style={fieldStyle}>
											<input
												style={{ flex: 1 }}
												type="password"
												value={secret}
												onChange={(event) => setSecret(event.target.value)}
												placeholder={needsAppPassword ? "在服务方后台生成的应用密码" : "账号密码"}
											/>
											<button type="button" onClick={readClipboard} disabled={busy}>
												从剪贴板读取
											</button>
											{preset?.passwordHelpUrl ? (
												<>
													<button
														type="button"
														onClick={() =>
															window.api.syncOpenLogin(preset.id, preset.passwordHelpUrl ?? "")
														}
														title="在应用内打开服务方页面，登录后生成应用密码；关闭窗口即清空登录态"
													>
														去生成…
													</button>
													<button
														type="button"
														onClick={() => window.api.syncOpenExternal(preset.passwordHelpUrl ?? "")}
														title="用系统浏览器打开"
													>
														浏览器打开
													</button>
												</>
											) : null}
										</div>
									</div>
								</div>
							</>
						) : (
							<div className="settings-field">
								<div className="settings-label">
									<span className="settings-label-text">同步位置</span>
									<span className="settings-label-hint">选一个空目录</span>
								</div>
								<div className="settings-control">
									<div style={fieldStyle}>
										<code
											style={{
												flex: 1,
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap",
											}}
											title={dir || "尚未选择"}
										>
											{dir || "尚未选择目录"}
										</code>
										<button type="button" onClick={pick} disabled={busy}>
											选择…
										</button>
									</div>
									<div className="settings-hint">
										把两台机器（或本应用的两个实例）指向同一个目录，即可验证同步链路。
									</div>
								</div>
							</div>
						)}

						<div className="settings-field">
							<div className="settings-label">
								<span className="settings-label-text" />
							</div>
							<div className="settings-control">
								<button type="button" className="primary" onClick={connect} disabled={busy}>
									{busy ? "正在连接…" : "连接并同步"}
								</button>
							</div>
						</div>
					</>
				)}

				{error || status.lastError ? (
					<div className="settings-hint" style={{ padding: "0 12px 12px" }}>
						{status.lastError
							? `${status.lastError.title}：${status.lastError.detail}`
							: error}
					</div>
				) : null}
			</div>
		</section>
	);
}
