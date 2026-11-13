import type { ReadState } from "../read-aloud.ts";
import { Icon } from "./Icons.tsx";

/**
 * Floating transport for read-aloud: it sits at the bottom of the reading area
 * so the reading toolbar stays about the document, and it only appears while a
 * session is active.
 */

const RATES = [0.8, 1, 1.2, 1.5, 2];

export function ReadBar({
	state,
	rate,
	onRate,
	onToggle,
	onPrev,
	onNext,
	onStop,
}: {
	state: ReadState;
	rate: number;
	onRate: (rate: number) => void;
	onToggle: () => void;
	onPrev: () => void;
	onNext: () => void;
	onStop: () => void;
}) {
	const busy = state.status === "playing" || state.status === "loading";
	return (
		<div className="read-bar" data-toolbar>
			<button type="button" className="icon-btn" onClick={onPrev} title="上一句">
				<Icon name="chevronLeft" size={13} />
			</button>
			<button
				type="button"
				className={`read-bar-toggle${busy ? " active" : ""}`}
				onClick={onToggle}
				title={busy ? "暂停朗读" : "继续朗读"}
			>
				<Icon name={busy ? "pause" : "play"} size={12} />
				{busy ? "暂停" : state.status === "paused" ? "继续" : "播放"}
			</button>
			<button type="button" className="icon-btn" onClick={onNext} title="下一句">
				<Icon name="chevronRight" size={13} />
			</button>
			<span className="read-bar-count">
				{state.total > 0 ? `${Math.min(state.index + 1, state.total)} / ${state.total} 句` : "—"}
			</span>
			<select
				className="read-bar-rate"
				value={rate}
				onChange={(e) => onRate(Number(e.target.value))}
				title="语速（对之后合成的句子生效）"
			>
				{RATES.map((r) => (
					<option key={r} value={r}>
						{r}×
					</option>
				))}
			</select>
			{state.status === "loading" && <span className="read-bar-spinner" aria-hidden="true" />}
			{state.error && <span className="read-bar-error">{state.error}</span>}
			<button type="button" className="icon-btn read-bar-stop" onClick={onStop} title="停止朗读">
				<Icon name="stop" size={11} />
			</button>
		</div>
	);
}
