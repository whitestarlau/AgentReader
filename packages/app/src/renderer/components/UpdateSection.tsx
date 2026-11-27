import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { UpdateState } from "../../shared/update.ts";
import { formatBytes, formatDate, formatDateTime, formatSpeed } from "../format.ts";
import { Icon } from "./Icons.tsx";
import { Card, Field, Switch } from "./SettingsControls.tsx";

/**
 * 设置页的「软件更新」分区。
 *
 * 只渲染主进程推来的状态：检查/下载/安装的每次变化都会通过 `update:state` 到达，
 * 面板不需要自己轮询，也不判断「哪个文件是安装包」。
 */

const PLATFORM_LABEL: Record<UpdateState["platform"], string> = {
	mac: "macOS",
	win: "Windows",
	linux: "Linux",
};

const CHECKSUM_LABEL: Record<string, string> = {
	sha256: "SHA-256",
	size: "仅字节数",
	none: "未提供",
};

function describeIpcError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export function UpdateSection() {
	const [state, setState] = useState<UpdateState | null>(null);
	const [busy, setBusy] = useState(false);
	const [ipcError, setIpcError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		window.api
			.updateState()
			.then((next) => {
				if (alive) setState(next);
			})
			.catch((e: unknown) => {
				if (alive) setIpcError(describeIpcError(e));
			});
		const off = window.api.onUpdateState(setState);
		return () => {
			alive = false;
			off();
		};
	}, []);

	/** 所有动作都收敛到这一层：统一 busy/错误，避免按钮各写一套 try/catch。 */
	const run = useCallback(async (fn: () => Promise<UpdateState>) => {
		setBusy(true);
		setIpcError(null);
		try {
			setState(await fn());
		} catch (error) {
			setIpcError(describeIpcError(error));
		} finally {
			setBusy(false);
		}
	}, []);

	if (!state) {
		return (
			<Card title="软件更新">
				<div className="settings-card-body settings-hint">正在读取更新状态…</div>
			</Card>
		);
	}

	const { info, progress } = state;
	const checking = state.phase === "checking";
	const downloading = state.phase === "downloading";
	const installing = state.phase === "installing";
	const locked = busy || checking || downloading || installing;
	const asset = info?.asset ?? null;
	const notes = info?.notes?.trim() ?? "";
	const published = formatDate(info?.publishedAt);

	return (
		<>
			<Card
				title="当前版本"
				desc="检查 GitHub Releases 上当前平台是否有新版本，校验后下载并覆盖安装。"
				actions={
					<button
						type="button"
						className="primary"
						disabled={checking || installing}
						onClick={() => void run(() => window.api.updateCheck())}
					>
						{checking ? "检查中…" : "检查更新"}
					</button>
				}
			>
				<div className="settings-card-body update-current">
					<div className="update-version">
						<Icon name="book" size={14} />
						<strong>v{state.currentVersion}</strong>
						<span className="update-meta">
							{PLATFORM_LABEL[state.platform]} · {state.arch} · {state.repo}
						</span>
					</div>
					<div className="settings-hint">
						上次检查：{formatDateTime(state.checkedAt)}
						{state.autoCheck ? " · 已开启自动检查" : " · 自动检查已关闭"}
					</div>
				</div>

				{state.phase === "checking" && (
					<div className="update-status">
						<span className="update-spinner" /> 正在向 GitHub 查询最新 Release…
					</div>
				)}

				{state.phase === "up-to-date" && (
					<div className="update-status ok">
						<Icon name="check" size={13} /> 已是最新版本
						{info ? `（v${info.version}）` : ""}
					</div>
				)}

				{state.error && (
					<div className="update-error">
						<div className="update-error-message">
							<Icon name="close" size={13} /> {state.error.message}
						</div>
						{state.error.hint ? <div className="settings-hint">{state.error.hint}</div> : null}
						<div className="button-row">
							<button type="button" onClick={() => void run(() => window.api.updateCheck())}>
								重试检查
							</button>
							{info?.asset ? (
								<button
									type="button"
									disabled={locked}
									onClick={() =>
										void run(() => window.api.updateDownload({ force: true }))
									}
								>
									重新下载
								</button>
							) : null}
							<button type="button" onClick={() => void window.api.updateOpenRelease()}>
								打开发布页
							</button>
						</div>
					</div>
				)}

				{state.phase === "available" && info && (
					<div className="update-release">
						<div className="update-release-head">
							<div>
								<div className="update-release-title">
									新版本 v{info.version}
									{info.prerelease ? <span className="update-badge">预发布</span> : null}
									{state.skipped ? <span className="update-badge muted">已跳过</span> : null}
								</div>
								<div className="update-meta">
									{info.name !== info.tag ? `${info.name} · ` : ""}
									{published ? `${published} · ` : ""}
									{asset
										? `${asset.name} · ${formatBytes(asset.size)} · 校验 ${CHECKSUM_LABEL[info.checksum] ?? info.checksum}`
										: "当前平台没有可用安装包"}
								</div>
							</div>
						</div>

						{notes && (
							// Release 正文来自网络：交给 rehype-sanitize 清洗，禁止脚本/内联事件。
							<div className="update-notes markdown">
								<ReactMarkdown
									remarkPlugins={[remarkGfm]}
									rehypePlugins={[rehypeSanitize]}
									components={{
										a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
									}}
								>
									{notes}
								</ReactMarkdown>
							</div>
						)}

						{info.checksum === "size" && (
							<div className="settings-hint update-warn">
								该版本没有提供 SHA-256 摘要，只能校验下载字节数。介意的话请去发布页自行下载核对。
							</div>
						)}

						<div className="button-row">
							{asset ? (
								<>
									<button
										type="button"
										className="primary"
										disabled={locked}
										onClick={() =>
											void run(() => window.api.updateDownload({ install: true }))
										}
									>
										下载并安装
									</button>
									<button
										type="button"
										disabled={locked}
										onClick={() => void run(() => window.api.updateDownload())}
									>
										仅下载
									</button>
								</>
							) : null}
							<button type="button" disabled={locked} onClick={() => void run(() => window.api.updateSkip())}>
								{state.skipped ? "取消跳过" : "跳过此版本"}
							</button>
							<button type="button" onClick={() => void window.api.updateOpenRelease()}>
								打开发布页
							</button>
						</div>
					</div>
				)}

				{state.phase === "downloading" && progress && (
					<div className="update-release">
						<div className="update-release-title">正在下载 v{info?.version ?? ""}</div>
						<div className="update-progress">
							<div className="update-progress-bar">
								<span style={{ width: `${Math.max(1, progress.percent)}%` }} />
							</div>
							<span className="update-progress-label">
								{Math.floor(progress.percent)}% · {formatBytes(progress.received)} /{" "}
								{formatBytes(progress.total)}
								{formatSpeed(progress.bytesPerSecond)
									? ` · ${formatSpeed(progress.bytesPerSecond)}`
									: ""}
							</span>
						</div>
						<div className="button-row">
							<button type="button" onClick={() => void run(() => window.api.updateCancel())}>
								取消下载
							</button>
						</div>
					</div>
				)}

				{state.phase === "ready" && (
					<div className="update-release">
						<div className="update-release-title">
							<Icon name="check" size={13} /> v{info?.version ?? ""} 已下载
						</div>
						<div className="update-meta">{state.downloadPath ?? ""}</div>
						<div className="button-row">
							<button
								type="button"
								className="primary"
								disabled={locked}
								onClick={() => void run(() => window.api.updateInstall())}
							>
								安装并重启
							</button>
							<button type="button" onClick={() => void window.api.updateReveal()}>
								打开所在文件夹
							</button>
						</div>
						<div className="settings-hint">
							安装会替换当前应用并自动重启。macOS 若提示没有权限，会改为打开安装镜像让你手动拖拽。
						</div>
					</div>
				)}

				{state.phase === "installing" && (
					<div className="update-status">
						<span className="update-spinner" /> 正在安装，应用即将自动重启…
					</div>
				)}
			</Card>

			<Card title="自动检查" desc="安装包由 GitHub 分发；应用不上报任何使用信息。">
				<Field
					label="启动后自动检查"
					hint="启动 10 秒后检查一次，之后每 6 小时一次。"
				>
					<Switch
						label="启动后自动检查更新"
						checked={state.autoCheck}
						onChange={(next) => void run(() => window.api.updatePrefs({ autoCheck: next }))}
					/>
				</Field>
				<Field label="包含预发布版本" hint="预发布版可能不稳定，默认只跟正式版。">
					<Switch
						label="包含预发布版本"
						checked={state.includePrerelease}
						onChange={(next) =>
							void run(() => window.api.updatePrefs({ includePrerelease: next }))
						}
					/>
				</Field>
				<Field label="自动下载" hint="只在自动检查发现新版本时生效；安装始终需要你确认。">
					<Switch
						label="自动下载新版本"
						checked={state.autoDownload}
						onChange={(next) => void run(() => window.api.updatePrefs({ autoDownload: next }))}
					/>
				</Field>
				<div className="settings-hint update-footnote">
					未登录 GitHub API 时限流为每小时 60 次，因此自动检查间隔设为 6 小时。需要私有仓库或更高额度时，
					设置环境变量 <code>AGENTREADER_UPDATE_TOKEN</code>；镜像或 fork 可用{" "}
					<code>AGENTREADER_UPDATE_REPO=owner/repo</code> 指到别处。
				</div>
			</Card>

			{ipcError ? <div className="update-error">{ipcError}</div> : null}
		</>
	);
}
