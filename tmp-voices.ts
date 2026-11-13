import { SherpaTts } from "./packages/app/src/main/tts/providers/sherpa.ts";

const engine = new SherpaTts({ modelDir: "/tmp/sherpa/vits-icefall-zh-aishell3", numThreads: 4 });
const voices = await engine.listVoices();
console.log("voices count:", voices.length, "| first:", voices[0]?.id, voices[0]?.name, "| last:", voices.at(-1)?.id, voices.at(-1)?.name);

for (const sid of ["0", "5", "77", "173"]) {
  const r = await engine.synthesize({ text: "这是同一个句子，用不同音色朗读。", voiceId: sid });
  const pcm = new Int16Array(r.audio.data.buffer, r.audio.data.byteOffset + 44, (r.audio.data.length - 44) / 2);
  let sum = 0;
  for (const v of pcm) sum += v * v;
  const rms = Math.sqrt(sum / pcm.length);
  console.log(`sid=${sid} audio=${(r.durationMs! / 1000).toFixed(2)}s rms=${rms.toFixed(0)}`);
}
