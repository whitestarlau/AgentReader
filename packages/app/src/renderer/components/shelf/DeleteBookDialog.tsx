import type { DocMeta } from "../../types.ts";
import type { ShelfDoc } from "../../shelf-state.ts";

/**
 * 删书确认。
 *
 * 之前这里只做了「删本地文件」，按钮却叫「删除」：用户删完发现云端还在、书架又冒出一条
 * 云端书，看起来就是功能失效。现在把范围摆到台面上：
 * - **删除本地与云端**（默认该选的那个）：原书、笔记、同步状态一起清掉；
 * - **仅移除此设备上的文件**：云端保留，书会变成「云端」条目 —— 不是复活，是它本来就还在。
 *
 * 没有云端副本的书只给一个「删除」，不制造多余选项。
 */
export function DeleteBookDialog({
	doc,
	busy,
	onCancel,
	onConfirm,
}: {
	doc: ShelfDoc | DocMeta;
	busy: boolean;
	onCancel: () => void;
	onConfirm: (scope: "everywhere" | "local") => void;
}) {
	const cloud = "cloud" in doc ? Boolean(doc.cloud) : false;
	const remote = "remote" in doc ? Boolean(doc.remote) : false;
	const hasCloudCopy = cloud || remote;

	return (
		<div className="modal-backdrop">
			{/* biome-ignore lint/a11y/useSemanticElements: 与项目里其它模态框一致的实现 */}
			<div className="modal" role="dialog" aria-modal="true" aria-label="删除书籍">
				<div className="modal-header">
					<span className="modal-title">删除《{doc.title}》</span>
				</div>
				<div className="modal-body">
					{hasCloudCopy ? (
						<p style={{ marginTop: 0, lineHeight: 1.7 }}>
							这本书在云端<strong>还有一份</strong>。选择「删除本地与云端」会把原书和笔记一起清掉；
							只删本地文件的话，它会以「云端」条目的形式留在书架上（换设备还能再拉回来）。
						</p>
					) : (
						<p style={{ marginTop: 0, lineHeight: 1.7 }}>
							将移除本机的原文件、标注与对话记录。这个操作不可撤销。
						</p>
					)}
				</div>
				<div className="modal-footer">
					<button type="button" onClick={onCancel} disabled={busy}>
						取消
					</button>
					{hasCloudCopy ? (
						<button type="button" onClick={() => onConfirm("local")} disabled={busy}>
							仅移除此设备上的文件
						</button>
					) : null}
					<button
						type="button"
						className="primary"
						onClick={() => onConfirm(hasCloudCopy ? "everywhere" : "local")}
						disabled={busy}
					>
						{busy ? "删除中…" : hasCloudCopy ? "删除本地与云端" : "删除"}
					</button>
				</div>
			</div>
		</div>
	);
}
