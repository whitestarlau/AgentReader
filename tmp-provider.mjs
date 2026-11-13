import sherpa from "sherpa-onnx-node";
const dir = "/tmp/sherpa/kokoro-int8-multi-lang-v1_1";
const text = "人工智能正在改变我们阅读的方式，这是今天的第三篇文章。";

for (const provider of ["cpu", "coreml"]) {
  try {
    const t0 = Date.now();
    const tts = new sherpa.OfflineTts({
      model: {
        kokoro: {
          model: `${dir}/model.int8.onnx`,
          voices: `${dir}/voices.bin`,
          tokens: `${dir}/tokens.txt`,
          lexicon: `${dir}/lexicon-us-en.txt,${dir}/lexicon-zh.txt`,
        },
        numThreads: 4,
        provider,
      },
      maxNumSentences: 1,
    });
    const loadMs = Date.now() - t0;
    const before = process.cpuUsage();
    const t = Date.now();
    const a = tts.generate({ text, sid: 47, speed: 1, enableExternalBuffer: false });
    const wall = (Date.now() - t) / 1000;
    const cpu = process.cpuUsage(before);
    const dur = a.samples.length / a.sampleRate;
    console.log(`${provider.padEnd(6)} load=${loadMs}ms rtf=${(wall / dur).toFixed(2)} cores=${((cpu.user + cpu.system) / 1e6 / wall).toFixed(1)}`);
  } catch (e) {
    console.log(`${provider.padEnd(6)} FAILED: ${e?.message ?? e}`);
  }
}
