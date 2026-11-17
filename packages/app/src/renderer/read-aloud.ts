import { type Segment, splitSentences } from "../shared/segment.ts";
import type { TtsSynthesizeReply } from "../shared/tts.ts";

/**
 * Sentence-by-sentence playback of a page or chapter.
 *
 * Owns the audio element, the synthesized-audio cache (so it works with engines
 * that have no timing information at all — the queue position *is* the sync),
 * and look-ahead: the next two sentences are synthesized while this one plays,
 * which is what hides the network latency of cloud engines.
 *
 * Framework-free on purpose: both readers wire it up the same way, and the
 * "advance to the next page" decision belongs to the reader, not here.
 */

export type ReadStatus = "idle" | "loading" | "playing" | "paused" | "error";

export type ReadState = {
	status: ReadStatus;
	/** Zero-based index of the sentence being spoken. */
	index: number;
	total: number;
	error?: string;
};

export type ReadAloudOptions = {
	synthesize: (text: string) => Promise<TtsSynthesizeReply>;
	onState: (state: ReadState) => void;
	/** Current sentence changed (for highlight); `null` clears it. */
	onSegment: (segment: Segment | null) => void;
	/** The loaded text ran out — the reader decides whether a next page exists. */
	onEnd: () => void;
	/** Test seam: everything else about the element is standard. */
	createAudio?: () => HTMLAudioElement;
};

const MIME: Record<string, string> = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	opus: "audio/ogg",
};

const PREFETCH_AHEAD = 2;
/** Sentence cap; the reader splits with the same value so offsets line up. */
export const READ_MAX_CHARS = 220;

export class ReadAloud {
	private readonly opts: ReadAloudOptions;
	private audio: HTMLAudioElement | null = null;
	private segments: Segment[] = [];
	private index = 0;
	/** Bumped on every jump/stop so late async results are discarded. */
	private generation = 0;
	private state: ReadState = { status: "idle", index: 0, total: 0 };
	private objectUrl: string | null = null;
	private readonly cache = new Map<number, Promise<TtsSynthesizeReply>>();

	constructor(opts: ReadAloudOptions) {
		this.opts = opts;
	}

	getState(): ReadState {
		return this.state;
	}

	/** The segments currently loaded; offsets address the text passed to `load()`. */
	getSegments(): readonly Segment[] {
		return this.segments;
	}

	/** Jump to a sentence (used by click-to-read in the document). */
	playFrom(index: number): void {
		const clamped = Math.min(Math.max(0, index), Math.max(0, this.segments.length - 1));
		void this.startAt(clamped);
	}

	/** Replace the text to read. Returns false when there is nothing speakable. */
	load(text: string, startAt = 0): boolean {
		this.stopAudio();
		this.segments = splitSentences(text, { maxChars: READ_MAX_CHARS });
		this.index = Math.min(Math.max(0, startAt), Math.max(0, this.segments.length - 1));
		this.emit("idle");
		return this.segments.length > 0;
	}

	play(): void {
		void this.startAt(this.index);
	}

	pause(): void {
		if (!this.audio || this.state.status !== "playing") return;
		this.audio.pause();
		this.emit("paused");
	}

	resume(): void {
		if (this.state.status === "paused" && this.audio?.src) {
			void this.audio.play();
			this.emit("playing");
			return;
		}
		this.play();
	}

	toggle(): void {
		if (this.state.status === "playing" || this.state.status === "loading") this.pause();
		else this.resume();
	}

	next(): void {
		if (this.index + 1 < this.segments.length) void this.startAt(this.index + 1);
	}

	prev(): void {
		// Re-play the current sentence when we are more than a moment into it.
		const restart = this.audio && this.audio.currentTime > 1.2;
		if (restart) {
			void this.startAt(this.index);
			return;
		}
		if (this.index > 0) void this.startAt(this.index - 1);
	}

	stop(): void {
		this.stopAudio();
		this.segments = [];
		this.emit("idle");
	}

	private stopAudio(): void {
		this.generation++;
		this.cache.clear();
		if (this.audio) {
			this.audio.pause();
			this.audio.removeAttribute("src");
			this.audio.load();
		}
		if (this.objectUrl) {
			URL.revokeObjectURL(this.objectUrl);
			this.objectUrl = null;
		}
		this.opts.onSegment(null);
	}

	private ensureAudio(): HTMLAudioElement {
		if (this.audio) return this.audio;
		const audio = this.opts.createAudio ? this.opts.createAudio() : new Audio();
		audio.preload = "auto";
		audio.onended = () => {
			// A stopped session clears its queue, but the media element can still
			// fire `ended` afterwards (pause/reload races). Only a genuinely
			// playing sentence may advance the reader — otherwise stopping read-
			// aloud would silently flip to the next page/section.
			if (this.state.status !== "playing") return;
			const next = this.index + 1;
			if (next < this.segments.length) void this.startAt(next);
			else this.opts.onEnd();
		};
		audio.onerror = () => {
			if (this.state.status !== "idle") this.emit("error", "音频播放失败");
		};
		this.audio = audio;
		return audio;
	}

	private async startAt(index: number): Promise<void> {
		const segment = this.segments[index];
		if (!segment) {
			this.opts.onEnd();
			return;
		}
		const gen = ++this.generation;
		this.index = index;
		this.emit("loading");
		this.opts.onSegment(segment);

		const reply = await this.synthesize(index);
		if (gen !== this.generation) return;
		if (!reply.ok) {
			this.emit("error", reply.message);
			return;
		}

		const audio = this.ensureAudio();
		this.setSource(audio, reply);
		try {
			await audio.play();
		} catch {
			if (gen === this.generation) this.emit("error", "无法播放音频（可能被系统拦截）");
			return;
		}
		if (gen !== this.generation) return;
		this.emit("playing");
		this.prefetchAhead(index);
	}

	private setSource(
		audio: HTMLAudioElement,
		reply: Extract<TtsSynthesizeReply, { ok: true }>,
	): void {
		if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
		const blob = new Blob([reply.data as unknown as BlobPart], {
			type: MIME[reply.format] ?? "audio/mpeg",
		});
		this.objectUrl = URL.createObjectURL(blob);
		audio.src = this.objectUrl;
	}

	private synthesize(index: number): Promise<TtsSynthesizeReply> {
		const hit = this.cache.get(index);
		if (hit) return hit;
		const segment = this.segments[index];
		const promise: Promise<TtsSynthesizeReply> = segment
			? this.opts.synthesize(segment.text)
			: Promise.resolve({ ok: false, kind: "unsupported", message: "没有可朗读的文本" });
		this.cache.set(index, promise);
		// A rejected prefetch must not surface as an unhandled rejection.
		promise.catch(() => {});
		return promise;
	}

	private prefetchAhead(index: number): void {
		for (let i = index + 1; i <= index + PREFETCH_AHEAD && i < this.segments.length; i++) {
			void this.synthesize(i);
		}
	}

	private emit(status: ReadStatus, error?: string): void {
		this.state = { status, index: this.index, total: this.segments.length, error };
		this.opts.onState(this.state);
	}
}
