import { useEffect, useMemo, useRef, useState } from "react";
import type { AiModelOption, DocMeta } from "../../types.ts";
import { Icon } from "../Icons.tsx";

type OcrStatus = { page: number; total: number; progress: number } | null;

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
						{doc.ext === "epub" && !total ? "页码生成中…" : `${page} / ${total || "–"} 页`}
					</span>
					<span className="status-item">{Math.round(zoom * 100)}%</span>
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
				title="切换 AI 对话面板 (⌘J)"
			>
				<Icon name="chat" size={12} />
				{chatOpen ? "对话已开" : "对话"}
			</button>
		</footer>
	);
}
