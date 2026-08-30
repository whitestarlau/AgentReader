import { useEffect, useState } from "react";
import { Icon } from "./Icons.tsx";

export function Settings({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
	const [s, setS] = useState({ baseUrl: "", model: "", apiKey: "", ocrLang: "" });

	useEffect(() => {
		window.api.getSettings().then((v) =>
			setS({ baseUrl: v.baseUrl ?? "", model: v.model ?? "", apiKey: v.apiKey ?? "", ocrLang: v.ocrLang ?? "chi_sim+eng" }),
		);
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const save = async () => {
		await window.api.saveSettings(s);
		onSaved?.();
		onClose();
	};

	return (
		<div className="modal-backdrop">
			{/* biome-ignore lint/a11y/useSemanticElements: custom modal surface */}
			<div className="modal" role="dialog" aria-modal="true" aria-label="设置">
				<div className="modal-header">
					<Icon name="settings" size={15} />
					<span className="modal-title">设置</span>
					<span className="spacer" />
					<button type="button" className="icon-btn" onClick={onClose} title="关闭">
						<Icon name="close" size={14} />
					</button>
				</div>

				<div className="modal-body">
					<div className="field">
						<label htmlFor="s-baseurl">Base URL</label>
						<input id="s-baseurl" value={s.baseUrl} onChange={(e) => setS({ ...s, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
					</div>
					<div className="field">
						<label htmlFor="s-model">Model</label>
						<input id="s-model" value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })} placeholder="gpt-4o-mini" />
					</div>
					<div className="field">
						<label htmlFor="s-key">API Key</label>
						<input id="s-key" type="password" value={s.apiKey} onChange={(e) => setS({ ...s, apiKey: e.target.value })} placeholder="sk-..." />
					</div>
					<div className="field">
						<label htmlFor="s-ocr">OCR 语言</label>
						<input id="s-ocr" value={s.ocrLang} onChange={(e) => setS({ ...s, ocrLang: e.target.value })} placeholder="chi_sim+eng" />
						<span className="hint">Tesseract 语言包，如 chi_sim+eng / eng / jpn</span>
					</div>
				</div>

				<div className="modal-footer">
					<button type="button" onClick={onClose}>
						取消
					</button>
					<button type="button" className="primary" onClick={save}>
						保存
					</button>
				</div>
			</div>
		</div>
	);
}
