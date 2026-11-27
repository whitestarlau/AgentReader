import { useCallback, useEffect, useState } from "react";
import {
	DEFAULT_TTS_ENGINE_MODE,
	normalizeTtsEngineMode,
	type TtsEngineMode,
} from "../shared/tts.ts";

/**
 * The user's engine-selection policy, for the reading views.
 *
 * The main process owns the decision (it reads `ttsEngineMode` on every
 * synthesis), so this only mirrors the setting in the UI and writes it back:
 * switching mid-reading takes effect on the next sentence that is synthesized,
 * exactly like the speed selector.
 */
export function useTtsEngineMode(): [TtsEngineMode, (mode: TtsEngineMode) => void] {
	const [mode, setMode] = useState<TtsEngineMode>(DEFAULT_TTS_ENGINE_MODE);

	useEffect(() => {
		let alive = true;
		window.api
			.getSettings()
			.then((settings) => {
				if (alive) setMode(normalizeTtsEngineMode(settings.ttsEngineMode));
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);

	const change = useCallback((next: TtsEngineMode) => {
		setMode(next);
		// Persist so the choice outlives the document (and the settings page
		// reflects it next time it loads).
		window.api.saveSettings({ ttsEngineMode: next }).catch(() => {});
	}, []);

	return [mode, change];
}
