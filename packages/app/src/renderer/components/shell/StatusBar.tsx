import { useEffect, useMemo, useRef, useState } from "react";
import { MOD_KEY } from "../../platform.ts";
import type { AiModelOption, DocMeta } from "../../types.ts";
import { formatTokens } from "../../tokens.ts";
import { Icon } from "../Icons.tsx";

type OcrStatus = { page: number; total: number; progress: number } | null;

/** 状态栏只关心「要不要让用户注意」，不重复设置页里的细节 */
export type SyncIndicator = {
	configured: boolean;
	state: "off" | "idle" | "syncing" | "error";
	conflicts: number;
	pending: number;
};

/** 状态栏只显示「值得注意」的更新状态，细节在设置页。 */
export type UpdateIndicator = {
	phase: "available" | "downloading" | "ready";
	version: string | null;
	skipped: boolean;
	percent: number | null;
};

type Props = {
	doc: DocMeta | null;
	page: number;
	total: number;
	zoom: number;
	selectionLabel?: string | null;
	ocr: OcrStatus;
	model?: string;
	models: AiModelOption[];
	onSelectModel: (ref: string) => void;
	chatOpen: boolean;
	onToggleChat: () => void;
	sync?: SyncIndicator;
	onOpenSync?: () => void;
	update?: UpdateIndicator;
	onOpenUpdate?: () => void;
};

export function StatusBar({
	doc,
	page,
	total,
	zoom,
	selectionLabel,
	ocr,
	model,
	models,
	onSelectModel,
	chatOpen,
	onToggleChat,
	sync,
	onOpenSync,
	update,
	onOpenUpdate,
}: Props) {
	const [pickerOpen, setPickerOpen] = useState(false);
	const pickerRef = useRef<HTMLSpanElement>(null);
	const current = models.find((m) => m.ref === model);

	useEffect(() => {
		if (!pickerOpen) return;
		const onDoc = (e: MouseEvent) => {
			if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [pickerOpen]);

	const grouped = useMemo(() => {
		const map = new Map<string, AiModelOption[]>();
		// Only list models whose provider is configured; unconfigured ones cannot run.
		for (const m of models) {
			if (!m.configured) continue;
			const list = map.get(m.provider) ?? [];
			list.push(m);
			map.set(m.provider, list);
		}
		return [...map.entries()];
	}, [models]);

	return (
		<footer className="statusbar">
			{doc ? (
				<>
					<span className="status-item status-accent">
						<Icon name={doc.ext === "epub" ? "book" : "file"} size={12} />
						{doc.title}
					</span>
					<span className="status-item">
						{/* EPUB is reflowable: no fixed page count, so report the chapter instead. */}
						{doc.ext === "epub" ? `第 ${page || 1} 章` : `${page} / ${total || "–"} 页`}
					</span>
					{/* EPUB is reflowable; its zoom is not controlled by the reader. */}
					{doc.ext !== "epub" && <span className="status-item">{Math.round(zoom * 100)}%</span>}
				</>
			) : (
				<span className="status-item status-accent">AgentReader</span>
			)}

			{selectionLabel && (
				<span className="status-item" title="当前引用将随下一条消息发送">
					<Icon name="annotations" size={12} />
					{selectionLabel}
				</span>
			)}

			{ocr && (
				<span className="status-item">
					<span className="status-dot busy" />
					OCR {ocr.page}/{ocr.total} · {Math.round(ocr.progress * 100)}%
				</span>
			)}

			<span className="status-spacer" />

			{update ? (
				<button
					type="button"
					className="status-item clickable"
					style={{ background: "none", border: "none", color: "inherit", font: "inherit", borderRadius: 0 }}
					onClick={onOpenUpdate}
					title={
						update.phase === "ready"
							? "新版本已下载，点击完成安装"
							: update.phase === "downloading"
								? "正在下载新版本"
								: `发现新版本 v${update.version ?? ""}`
					}
				>
					<Icon name="download" size={12} />
					{update.phase === "ready"
						? "可重启更新"
						: update.phase === "downloading"
							? `下载中 ${Math.floor(update.percent ?? 0)}%`
							: `可更新 v${update.version ?? ""}`}
				</button>
			) : null}

		{sync?.configured ? (
			<button
				type="button"
				className="status-item clickable"
				style={{ background: "none", border: "none", color: "inherit", font: "inherit", borderRadius: 0 }}
				onClick={onOpenSync}
				title={
					sync.conflicts > 0
						? `${sync.conflicts} 条同步冲突待处理`
						: sync.state === "syncing"
							? "正在同步"
							: sync.state === "error"
								? "同步出错，点击查看"
								: "云同步"
				}
			>
				<Icon name="cloud" size={12} />
				{sync.conflicts > 0
					? `${sync.conflicts} 条冲突`
					: sync.state === "syncing"
						? "同步中…"
						: sync.state === "error"
							? "同步出错"
							: sync.pending > 0
								? "待同步"
								: "已同步"}
			</button>
		) : null}

			<span className="status-model" ref={pickerRef}>
				<button
					type="button"
					className="status-item clickable status-model-btn"
					onClick={() => setPickerOpen((v) => !v)}
					disabled={models.length === 0}
					title={model ? `当前模型：${model}` : "选择模型"}
				>
					<Icon name="sparkle" size={12} />
					{current?.label ?? model ?? "未配置模型"}
					{!current?.configured && current ? "（未配置 Key）" : ""}
				</button>
				{pickerOpen && (
					<div className="model-picker">
						{grouped.map(([provider, list]) => (
							<div key={provider} className="model-picker-group">
								<div className="model-picker-header">{provider}</div>
								{list.map((m) => (
									<button
										type="button"
										key={m.ref}
										className={`model-picker-item${m.ref === model ? " active" : ""}`}
										onClick={() => {
											onSelectModel(m.ref);
											setPickerOpen(false);
										}}
									>
										<span>{m.label}</span>
										<span className="model-picker-ctx">{formatTokens(m.contextWindow)}</span>
										{!m.configured && <span className="model-picker-warn">未配置 Key</span>}
									</button>
								))}
							</div>
						))}
					</div>
				)}
			</span>
			<button
				type="button"
				className="status-item clickable"
				style={{ background: "none", border: "none", color: "inherit", font: "inherit", borderRadius: 0 }}
				onClick={onToggleChat}
				title={`切换 AI 对话面板 (${MOD_KEY}J)`}
			>
				<Icon name="chat" size={12} />
				{chatOpen ? "对话已开" : "对话"}
			</button>
		</footer>
	);
}
