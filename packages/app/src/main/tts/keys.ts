import { createHash } from "node:crypto";

/**
 * Content-addressed cache key for synthesized audio.
 *
 * Everything that changes the audio is part of the key, so a cached file can be
 * replayed without knowing which engine produced it — except that the engine id
 * is included too, because two engines reading the same sentence should not
 * share a file.
 */
export type CacheKeyInput = {
	engineId: string;
	/** Engine-side configuration fingerprint (model dir, endpoint, ...). */
	tag?: string;
	voiceId: string;
	rate?: number;
	pitch?: number;
	format?: string;
	text: string;
};

export function cacheKey(input: CacheKeyInput): string {
	const rate = (input.rate ?? 1).toFixed(2);
	const pitch = (input.pitch ?? 1).toFixed(2);
	const material = [
		input.engineId,
		input.tag ?? "",
		input.voiceId,
		rate,
		pitch,
		input.format ?? "",
		input.text,
	].join("\u0000");
	return createHash("sha256").update(material, "utf8").digest("hex");
}
