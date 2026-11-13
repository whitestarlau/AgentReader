/**
 * Which voice an engine should use.
 *
 * Voice ids are engine-scoped: "0" means speaker 0 for sherpa but means nothing
 * to an OpenAI-compatible endpoint. One global setting would therefore break as
 * soon as the user switches engines, so the id is stored per engine under
 * `ttsVoice:<engineId>`.
 */

export type VoiceSettings = Record<string, string | undefined>;

/** Fallback when an engine has never been configured. */
const DEFAULTS: Record<string, string> = {
	sherpa: "0",
	mock: "mock-zh",
	"openai-compatible": "zf_xiaobei",
};

export function voiceSettingKey(engineId: string): string {
	return `ttsVoice:${engineId}`;
}

/** Explicit request, then the per-engine setting, then the engine's default. */
export function resolveVoiceId(
	engineId: string,
	requested: string | undefined,
	settings: VoiceSettings,
): string {
	const trimmed = requested?.trim();
	if (trimmed) return trimmed;
	const stored = settings[voiceSettingKey(engineId)]?.trim();
	if (stored) return stored;
	return DEFAULTS[engineId] ?? "";
}
