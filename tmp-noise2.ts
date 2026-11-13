import { SherpaTts } from "./packages/app/src/main/tts/providers/sherpa.ts";

const text = "人工智能正在改变我们阅读的方式，这是今天的第三篇文章。";

function frames(wav: Uint8Array, rate: number) {
  const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2);
  const f = Float32Array.from(pcm, (v) => v / 32768);
  const size = Math.floor(rate * 0.02);
  const out: number[] = [];
  for (let i = 0; i + size <= f.length; i += size) {
    let s = 0;
    for (let j = 0; j < size; j++) s += f[i + j] ** 2;
    out.push(Math.sqrt(s / size));
  }
  return out.sort((a, b) => a - b);
}
const db = (v: number) => (20 * Math.log10(v + 1e-9)).toFixed(1);

const cases: [string, string][] = [
  ["kokoro-int8", "/tmp/sherpa/kokoro-int8-multi-lang-v1_1"],
  ["melotts", "/tmp/sherpa/vits-melo-tts-zh_en"],
  ["aishell3", "/tmp/sherpa/vits-icefall-zh-aishell3"],
];
for (const [name, dir] of cases) {
  const r = await new SherpaTts({ modelDir: dir }).synthesize({ text, voiceId: name === "kokoro-int8" ? "47" : "0" });
  const e = frames(r.audio.data, r.audio.sampleRate);
  const at = (p: number) => e[Math.min(e.length - 1, Math.floor(e.length * p))]!;
  console.log(`${name.padEnd(12)} p5=${db(at(0.05))}dB p25=${db(at(0.25))}dB median=${db(at(0.5))}dB p95=${db(at(0.95))}dB | floor-to-speech=${(db(at(0.05)) - db(at(0.95))).toFixed(1)}dB`);
}
