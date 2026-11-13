import { useEffect, useState } from "react";
import {
	DEFAULT_EXPORT_OPTIONS,
	type ExportFormat,
	type ExportOptions,
	type ExportResult,
	normalizeExportOptions,
} from "../../shared/chat-export.ts";
import { Icon } from "./Icons.tsx";

const STORAGE_KEY = "chat.export.options.v1";

type Props = {
	open: boolean;
	docId: string | null;
	convId: string | null;
	conversationTitle: string;
	documentTitle: string;
	messageCount: number;
	streaming: boolean;
	onClose: () => void;
	onExported: (result: Extract<ExportResult, { ok: true }>) => void;
};

const FORMATS: { id: ExportFormat; label: string; ext: string; hint: string }[] = [
	{ id: "md", label: "Markdown", ext: ".md", hint: "纯文本，方便继续编辑" },
	{ id: "html", label: "HTML", ext: ".html", hint: "单文件，浏览器直接打开" },
	{ id: "json", label: "JSON", ext: ".json", hint: "完整备份，含全部原始字段" },
];

function readSavedOptions(): ExportOptions {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULT_EXPORT_OPTIONS;
		return normalizeExportOptions(JSON.parse(raw) as Partial<ExportOptions>);
	} catch {
		return DEFAULT_EXPORT_OPTIONS;
	}
}

export function ExportDialog({
	open,
	docId,
	convId,
	conversationTitle,
	documentTitle,
	messageCount,
	streaming,
	onClose,
	onExported,
}: Props) {
	const [options, setOptions] = useState<ExportOptions>(readSavedOptions);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!open) return;
		setOptions(readSavedOptions());
		setBusy(false);
		setError("");
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !busy) onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, busy, onClose]);

	if (!open || !docId || !convId) return null;

	const update = (patch: Partial<ExportOptions>) => {
		setError("");
		setOptions((current) => ({ ...current, ...patch }));
	};
	const isJson = options.format === "json";
	const canSubmit = !busy && !streaming && messageCount > 0;

	const submit = async () => {
		if (!canSubmit) return;
		setBusy(true);
		setError("");
		try {
			const result = await window.api.exportChat({
				docId,
				convId,
				options: {
					...options,
					// JSON is a full backup; content toggles only affect md/html.
					includeRefs: isJson ? true : options.includeRefs,
					includeReasoning: isJson ? true : options.includeReasoning,
					includeTools: isJson ? true : options.includeTools,
					includeToolResults: isJson ? true : options.includeToolResults,
				},
			});
			if (result.ok) {
				try {
					localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
				} catch {}
				onExported(result);
				onClose();
			} else if (!result.canceled) {
				setError(result.error || "导出失败");
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="modal-backdrop">
			{/* biome-ignore lint/a11y/useSemanticElements: custom modal surface */}
			<div className="modal export-modal" role="dialog" aria-modal="true" aria-label="导出对话">
				<div className="modal-header">
					<Icon name="download" size={15} />
					<span className="modal-title">导出对话</span>
					<span className="spacer" />
					<button type="button" className="icon-btn" onClick={onClose} disabled={busy} title="关闭">
						<Icon name="close" size={14} />
					</button>
				</div>

				<div className="modal-body export-body">
					<p className="export-summary">
						导出「{conversationTitle || "当前对话"}」的 {messageCount} 条消息
						{documentTitle && <span className="export-summary-doc"> · {documentTitle}</span>}
					</p>

					<div className="export-field">
						<span className="export-label">文件格式</span>
						<div className="export-formats" role="radiogroup" aria-label="文件格式">
							{FORMATS.map((item) => (
								<label
									key={item.id}
									className={`export-format${options.format === item.id ? " active" : ""}`}
								>
									<input
										type="radio"
										name="export-format"
										value={item.id}
										checked={options.format === item.id}
										onChange={() => update({ format: item.id })}
									/>
									<span className="export-format-name">{item.label}</span>
									<span className="export-format-ext">{item.ext}</span>
									<span className="export-format-hint">{item.hint}</span>
								</label>
							))}
						</div>
					</div>

					<div className="export-field">
						<span className="export-label">
							包含内容
							{isJson && <span className="export-label-note">（JSON 始终包含完整内容）</span>}
						</span>
						<div className={`export-options${isJson ? " disabled" : ""}`}>
							<label className="export-check">
								<input
									type="checkbox"
									checked={options.includeRefs}
									disabled={isJson}
									onChange={(event) => update({ includeRefs: event.target.checked })}
								/>
								<span>
									引用与标注原文
									<em>用户消息顶部的引用块</em>
								</span>
							</label>
							<label className="export-check">
								<input
									type="checkbox"
									checked={options.includeReasoning}
									disabled={isJson}
									onChange={(event) => update({ includeReasoning: event.target.checked })}
								/>
								<span>
									思考过程
									<em>模型的 reasoning 段落</em>
								</span>
							</label>
							<label className="export-check">
								<input
									type="checkbox"
									checked={options.includeTools}
									disabled={isJson}
									onChange={(event) => update({ includeTools: event.target.checked })}
								/>
								<span>
									工具调用
									<em>工具名与参数</em>
								</span>
							</label>
							<label className="export-check">
								<input
									type="checkbox"
									checked={options.includeToolResults}
									disabled={isJson || !options.includeTools}
									onChange={(event) => update({ includeToolResults: event.target.checked })}
								/>
								<span>
									工具结果
									<em>单条截断到 4000 字</em>
								</span>
							</label>
						</div>
					</div>

					<label className="export-check export-open-after">
						<input
							type="checkbox"
							checked={options.openAfter}
							onChange={(event) => update({ openAfter: event.target.checked })}
						/>
						<span>导出后用系统默认应用打开</span>
					</label>

					{streaming && <div className="export-hint warn">回答生成中，结束后才能导出本轮。</div>}
					{messageCount === 0 && <div className="export-hint">这个对话还没有消息。</div>}
					{error && <div className="export-hint error">{error}</div>}
				</div>

				<div className="modal-footer">
					<button type="button" onClick={onClose} disabled={busy}>
						取消
					</button>
					<button
						type="button"
						className="primary"
						onClick={() => void submit()}
						disabled={!canSubmit}
					>
						{busy ? "正在导出…" : "导出…"}
					</button>
				</div>
			</div>
		</div>
	);
}
