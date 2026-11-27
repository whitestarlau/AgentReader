import type { TtsEngineMode } from "../../shared/tts.ts";

/**
 * Which engines a synthesis may try, and in what order.
 *
 * This used to live inline in `index.ts` as "requested engine, then the
 * configured one, then registration order" — i.e. the free online tier always
 * came first and the local model was only a safety net. The user-facing
 * `ttsEngineMode` setting turns that implicit policy into an explicit one:
 *
 * | mode          | order                                   | cross-class fallback |
 * |---------------|-----------------------------------------|----------------------|
 * | auto          | last success → online → local           | yes                  |
 * | online-first  | online → local                          | yes                  |
 * | local-first   | local → online                          | yes                  |
 * | local-only    | local                                   | **no**               |
 * | online-only   | online                                  | **no**               |
 *
 * Two deliberate details:
 *
 * - **`auto` is sticky.** The engine that just worked is the best guess for the
 *   next sentence. Without it, an unreachable free endpoint costs a timeout on
 *   *every* sentence once the circuit breaker cools down; with it, the switch to
 *   the local model sticks.
 * - **`*-only` never crosses classes.** "仅本地" is a promise, not a hint: if no
 *   local model is installed the chain is empty and the caller reports that,
 *   instead of silently going online.
 *
 * Pure function on purpose: no Electron, no registry, so it is unit-testable.
 */

export type EngineClass = "local" | "online";

export type ChainInput = {
	/** Registered engine ids in registration order (the mock engine is excluded). */
	available: string[];
	/** Whether an engine runs without the network — `capabilities().offline`. */
	isLocal: (engineId: string) => boolean;
	mode: TtsEngineMode;
	/**
	 * A one-off request for one engine (voice preview). Voice ids are engine
	 * scoped, so mixing engines here would preview the wrong voice.
	 */
	requested?: string;
	/**
	 * `ttsEngine`: an explicit preference for one engine. It only reorders
	 * inside its own class — a local pin cannot defeat "仅在线", and the other
	 * way around.
	 */
	pinned?: string;
	/** Engine that last produced audio in this app run (`auto` mode only). */
	lastGood?: string | null;
};

export function buildChain(input: ChainInput): string[] {
	const { available, isLocal, mode, requested, pinned, lastGood } = input;

	// An explicit request wins over the mode: the user clicked "试听" on a
	// specific engine, and its voice id means nothing to any other engine.
	if (requested && available.includes(requested)) return [requested];

	const local: string[] = [];
	const online: string[] = [];
	for (const id of available) (isLocal(id) ? local : online).push(id);

	const withPin = (ids: string[]): string[] => {
		if (!pinned || !ids.includes(pinned)) return ids;
		return [pinned, ...ids.filter((id) => id !== pinned)];
	};

	switch (mode) {
		case "local-only":
			return withPin(local);
		case "online-only":
			return withPin(online);
		case "local-first":
			return [...withPin(local), ...withPin(online)];
		case "online-first":
			return [...withPin(online), ...withPin(local)];
		default: {
			// auto: the pin (explicit, rare) then the last success, then the free
			// online tier, then the device.
			const sticky = [pinned, lastGood].filter((id): id is string =>
				Boolean(id && available.includes(id)),
			);
			const rest = [...online, ...local].filter((id) => !sticky.includes(id));
			return [...new Set([...sticky, ...rest])];
		}
	}
}

/** Why the chain is empty — the message has to be actionable, not generic. */
export function emptyChainMessage(mode: TtsEngineMode): string {
	switch (mode) {
		case "local-only":
			return "仅本地模式：还没有可用的本地模型。请到「设置 → 朗读」下载一个，或把「引擎策略」改成自动。";
		case "online-only":
			return "仅在线模式：当前没有可用的在线引擎。检查网络后重试，或把「引擎策略」改成自动。";
		default:
			return "还没有配置朗读引擎（设置 → 朗读）";
	}
}
