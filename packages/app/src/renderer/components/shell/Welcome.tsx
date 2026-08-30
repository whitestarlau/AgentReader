import { Icon } from "../Icons.tsx";
import type { DocMeta } from "../../types.ts";

type Props = {
	docs: DocMeta[];
	onOpenDoc: (id: string) => void;
	onImport: () => void;
	onOpenSettings: () => void;
};

export function Welcome({ docs, onOpenDoc, onImport, onOpenSettings }: Props) {
	return (
		<div className="welcome">
			<div className="welcome-inner">
				<div className="welcome-logo">
					Agent<span>Reader</span>
				</div>
				<div className="welcome-sub">AI 文档阅读器 · 高亮 / 框选 / 对话</div>

				<div className="welcome-section-title">开始</div>
				<div className="welcome-list">
					<div
						className="welcome-item"
						onClick={onImport}
						onKeyDown={(e) => e.key === "Enter" && onImport()}
						role="button"
						tabIndex={0}
					>
						<Icon name="plus" size={15} />
						<span>导入 PDF / EPUB</span>
					</div>
					<div
						className="welcome-item"
						onClick={onOpenSettings}
						onKeyDown={(e) => e.key === "Enter" && onOpenSettings()}
						role="button"
						tabIndex={0}
					>
						<Icon name="settings" size={15} />
						<span>配置 AI 提供商</span>
						<span className="kbd-group">
							<span className="kbd">⌘,</span>
						</span>
					</div>
				</div>

				{docs.length > 0 && (
					<>
						<div className="welcome-section-title" style={{ marginTop: 24 }}>
							最近文档
						</div>
						<div className="welcome-list">
							{docs.slice(-6).reverse().map((d) => (
								<div
									key={d.id}
									className="welcome-item"
									onClick={() => onOpenDoc(d.id)}
									onKeyDown={(e) => e.key === "Enter" && onOpenDoc(d.id)}
									role="button"
									tabIndex={0}
								>
									<Icon name={d.ext === "epub" ? "book" : "file"} size={15} />
									<span className="row-label" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
										{d.title}
									</span>
								</div>
							))}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
