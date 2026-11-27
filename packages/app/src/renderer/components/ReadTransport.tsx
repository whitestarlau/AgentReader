import { TTS_ENGINE_MODES, type TtsEngineMode, ttsEngineModeDesc } from "../../shared/tts.ts";
import type { ReadState } from "../read-aloud.ts";
import { ToolButton, ToolSpacer } from "./Toolbar.tsx";

/**
 * Read-aloud transport, rendered *inside* the reading toolbar.
 *
 * v1 floated it at the bottom of the page, over the text — which covered a line
 * or two and needed a hide-on-idle hack to get out of the way. Putting it in the
 * toolbar removes the overlay entirely: the page is never obscured, there is no
 * show/hide state to learn, and the controls stay put while the highlight walks
 * down the page. The bar therefore replaces the idle toolbar while a session is
 * active — navigation is locked during reading anyway.
 */

const RATES = [0.8, 1, 1.2, 1.5, 2];

export function ReadTransport({
	state,
	rate,
	mode,
	onRate,
	onMode,
	onToggle,
	onPrev,
	onNext,
	onStop,
}: {
	state: ReadState;
	rate: number;
	mode: TtsEngineMode;
	onRate: (rate: number) => void;
	onMode: (mode: TtsEngineMode) => void;
	onToggle: () => void;
	onPrev: () => void;
	onNext: () => void;
	onStop: () => void;
}) {
	const busy = state.status === "playing" || state.status === "loading";
	const position = state.total > 0 ? `${Math.min(state.index + 1, state.total)} / ${state.total} 句` : "—";
	return (
		<>
			<ToolButton icon="chevronLeft" title="上一句" onClick={onPrev} />
			<ToolButton
				icon={busy ? "pause" : "play"}
				label={busy ? "暂停" : state.status === "paused" ? "继续" : "播放"}
				primary
				title={busy ? "暂停朗读" : "继续朗读"}
				onClick={onToggle}
			/>
			<ToolButton icon="chevronRight" title="下一句" onClick={onNext} />
			<span className="tb-muted tb-position">{position}</span>
			{state.status === "loading" ? <span className="tb-spinner" aria-hidden="true" /> : null}
			{state.engine ? (
				<span className="tb-muted tb-engine" title={`当前朗读引擎：${state.engine.label}`}>
					{state.engine.label}
				</span>
			) : null}
			<ToolSpacer />
			{state.error ? <span className="tb-error" title={state.error}>{state.error}</span> : null}
			<select
				className="tb-select"
				value={rate}
				onChange={(e) => onRate(Number(e.target.value))}
				title="语速（对之后合成的句子生效）"
				aria-label="语速"
			>
				{RATES.map((r) => (
					<option key={r} value={r}>
						{r}×
					</option>
				))}
			</select>
			<select
				className="tb-select"
				value={mode}
				onChange={(e) => onMode(e.target.value as TtsEngineMode)}
				title={`引擎策略：${ttsEngineModeDesc(mode)}`}
				aria-label="引擎策略"
			>
				{TTS_ENGINE_MODES.map((m) => (
					<option key={m.id} value={m.id} title={m.desc}>
						{m.label}
					</option>
				))}
			</select>
			<ToolButton icon="stop" title="停止朗读（Esc）" onClick={onStop} />
		</>
	);
}
