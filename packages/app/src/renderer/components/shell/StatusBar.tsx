import { Icon } from "../Icons.tsx";
import type { DocMeta } from "../../types.ts";

type OcrStatus = { page: number; total: number; progress: number } | null;

type Props = {
	doc: DocMeta | null;
	page: number;
	total: number;
	zoom: number;
	selectionLabel?: string | null;
	ocr: OcrStatus;
	model?: string;
	chatOpen: boolean;
	onToggleChat: () => void;
};

export function StatusBar({ doc, page, total, zoom, selectionLabel, ocr, model, chatOpen, onToggleChat }: Props) {
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

			{model && (
				<span className="status-item" title="当前 AI 模型">
					<Icon name="sparkle" size={12} />
					{model}
				</span>
			)}
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
