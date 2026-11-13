/**
 * Minimal WAV writer for engines that produce raw PCM.
 *
 * On-device models hand back Float32 samples; `<audio>` and
 * `AudioContext.decodeAudioData` both need a container, so every clip is wrapped
 * in a 16-bit mono WAV header (44 bytes — negligible next to the samples).
 */

const HEADER_BYTES = 44;

/** Convert float samples (nominally -1..1) into 16-bit PCM bytes. */
export function floatToPcm16(samples: Float32Array | number[]): Uint8Array {
	const out = new Uint8Array(samples.length * 2);
	const view = new DataView(out.buffer);
	for (let i = 0; i < samples.length; i++) {
		const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
		view.setInt16(i * 2, Math.round(v * 32767), true);
	}
	return out;
}

/** Wrap float samples in a 16-bit mono WAV container. */
export function encodeWav(samples: Float32Array | number[], sampleRate: number): Uint8Array {
	const pcm = floatToPcm16(samples);
	const out = new Uint8Array(HEADER_BYTES + pcm.length);
	const view = new DataView(out.buffer);
	const ascii = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
	};

	ascii(0, "RIFF");
	view.setUint32(4, 36 + pcm.length, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true); // PCM chunk size
	view.setUint16(20, 1, true); // format = PCM
	view.setUint16(22, 1, true); // channels
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	ascii(36, "data");
	view.setUint32(40, pcm.length, true);
	out.set(pcm, HEADER_BYTES);
	return out;
}
