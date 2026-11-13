import { SherpaTts } from "./packages/app/src/main/tts/providers/sherpa.ts";

const engine = new SherpaTts({ modelDir: "/tmp/sherpa/kokoro-int8-multi-lang-v1_1", numThreads: 4 });
const voices = await engine.listVoices();
console.log("first:", voices.slice(0, 4).map((v) => `${v.id}:${v.name}`).join(" | "), "| last:", voices.at(-1)?.id, voices.at(-1)?.name);

const text = "人工智能正在改变我们阅读的方式。";
for (const sid of ["3", "20", "47", "80", "102"]) {
  const r = await engine.synthesize({ text, voiceId: sid });
  const pcm = new Int16Array(r.audio.data.buffer, r.audio.data.byteOffset + 44, (r.audio.data.length - 44) / 2);
  const f = Float32Array.from(pcm, (v) => v / 32768);
  let diff = 0, sum = 0;
  for (let i = 1; i < f.length; i++) diff += (f[i] - f[i - 1]) ** 2;
  for (const v of f) sum += v * v;
  const hf = Math.sqrt(diff / f.length) / (Math.sqrt(sum / f.length) || 1);
  console.log(`sid=${sid.padEnd(3)} ${voices.find((v) => v.id === sid)?.name} dur=${((r.durationMs ?? 0) / 1000).toFixed(2)}s hf=${hf.toFixed(3)}`);
}
