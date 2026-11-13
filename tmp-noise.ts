import { SherpaTts } from "./packages/app/src/main/tts/providers/sherpa.ts";

const text = "人工智能正在改变我们阅读的方式，这是今天的第三篇文章。";

function pcm16(wav: Uint8Array): Int16Array {
  return new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2);
}

function metrics(name: string, wav: Uint8Array, rate: number) {
  const pcm = pcm16(wav);
  const f = Float32Array.from(pcm, (v) => v / 32768);
  const head = f.subarray(0, Math.floor(rate * 0.25)); // leading silence
  const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  let clipping = 0;
  for (const v of f) if (Math.abs(v) >= 0.999) clipping++;
  let diff = 0;
  for (let i = 1; i < f.length; i++) diff += (f[i] - f[i - 1]) ** 2;
  const hf = Math.sqrt(diff / f.length) / (rms(f) || 1);
  console.log(
    `${name.padEnd(14)} rate=${rate} dur=${(f.length / rate).toFixed(2)}s | silenceRMS=${(20 * Math.log10(rms(head) + 1e-9)).toFixed(1)}dB | totalRMS=${(20 * Math.log10(rms(f) + 1e-9)).toFixed(1)}dB | HF=${hf.toFixed(3)} | clip=${clipping}`,
  );
}

const engines: [string, Promise<{ wav: Uint8Array; rate: number }>][] = [
  ["kokoro-int8", new SherpaTts({ modelDir: "/tmp/sherpa/kokoro-int8-multi-lang-v1_1" }).synthesize({ text, voiceId: "47" }).then((r) => ({ wav: r.audio.data, rate: r.audio.sampleRate }))],
  ["melotts", new SherpaTts({ modelDir: "/tmp/sherpa/vits-melo-tts-zh_en" }).synthesize({ text, voiceId: "0" }).then((r) => ({ wav: r.audio.data, rate: r.audio.sampleRate }))],
  ["aishell3", new SherpaTts({ modelDir: "/tmp/sherpa/vits-icefall-zh-aishell3" }).synthesize({ text, voiceId: "0" }).then((r) => ({ wav: r.audio.data, rate: r.audio.sampleRate }))],
];

for (const [name, pending] of engines) {
  try {
    const { wav, rate } = await pending;
    metrics(name, wav, rate);
  } catch (e) {
    console.log(name, "FAILED", (e as Error).message);
  }
}
