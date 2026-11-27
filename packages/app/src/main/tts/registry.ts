import { synthesizeText } from "./pipeline.ts";
import {
	isTtsError,
	type TtsCapabilities,
	type TtsEngine,
	TtsError,
	type TtsRequest,
	type TtsResult,
	type TtsVoice,
	toTtsError,
} from "./types.ts";

/**
 * Engine registry + fallback chain.
 *
 * The player never names a vendor: it asks for "the best engine that works right
 * now" and the registry walks an ordered list. A missing key, a dead endpoint or
 * a rate limit therefore degrades to the next engine instead of failing the
 * feature — which matters because the free tier is an unofficial endpoint that
 * can disappear without notice.
 */

export type EngineInfo = {
	id: string;
	label: string;
	capabilities: TtsCapabilities;
};

export type FallbackNote = {
	from: string;
	to: string;
	error: TtsError;
};

export type SynthesisOutcome = {
	engineId: string;
	result: TtsResult;
};

/** How long a failing engine is skipped before being retried. */
const COOLDOWN_MS = 60_000;

export class TtsRegistry {
	private readonly engines = new Map<string, TtsEngine>();
	/** Engines that failed recently; a free endpoint can be down for a while. */
	private readonly cooldownUntil = new Map<string, number>();

	register(engine: TtsEngine): this {
		this.engines.set(engine.id, engine);
		return this;
	}

	get(id: string): TtsEngine | undefined {
		return this.engines.get(id);
	}

	ids(): string[] {
		return [...this.engines.keys()];
	}

	list(): EngineInfo[] {
		return [...this.engines.values()].map((e) => ({
			id: e.id,
			label: e.label,
			capabilities: e.capabilities(),
		}));
	}

	/** Voices for one engine; rejects when it is unusable (e.g. no key). */
	async voices(engineId: string): Promise<TtsVoice[]> {
		const engine = this.engines.get(engineId);
		if (!engine) return [];
		return engine.listVoices();
	}

	/** Voices for the picker: every engine that answers, failures skipped. */
	async allVoices(): Promise<{ engineId: string; label: string; voices: TtsVoice[] }[]> {
		const out: { engineId: string; label: string; voices: TtsVoice[] }[] = [];
		for (const engine of this.engines.values()) {
			try {
				const voices = await engine.listVoices();
				if (voices.length > 0) out.push({ engineId: engine.id, label: engine.label, voices });
			} catch {}
		}
		return out;
	}

	/**
	 * Engines in the order a synthesis would try them, applying the cooldown.
	 *
	 * The player needs this *before* synthesizing: it checks the audio cache for
	 * the engine that is about to speak, and "the engine about to speak" must
	 * account for engines that just failed.
	 */
	resolveOrder(chain: string[]): string[] {
		const known = chain.filter((id) => this.engines.has(id));
		const now = Date.now();
		const healthy = known.filter((id) => (this.cooldownUntil.get(id) ?? 0) <= now);
		// When everything is cooling down we still have to try something.
		return healthy.length > 0 ? healthy : known;
	}

	/** The engine a synthesis would start with right now. */
	preferred(chain: string[]): string | undefined {
		return this.resolveOrder(chain)[0];
	}

	/**
	 * Synthesize with the first engine in `chain` that succeeds.
	 *
	 * `request` is either a ready request (every engine gets the same one) or a
	 * factory `engineId → request`. The factory exists because voice ids are
	 * engine scoped: the default voice of "sherpa" (`0`) is meaningless to Edge,
	 * and handing Edge's neural voice name to sherpa would make the fallback
	 * fail. The caller resolves the voice per engine.
	 *
	 * Aborts are terminal (the user pressed stop) — never fall through. Every
	 * other failure is recorded and the next engine is tried, so a broken free
	 * tier silently upgrades to the configured paid one.
	 */
	async synthesize(
		chain: string[],
		request: TtsRequest | ((engineId: string) => TtsRequest),
		onFallback?: (note: FallbackNote) => void,
	): Promise<SynthesisOutcome> {
		const attempts: { engineId: string; error: TtsError }[] = [];
		const tried: string[] = [];
		const requestFor = typeof request === "function" ? request : () => request;
		const order = this.resolveOrder(chain);

		for (const id of order) {
			const engine = this.engines.get(id);
			if (!engine) continue;
			tried.push(id);
			try {
				// Long text is split at sentence boundaries before it reaches the
				// engine, so every engine only has to honor its own per-call cap.
				const result = await synthesizeText(engine, requestFor(id));
				this.cooldownUntil.delete(id);
				return { engineId: id, result };
			} catch (e) {
				const error = toTtsError(e, id);
				if (error.kind === "aborted") throw error;
				if (error.retryable) this.cooldownUntil.set(id, Date.now() + COOLDOWN_MS);
				attempts.push({ engineId: id, error });
				const next = nextUsable(order, id, this.engines);
				if (next) onFallback?.({ from: id, to: next, error });
			}
		}

		const last = attempts.at(-1);
		if (!last) {
			throw new Error(`没有可用的朗读引擎（候选：${chain.join(", ") || "空"}）`);
		}
		const summary = attempts.map((a) => `${a.engineId}: ${a.error.message}`).join("；");
		const err = new TtsError(last.error.kind, `全部朗读引擎均失败（${summary}）`, {
			engineId: last.engineId,
			status: last.error.status,
			cause: last.error,
		});
		throw err;
	}
}

function nextUsable(
	chain: string[],
	current: string,
	engines: Map<string, TtsEngine>,
): string | undefined {
	const at = chain.indexOf(current);
	for (const id of chain.slice(at + 1)) {
		if (engines.has(id)) return id;
	}
	return undefined;
}

/** Narrowing helper for callers that want to surface a typed error. */
export function describeTtsError(e: unknown): { kind: string; message: string } {
	const err = isTtsError(e) ? e : toTtsError(e);
	return { kind: err.kind, message: err.message };
}
