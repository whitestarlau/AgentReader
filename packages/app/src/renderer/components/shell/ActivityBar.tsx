import { Icon } from "../Icons.tsx";
import type { ActivityView } from "../../types.ts";

type Props = {
	view: ActivityView;
	sidebarOpen: boolean;
	secondaryOpen: boolean;
	annotationCount: number;
	onSelectView: (view: ActivityView) => void;
	onToggleChat: () => void;
	onOpenSettings: () => void;
};

export function ActivityBar({
	view,
	sidebarOpen,
	secondaryOpen,
	annotationCount,
	onSelectView,
	onToggleChat,
	onOpenSettings,
}: Props) {
	const item = (
		name: Parameters<typeof Icon>[0]["name"],
		title: string,
		active: boolean,
		onClick: () => void,
		badge?: number,
	) => (
		<button type="button" className={`activity-item${active ? " active" : ""}`} title={title} onClick={onClick}>
			<Icon name={name} size={24} strokeWidth={1.3} />
			{badge !== undefined && badge > 0 && <span className="activity-badge">{badge > 99 ? "99+" : badge}</span>}
		</button>
	);

	return (
		<nav className="activitybar" aria-label="活动栏">
			<div className="activitybar-top">
				{item("library", "图书馆 (⌘B)", sidebarOpen && view === "explorer", () => onSelectView("explorer"))}
				{item("search", "搜索文档", sidebarOpen && view === "search", () => onSelectView("search"))}
				{item("annotations", "标注", sidebarOpen && view === "annotations", () => onSelectView("annotations"), annotationCount)}
			</div>
			<div className="activitybar-bottom">
				{item("chat", "AI 对话 (⌘J)", secondaryOpen, onToggleChat)}
				{item("settings", "设置", false, onOpenSettings)}
			</div>
		</nav>
	);
}
