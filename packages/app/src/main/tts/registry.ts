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
	 * Synthesize with the first engine in `chain` that succeeds.
	 *
	 * Aborts are terminal (the user pressed stop) — never fall through. Every
	 * other failure is recorded and the next engine is tried, so a broken free
	 * tier silently upgrades to the configured paid one.
	 */
	async synthesize(
		chain: string[],
		req: TtsRequest,
		onFallback?: (note: FallbackNote) => void,
	): Promise<SynthesisOutcome> {
		const attempts: { engineId: string; error: TtsError }[] = [];
		const tried: string[] = [];
		const now = Date.now();
		const known = chain.filter((id) => this.engines.has(id));
		// Skip engines that just failed, unless that would leave nothing to try.
		const healthy = known.filter((id) => (this.cooldownUntil.get(id) ?? 0) <= now);
		const order = healthy.length > 0 ? healthy : known;

		for (const id of order) {
			const engine = this.engines.get(id);
			if (!engine) continue;
			tried.push(id);
			try {
				// Long text is split at sentence boundaries before it reaches the
				// engine, so every engine only has to honor its own per-call cap.
				const result = await synthesizeText(engine, req);
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
