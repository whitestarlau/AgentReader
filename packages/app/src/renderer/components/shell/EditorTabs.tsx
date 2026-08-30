import type { ReactNode } from "react";
import { Icon } from "../Icons.tsx";
import type { DocMeta } from "../../types.ts";

type Props = {
	docs: DocMeta[];
	activeId: string | null;
	onActivate: (id: string) => void;
	onClose: (id: string) => void;
	actions?: ReactNode;
};

export function EditorTabs({ docs, activeId, onActivate, onClose, actions }: Props) {
	return (
		<div className="tabbar">
			<div className="tabs-scroll">
				{docs.map((d) => (
					<div
						key={d.id}
						className={`tab${activeId === d.id ? " active" : ""}`}
						onClick={() => onActivate(d.id)}
						onKeyDown={(e) => e.key === "Enter" && onActivate(d.id)}
						role="tab"
						aria-selected={activeId === d.id}
						tabIndex={0}
						title={d.title}
					>
						<span className="tab-dot" style={{ background: d.ext === "epub" ? "#c586c0" : "#e06c75" }} />
						<span className="tab-label">{d.title}</span>
						<button
							type="button"
							className="tab-close"
							title="关闭标签页"
							onClick={(e) => {
								e.stopPropagation();
								onClose(d.id);
							}}
						>
							<Icon name="close" size={12} />
						</button>
					</div>
				))}
			</div>
			{actions && <div className="tabbar-actions">{actions}</div>}
		</div>
	);
}
