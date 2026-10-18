import { Icon } from "../Icons.tsx";
import { MOD_KEY } from "../../platform.ts";
import type { DocMeta } from "../../types.ts";

type Props = {
	doc: DocMeta | null;
	leftOpen: boolean;
	chatOpen: boolean;
	onToggleLeft: () => void;
	onToggleChat: () => void;
	onOpenSettings: () => void;
};

export function TitleBar({ doc, leftOpen, chatOpen, onToggleLeft, onToggleChat, onOpenSettings }: Props) {
	return (
		<header className="titlebar">
			<button
				type="button"
				className={`icon-btn${leftOpen ? " active" : ""}`}
				onClick={onToggleLeft}
				title={`切换主侧栏 (${MOD_KEY}B)`}
			>
				<Icon name="sidebarLeft" size={16} />
			</button>
			<div className="titlebar-brand">
				<span className="logo">
					<Icon name="book" size={12} />
				</span>
				<span>
					Agent<span className="brand-accent">Reader</span>
				</span>
			</div>
			<div className="titlebar-center">
				{doc ? (
					<>
						<strong>{doc.title}</strong> — AgentReader
					</>
				) : (
					"AgentReader"
				)}
			</div>
			<button
				type="button"
				className={`icon-btn${chatOpen ? " active" : ""}`}
				onClick={onToggleChat}
				title={`切换 AI 对话 (${MOD_KEY}J)`}
			>
				<Icon name="sidebarRight" size={16} />
			</button>
			<button type="button" className="icon-btn" onClick={onOpenSettings} title="设置">
				<Icon name="settings" size={16} />
			</button>
		</header>
	);
}
