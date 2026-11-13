# Offline / on-device TTS for a cross-platform Electron reading app (Chinese-first)

**Scope:** AgentReader — Electron 38 (Chromium 140), TypeScript, Node 22 main process, macOS 15 + Windows + Linux.
**Primary use case:** read Simplified-Chinese books aloud with sentence-level highlight sync; English also required.
**Hard constraint (per user):** the default engine must be **cross-platform** and **neural (2024–2026 tech)**. macOS-only paths (`say`, `AVSpeechSynthesizer`) are fallback only. Built-in OS voices (Tingting / SAPI / espeak) are rejected for the default path.

**Report date:** 2026-11-07. Measurements taken on the machine that wrote this report: **Apple M1, 8 cores (4P+4E), 16 GB, macOS 15.7.4, Node 22.23.2**.

> **Evidence note — read this first.** `web_search` was unavailable in this session (no API key), and `huggingface.co` is blocked from this network (I used the `hf-mirror.com` API instead). So rather than paraphrase blog posts, I **ran the engines and queried the registries directly**. Everything in the "measured" columns is reproducible on your machine; everything marked *estimate* or *unverified* is flagged inline. Where a claim is subjective (naturalness) I say so instead of inventing WER/SIM numbers.

---

## 0. TL;DR — the five findings that change the design

1. **`kokoro-js` cannot speak Chinese.** Its `_validate_voice()` accepts only the language prefixes `"a"` and `"b"` (`_validate_voice` returns `voice.at(0)` typed `"a"|"b"`) and it phonemizes with the espeak-ng WASM `phonemizer`. Chinese voices (`zf_*`, `zm_*`) are not in `VOICES` and will throw. Kokoro-on-Chinese **requires** sherpa-onnx (C++ FST + jieba) or a Python `misaki[zh]` sidecar. See §4.1.
2. **Kokoro is not fast enough to stream in real time on Apple Silicon.** Measured **RTF 0.83** (4 threads, int8, M1). That is *slower than real time on a weaker machine*. Any design that synthesizes sentence-by-sentence during playback will stutter. MeloTTS measured **RTF 0.24** on the identical text — 3.5× faster. See §3.9.
3. **You do not need word-level timing from the model.** Synthesize **per sentence and record each sentence's start offset + sample count**. Sentence-level highlight sync then becomes exact by construction, for free, on every engine. This removes the entire "does the engine emit boundaries?" question from the critical path.
4. **Licences kill half the famous models.** IndexTTS2 is under a **bilibili** licence that requires contacting them for commercial use; F5-TTS, ChatTTS, Spark-TTS and OpenAudio S1-mini are **CC-BY-NC(-SA)**. Do not plan a product on them. See §3.4.
5. **Piper's engine changed licence.** `rhasspy/piper` is **archived (last push 2025-08-26, MIT)**; the maintained successor `OHF-Voice/piper1-gpl` is **GPL-3.0**. Use piper *voices* through **sherpa-onnx (Apache-2.0)** instead of linking Piper itself. See §3.6.

**Frank verdict on "is local Chinese TTS near-human in 2026?":** **No — not at the size a desktop app can ship.** The best small model you can actually package (Kokoro-82M-zh, Apache-2.0, ~140 MB int8) is *competent and pleasant but clearly synthetic*: flat declarative prosody, occasional wrong 多音字 reading, no emotional range. The genuinely impressive Chinese models in 2024–2026 (CosyVoice 2, IndexTTS2, MOSS-TTSD, Fish/OpenAudio) are 0.5B–8B, Python/PyTorch-first, and mostly non-commercial or licence-encumbered — they are 1–3 GB sidecars, not npm dependencies. **Cloud still wins clearly on naturalness.** Local should ship as an *offline tier*, not as the only voice. Details in §7.

---

## 1. What Chromium actually does on each OS (the Web Speech API ceiling)

I read the current Chromium sources rather than guessing. This settles the "which engine" question and defines the ceiling of the zero-install fallback.

| OS | Chromium backend | Source |
|---|---|---|
| **macOS** | **`AVSpeechSynthesizer`** (AVFoundation). `NSSpeechSynthesizer` remains only as a *deprecated shim to read the user's default voice id*. | [`tts_mac.mm`](https://github.com/chromium/chromium/blob/main/content/browser/speech/tts_mac.mm) |
| **Windows** | **SAPI 5 / OneCore** via `ISpVoice` (`sapi.h`), voice tokens searched in "the newer OneCore or the older SAPI locations". | [`tts_win.cc`](https://github.com/chromium/chromium/blob/main/content/browser/speech/tts_win.cc) |
| **Linux** | **Speech Dispatcher** (`dlopen("libspeechd.so.2")`), `spd_set_synthesis_voice` etc. | [`tts_linux.cc`](https://github.com/chromium/chromium/blob/main/content/browser/speech/tts_linux.cc) |

So the widely repeated "Chromium uses NSSpeechSynthesizer on macOS" is **out of date** — it is `AVSpeechSynthesizer` now.

### 1.1 `onboundary` for Chinese — measured, in Electron 38 itself

I ran a probe inside your actual Electron 38 binary (`--no-sandbox --disable-gpu`, hidden `BrowserWindow`, macOS 15.7.4). Results:

```
total voices exposed: 191   (zh: 21)
zh sample: [{"name":"婷婷","lang":"zh-CN","local":true},
            {"name":"Eddy (中文（中国大陆）)","lang":"zh-CN","local":true}, ...]

ZH input: 他推开门，看见雾气从谷底升起来。   (16 chars)
→ 10 "word" boundary events, e.g.
  {i:0,len:1,t:319} {i:1,len:1,t:501} {i:2,len:2,t:757}
  {i:4,len:1,t:1653} {i:5,len:2,t:1653} {i:7,len:2,t:2144} {i:9,len:1,t:2581}

EN input: Hello world. This is a read-aloud probe.
→ 8 "word" boundary events, e.g. {i:0,len:5,t:512} {i:6,len:6,t:843}
```

**Answers:**
- **Yes, `onboundary` fires for Chinese**, at **lexical-word granularity** (1–3 characters per event — Apple tokenizes, it does not emit one event per character). `charIndex` is in UTF-16 code units of the string you passed in; `charLength` is the token length. This is exactly the granularity sentence highlighting wants.
- `elapsedTime` is a usable wall-clock offset in ms, so you can build a char→time map. **Caveat:** timestamps can repeat/be coarse (`i:4` and `i:5` both at `t:1653`), and there is no event during punctuation pauses.
- Chromium forwards this from `AVSpeechSynthesizerDelegate.willSpeakRangeOfSpeechString` → `TTS_EVENT_WORD`, with a guard because of a real Apple bug — the source comment reads: *"Ignore bogus ranges. The Mac speech synthesizer is a bit buggy and occasionally returns a number way out of range."*

### 1.2 Known limitations of the Web Speech path

| Limitation | Detail |
|---|---|
| **Voice naming is localized and unstable** | `say -v '?'` prints `Tingting`; the renderer sees **`婷婷`**. Names change with the OS UI language and Apple's "Eddy/Flo/Grandma/Grandpa/Reed/Rocko/Sandy/Shelley" personality voices add 16 further `zh_CN`/`zh_TW` entries. **Never match by name** — match by `voiceURI`, then `lang`, then index. Voice count also drifts by OS version (I saw 191 in Electron vs 177 via `say`). |
| **Utterance length** | No hard Chromium limit for the macOS backend, but `AVSpeechSynthesizer` buffers the *whole* utterance before speaking, so a 5 000-character utterance has a long silence before audio starts and cannot be scrubbed. Practical limit: **one sentence or one paragraph**. |
| **Pause/resume** | Implemented as `[speech_synthesizer_ pauseSpeakingAtBoundary:AVSpeechBoundaryImmediate]`. `pause()` then `resume()` is the classic Chrome bug surface (resume often restarts or drops the tail). Prefer cancel-and-restart-at-offset. |
| **Hidden/minimized window** | **Speech does not stop.** `TtsControllerImpl` has `stop_speaking_when_hidden_ = false` by default and Chrome's embedder does not flip it; there is no visibility check in `tts_mac.mm`. Electron inherits that default, so audio continues — but your **JS timers** can be throttled, which will break a `setInterval`-driven highlighter. Set `backgroundThrottling: false` on the `BrowserWindow` and/or drive highlighting from `onboundary`, not a timer. |
| **Personal Voice / Siri voices** | *Unverified here* (no Personal Voice enrolled on this machine, and Apple exposes these to `AVSpeechSynthesisVoice` only after user authorisation in System Settings). Treat as **version- and entitlement-dependent, do not rely on it**: they do not appear in `say -v '?'`, and `localService` visibility from a renderer is not guaranteed. |
| **Linux** | Speech Dispatcher → usually `espeak-ng`. Robotic. Chinese is poor. **No reliable word boundaries.** |
| **Windows** | SAPI 5 voices (Huihui/Xiaoxiao-legacy era) — intelligible, dated. Windows 11 "Natural Voices" are **not** reliably reachable here (§5). |

**Conclusion:** Web Speech is an excellent *zero-install fallback on macOS* (genuinely decent voice + real word boundaries), acceptable on Windows, and poor on Linux. It cannot be the default because it is exactly the "built-in OS voice" the user rejected.

---

## 2. The macOS-only paths (fallback only — kept for completeness)

Per the updated constraint these are **not** candidates for the main engine. Short version, with the gotchas that cost real time:

- **`say -o` writes uncompressed LPCM by default, even into an `.m4a`.** Measured: 8.69 s of Chinese → **387 278 bytes** for `.aiff`, `.m4a` and `.caf` alike (`afinfo` confirms `lpcm 22050 Hz 16-bit` in every container). You must pass `--data-format=aac` explicitly → **69 097 bytes** at 48 kbit/s. That is a **5.6× size difference** and a classic silent-bloat bug.
- **`say -o out.mp3` produces a 16-byte junk file** (no MP3 encoder), and **`say -o out.opus` hangs** (0-byte output, never returns) on macOS 15.7.4. Supported containers: `AIFF/AIFC/WAVE/CAF/m4af/m4bf/flac/ogg(opus)/mp4`.
- **`say` emits no timing data.** `--interactive` highlights words in the terminal but only in real time. Word timing exists only in the AVFoundation delegate (`willSpeakRangeOfSpeechString`) or the ancient Carbon `soWordCallBack`.
- **Node integration** would require an N-API addon, a signed Swift/ObjC helper binary, or `koffi` FFI — plus hardened-runtime codesigning, notarisation and `lipo` universal builds. Real cost, macOS-only payoff, and it is the same engine Web Speech already gives you for free.

**Verdict: skip.** Web Speech already exposes this engine (including word boundaries) with zero native code. There is no reason to build a `say`/AVSpeech bridge.

---

## 3. Cross-platform on-device neural TTS — the real candidates

### 3.1 Measured speed (this is the part nobody publishes honestly)

Method: `sherpa-onnx-node@2.0.1`, ONNX Runtime CPU EP, 24 kHz output, same 62-character Chinese paragraph for the head-to-head, warm-up call discarded.

| Model | Precision | Threads | Audio (s) | Synth (s) | **RTF** ↓ |
|---|---|---|---|---|---|
| Kokoro multi-lang v1.1 (zh+en) | int8 | 1 | 12.24 | 13.61 | 1.11 |
| Kokoro multi-lang v1.1 | int8 | 2 | 12.24 | 11.66 | 0.95 |
| **Kokoro multi-lang v1.1** | **int8** | **4** | 12.24 | 10.12 | **0.83** |
| Kokoro multi-lang v1.1 | int8 | 8 | 12.24 | 15.46 | 1.26 |
| Kokoro (CoreML EP) | int8 | 4 | 12.24 | 10.03 | 0.82 |
| **MeloTTS zh_en** | **fp32** | **4** | 10.64 | 2.54 | **0.24** |
| MeloTTS zh_en | fp32 | 2 | 2.86 | 1.18 | 0.41 |

Notes that matter:
- **8 threads is *worse* than 4** (1.26 vs 0.83) — the E-cores thrash. Cap at `hw.perflevel0.physicalcpu` (4 here).
- **CoreML EP buys nothing** (0.82 vs 0.83) — these graphs have dynamic shapes, so most nodes fall back to CPU. Don't ship CoreML-specific code paths for TTS.
- **MeloTTS (VITS) is 3.5× faster than Kokoro (StyleTTS2-family)** at similar perceived quality. This is the single most useful architectural fact in this report.
- RTF is **per-machine and per-text-length** (fixed overhead dominates short sentences). Treat these as relative guidance, not absolutes.

**Mid-range Windows x86 CPU (estimate, not measured).** I have no Windows hardware here. Reasoning: these are the same ONNX graphs on the same ORT CPU EP; a modern 4-thread laptop x86 (i5-1235U / Ryzen 5 5600U) is broadly comparable to an M1 4P cluster for int8 conv/LSTM work, and **often faster for int8** because x86 builds use AVX2/VNNI dot-product kernels while the ARM build here does not. **Budget RTF ≈ 1.0–1.5× the M1 number** for safety: Kokoro **≈ 0.8–1.3**, MeloTTS **≈ 0.25–0.4**. Both conclusions survive: MeloTTS streams comfortably; Kokoro does not.

### 3.2 Kokoro-82M (the practical small-model winner)

- **82 M params**, Apache-2.0 — verified on the model card ([hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), [Kokoro-82M-v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh), and the ONNX exports [onnx-community/Kokoro-82M-v1.1-zh-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.1-zh-ONNX)).
- **Chinese is a first-class language** in the upstream repo: the README maps `'z' => Mandarin Chinese` and says Chinese needs `pip install misaki[zh]` — i.e. **upstream Chinese depends on Python** ([kokoro README](https://github.com/hexgrad/kokoro)).
- **sherpa-onnx solves that in C++**, which is why Kokoro-on-Chinese is practical from Node at all. The `kokoro-int8-multi-lang-v1_1` bundle ships `phone-zh.fst`, `date-zh.fst`, `number-zh.fst`, a jieba `dict/`, `lexicon-zh.txt` and `espeak-ng-data` — full Chinese text normalisation (numbers, dates, 多音字-ish rules) with no Python.
- **Sizes:** `kokoro-multi-lang-v1_1.tar.bz2` **348 MB** fp32, `kokoro-int8-multi-lang-v1_1.tar.bz2` **140 MB** int8 (211 MB unpacked); v1.0 is 334 MB / 126 MB. 103 voices in the v1.1 bundle (`numSpeakers: 103`).
- **Quality:** good-to-very-good for a 82 M model, clearly better than Piper/MeloTTS in *timbre*, but Chinese prosody is flat and it has no notion of emphasis. My subjective ranking of the models I could run: **Kokoro-zh > MeloTTS-zh > Piper zh_CN**.
- **⚠️ English regression in sherpa-onnx ≥ 2.0:** `--kokoro-data-dir` is **deprecated and ignored**, so there is no espeak fallback for out-of-vocabulary English words — I observed `OOV word skipped: 'opened'`, i.e. **the word is silently dropped from the audio**. For an en+zh reader you must either pin sherpa-onnx 1.x, supply `GenerationConfig.phoneme_codepoints` from a real phonemizer (`piper_phonemize`), or keep English on a different engine. **This is a shipping blocker for English-only text, not for Chinese.**

### 3.3 MeloTTS (`vits-melo-tts-zh_en`) — the speed/quality sweet spot

- MyShell MeloTTS, **MIT** licence (engine and the zh model), ~**159 MB** archive / 196 MB unpacked, single speaker, zh+en mixed in one model — it handles `中英混排` natively, which matters for books with English terms.
- **Measured RTF 0.24** — the only model here that can synthesise a sentence faster than you speak it *with headroom*, on an 8-year-old-baseline M1 and therefore plausibly on a mid-range Windows laptop.
- **⚠️ Distribution bug I hit:** `vits-melo-tts-zh_en.tar.bz2` from the sherpa-onnx `tts-models` release contains a **133-byte Git-LFS pointer** named `model.int8.onnx` instead of the real int8 model. You must use `model.onnx` (170 MB fp32). Verify any model tarball you vendor — `head -c 60` should not say `version https://git-lfs...`.
- Licence nuance: the **MeloTTS-Chinese weights card is MIT** ([myshell-ai/MeloTTS-Chinese](https://huggingface.co/myshell-ai/MeloTTS-Chinese)) but the upstream repo historically carried a **non-commercial** clause for some components — *verify the exact tarball's LICENSE before shipping* (the sherpa bundle ships an MIT `LICENSE`, which is what I read here).

### 3.4 The big Chinese models — great audio, bad shipping story

| Model | Params / size | Chinese | **Licence** | Reality check |
|---|---|---|---|---|
| **CosyVoice 2** | 0.5 B (~1–2 GB) | Excellent, best-in-class prosody | **Apache-2.0** ✅ | PyTorch + `torchaudio`, no maintained ONNX. Python sidecar only. RTF on CPU poor; wants GPU/MPS. |
| **CosyVoice 3** | 0.5 B+ | Excellent | Apache-2.0 (repo) — *verify weights* | Newer, same integration story. |
| **IndexTTS2** | ~1.2 B | Excellent, emotion-aware | **⛔ bilibili Model Use License** — *"For commercial usage and cooperation, please contact indexspeech@bilibili.com"* ([repo](https://github.com/index-tts/index-tts)) | Best Chinese naturalness of the open ones, but **not shippable commercially without a deal**. |
| **MOSS-TTSD v0.5 / v1.0** | 2.05 B / 8.35 B | Very good, dialogue-oriented | **Apache-2.0** ✅ ([v0.5](https://huggingface.co/OpenMOSS-Team/MOSS-TTSD-v0.5)) | 2 B is far too big for CPU real-time; designed for podcast/dialogue with GPU. |
| **Chatterbox (Multilingual V3)** | 0.5 B | Good; **23 langs incl. `zh`** | **MIT** ✅ ([repo](https://github.com/resemble-ai/chatterbox)) | Voice-cloning design needs a reference clip. ONNX exists ([`onnx-community/chatterbox-multilingual-ONNX`](https://huggingface.co/onnx-community/chatterbox-multilingual-ONNX)) but 0.5 B on CPU ≈ RTF 2–4 → pre-synthesis only. **Best licence/size/quality compromise among the big ones.** |
| **MegaTTS3** | ~0.5 B | Good, en+zh | **Apache-2.0** ✅ ([ByteDance/MegaTTS3](https://huggingface.co/ByteDance/MegaTTS3)) | Accent/voice-clone oriented, Python. |
| **VibeVoice-1.5B** | 1.5 B (repo 2.7 B total) | zh+en | **MIT** ✅ ([VibeVoice-1.5B](https://huggingface.co/microsoft/VibeVoice-1.5B)) | Long-form (up to ~90 min) podcast synthesis — architecturally interesting for *chapter* narration, but 1.5 B and GPU-hungry. Realtime-0.5B variant is **English only**. |
| **F5-TTS** | 336 M | Good, cloning | **⛔ CC-BY-NC-4.0** ([card](https://huggingface.co/SWivid/F5-TTS)) | Non-commercial. Very popular → easy to pick by mistake. |
| **ChatTTS** | 0.5 B | Good conversational zh | **⛔ CC-BY-NC-4.0** ([card](https://huggingface.co/2noise/ChatTTS)) | Non-commercial, and no stable prosody control. |
| **GPT-SoVITS** | ~0.5 B | Very good cloning | MIT (code) — **weights unverified** | Famous for few-shot cloning; realistically a Python sidecar + reference audio. |
| **Fish-Speech / OpenAudio S1-mini** | 0.5 B | Very good | **⛔ CC-BY-NC-SA-4.0** ([card](https://huggingface.co/fishaudio/openaudio-s1-mini)) | Non-commercial. |
| **Spark-TTS** | 0.5 B | Good | **⛔ CC-BY-NC-SA-4.0** ([card](https://huggingface.co/SparkAudio/Spark-TTS-0.5B)) | Non-commercial. |
| **Higgs Audio v2** | 3 B / 5.8 B | Good | **⚠️ "other"** (Boson custom) ([card](https://huggingface.co/bosonai/higgs-audio-v2-generation-3B-base)) | Custom terms, huge, GPU-only. |
| **NeuTTS Air** | 748 M | **English only** | Apache-2.0 ([card](https://huggingface.co/neuphonic/neutts-air)) | Has GGUF q4/q8 → llama.cpp-friendly, but **no Chinese**. `neutts-nano` (229 M) is licence "other", en only. |
| **Kitten TTS** | ~15 M ("nano") | **English only** | Apache-2.0 ([card](https://huggingface.co/KittenML/kitten-tts-nano-0.1)) | Tiny and cute, but English-only → irrelevant for the primary use case. |

### 3.5 ZipVoice (sherpa-onnx) — optional zero-shot cloning

`sherpa-onnx-zipvoice-distill-int8-zh-en-emilia` is **104 MB** int8 (456 MB fp32) and gives zh+en **zero-shot voice cloning** inside the same Apache-2.0 Node addon. Attractive if you later want "read this book in my voice". Costs a reference clip + transcript at runtime, and it is slower than MeloTTS. *Licence of the EmilA-derived weights not independently verified — check before shipping.*

### 3.6 Piper — still worth it? Mostly no, but its **voices** are

- `rhasspy/piper` is **archived** (last push **2025-08-26**), MIT, 11.3 k stars. The maintained fork **`OHF-Voice/piper1-gpl` is GPL-3.0** — that is a licensing landmine for a closed-source Electron app.
- Chinese voices do exist and are small: `zh_CN-huayan-medium` **64 MB**, `zh_CN-xiao_ya-medium` **58 MB** (int8 **13 MB**), `zh_CN-chaowen-medium` **58 MB** (int8 **13 MB**).
- **Quality: the weakest of the three.** Piper's Chinese training data is small; prosody is noticeably robotic and 多音字 errors are common. 13 MB is impressive engineering, not impressive audio.
- **Recommendation:** if you want Piper-class speed/size, consume **piper voices through sherpa-onnx** (Apache-2.0, same VITS architecture) and avoid the GPL engine entirely. But prefer **MeloTTS** over Piper zh for quality at only ~2.5× the size.

### 3.7 Integration shapes, ranked by how much pain they cause

| Shape | Examples | Electron cost | Verdict |
|---|---|---|---|
| **Native Node addon + ONNX** | `sherpa-onnx-node` | Prebuilt binaries for all 6 targets, ~23–34 MB/target. Needs `asarUnpack` (§4.3). Run in a `worker_thread` or `utilityProcess` because `generate()` is **synchronous and blocks the event loop**. | ✅ **Primary** |
| **Pure-JS + ONNX** | `kokoro-js` / `@huggingface/transformers` | No native build, but **English-only for Kokoro** and 30 MB of package. | ⚠️ English only |
| **Python sidecar** | CosyVoice 2/3, IndexTTS2, F5, GPT-SoVITS, Fish, MegaTTS3, MOSS-TTSD | 1–3 GB venv, per-OS Python bundling, 10–30 s model load, GPU assumptions, notarisation of an interpreter. | ⛔ Only for a "premium voice" plugin, never the default |
| **GGUF / llama.cpp** | NeuTTS Air | Cheap to run, but **no Chinese model** in this family yet | ⛔ Not applicable |
| **WebGPU in renderer** | Kokoro via transformers.js | Works, but competes with your reader's rendering, and still English-only | ⛔ |

---

## 4. Node / Electron package reality check

### 4.1 `kokoro-js` — verified English-only

`kokoro-js@1.2.1`, published **2025-05-03** (~18 months stale), **30.4 MB** unpacked, deps `@huggingface/transformers` + `phonemizer`.

From the source ([`kokoro.js/src/kokoro.js`](https://github.com/hexgrad/kokoro/blob/main/kokoro.js/src/kokoro.js)):

```js
_validate_voice(voice) {
  if (!VOICES.hasOwnProperty(voice)) { /* ... */ throw new Error(...) }
  const language = /** @type {"a"|"b"} */ (voice.at(0)); // "a" or "b"
  return language;
}
```

and `phonemize()` wraps the espeak-ng WASM package. There is **no `z` (Mandarin) path, no jieba, no `lexicon-zh`**. Passing `zf_xiaobei` throws. Note the `onnx-community/Kokoro-82M-v1.1-zh-ONNX` repo is `library_name: transformers.js` with `language: [en, zh]`, so *the model file* is usable from transformers.js — but kokoro-js's phonemizer/voice layer is not. **Rolling your own zh phonemisation in JS is the project you'd be signing up for.**

### 4.2 `sherpa-onnx-node` — the one that actually ships

`2.0.1`, published **2026-10-26**. Meta-package is **64 KB**; it declares **optional platform packages** so npm installs only yours:

| Target | Package | Size |
|---|---|---|
| macOS arm64 | `sherpa-onnx-darwin-arm64` | **34.1 MB** |
| macOS x64 | `sherpa-onnx-darwin-x64` | — |
| Windows x64 | `sherpa-onnx-win-x64` | **23.2 MB** |
| Windows arm64 / ia32 | `sherpa-onnx-win-arm64`, `-ia32` | — |
| Linux x64 | `sherpa-onnx-linux-x64` | **33.2 MB** |
| Linux arm64 | `sherpa-onnx-linux-arm64` | — |

So **yes — prebuilt binaries exist for darwin-arm64, win32-x64 and linux-x64**, which is exactly your matrix. That is the strongest cross-platform story of any option here.

### 4.3 ASAR / dylib pitfalls (verified)

- The docs tell you to `export DYLD_LIBRARY_PATH=.../sherpa-onnx-darwin-arm64`. **I tested it and it is not required** — `sherpa-onnx.node` has `LC_RPATH @loader_path` and links `@rpath/libsherpa-onnx-c-api.dylib` / `@rpath/libonnxruntime.dylib`, so the dylibs are found relative to the `.node` file. Good news, because `DYLD_*` is stripped for hardened-runtime apps anyway.
- **But** that `@loader_path` resolution breaks inside `app.asar`, because files in the archive are not real files. You **must** unpack all of it together:

```jsonc
// electron-builder.json
"asarUnpack": [
  "node_modules/sherpa-onnx-*/**"     // .node + *.dylib/*.so/*.dll must stay siblings
]
```

- The model files (100–350 MB) must live **outside** `asar` too (`extraResources`), in `app.getPath('userData')` — ship none, download on demand (§6.4), or you will blow past a sane `.dmg` size.
- **`generate()` is synchronous** and blocks. In the main process it freezes the app for 0.2–12 s. Use `utilityProcess.fork()` or `worker_threads`, and keep the TTS worker alive across chapters (model load is ~1.2–1.4 s here).
- Linux: ship `libsherpa-onnx-c-api.so` via `asarUnpack` as well and avoid `LD_LIBRARY_PATH`; `$ORIGIN` rpath should cover it, but **test on a real distro** — this is the least-verified platform in my testing.
- The maintainers themselves flag Electron-specific native issues (e.g. "for runtimes such as Electron that require JavaScript-owned buffers", set `enableExternalBuffer: false`; and an ONNX Runtime allocator trap on macOS Electron 43 seen with some models) — see the [Node addon examples README](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/README.md). Worth reading before you wire audio buffers.

### 4.4 `onnxruntime-node` — the packaging trap

`1.31.1`, published **2026-11-05**, supports `win32/darwin/linux` — but **307 MB unpacked** because it bundles **every** platform's binaries in one package. If you use `@huggingface/transformers` (which depends on it), you either accept that in your installer or prune it manually. `sherpa-onnx-node` avoids this by shipping its **own** ONNX Runtime inside the thin per-platform packages — a real advantage.

### 4.5 Nothing exists for Windows SAPI

Surveyed npm: `windows-tts@1.0.3` (**last modified 2022-05-24**, SAPI-based, abandoned). `edge-tts@1.0.1` / `msedge-tts@2.1.1` are **cloud** (Edge Read Aloud API) — not offline. There is **no maintained package** for Windows' on-device voices, which reinforces §5.

---

## 5. Windows 11 "Natural Voices" — is there a practical path?

Short answer: **not a reliable one, and not worth it.**

- The WinRT surface is `Windows.Media.SpeechSynthesis.SpeechSynthesizer`. From Node/Electron you reach it via (a) a **C++/C# N-API addon**, (b) **PowerShell** invoking WinRT (`[Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media,ContentType=WindowsRuntime]`) — slow (~300–800 ms process spawn per call) and awkward to get audio bytes out, or (c) a helper `.exe`. All are Windows-only native code, i.e. the exact maintenance burden you're trying to avoid.
- The deeper problem: Windows 11's good-sounding **Natural** voices are distributed for **Narrator** and gated per-app; what `SpeechSynthesizer.AllVoices` reliably returns to third-party apps is the **SAPI 5** set. Whether a given Natural voice is visible to your process is **OS-build- and edition-dependent**, and I could not verify it on real Windows hardware in this session. Treat any claim that "Windows natural voices work offline in Electron" as **unverified** until you test on a clean Win 11 box.
- Even when it works, you are back to "a built-in OS voice" — the thing the user rejected — and it does not exist on macOS/Linux, so it cannot be your cross-platform default.

**Verdict:** use it, if at all, as an opportunistic **Windows fallback** behind a feature flag, alongside Web Speech. Do not build the product on it.

---

## 6. Architecture: offline-first, cross-platform

### 6.1 Key insight — get sentence sync for free

Neural models do not give you word timings. You do not need them:

```
sentence i  ──synthesize──▶  Float32 audio, N_i samples @ 24 kHz
                              │
                              ├─ start_ms[i] = Σ(N_0..N_{i-1}) / 24000 * 1000
                              └─ duration_ms[i] = N_i / 24000 * 1000
```

Concatenate and you have an **exact** sentence→time map, independent of engine, language, or model. Highlighting a sentence is then a binary search on `currentTime`. This is strictly better than `onboundary` (which is word-level, coarse-timestamped, and only exists on macOS/Windows), and it works identically for MeloTTS, Kokoro, and even a future cloud engine.

**Do not** synthesise a whole chapter as one blob — you lose the offsets. Synthesise **per sentence (or per clause, splitting on `，。！？；：`), then concatenate**, and persist the offset table as JSON next to the audio.

### 6.2 Streaming vs pre-synthesis — pick by RTF

| Strategy | Works when | Measured evidence |
|---|---|---|
| **Sentence-by-sentence streaming** (synthesise *next* while playing *current*) | RTF < ~0.5 with margin | MeloTTS **0.24** ✅ — a 10 s sentence takes 2.4 s, so a 1-sentence lookahead is ample |
| **Background chapter pre-synthesis** (queue whole chapter, play when ready) | RTF 0.5–1.5 | Kokoro **0.83** ✅ — 11 min of audio ≈ 9 min of CPU; start it when the user opens the chapter |
| **Real-time only** | RTF < 0.3 | ❌ never rely on it cross-platform |

Recommended hybrid: **MeloTTS as the streaming "just press play" engine; Kokoro as an opt-in "high quality" voice that pre-synthesises the chapter in the background.** Both are the same addon and the same call shape — switching is a config change, not an architecture change.

### 6.3 Disk footprint (measured codec sizes)

Measured from `say` output (same encoder family you'd use): LPCM 22.05 kHz/16-bit mono = **2.67 MB/min**; AAC 48 kbit/s = **0.48 MB/min**. Theoretical Opus: 24 kbit/s = **0.18 MB/min**, 32 kbit/s = **0.24 MB/min**.

Chinese narration runs ~**4.5 chars/s**, so:

| Asset | Audio length | LPCM | AAC 48 k | **Opus 32 k** |
|---|---|---|---|---|
| 1 chapter (3 000 chars) | ~11 min | 29 MB | 5.3 MB | **2.6 MB** |
| 1 novel (100 k chars) | ~6.2 h | 992 MB | 178 MB | **89 MB** |
| 1 big novel (300 k chars) | ~18.5 h | 3.0 GB | 533 MB | **266 MB** |

**Ship Opus (or AAC-LC at 48–64 k) — never LPCM.** Opus at 24–32 kbps is transparent enough for speech and is the difference between "a 90 MB cache" and "a 3 GB cache".

Synthesis time for the same 18.5 h: **≈ 4.4 h** at MeloTTS RTF 0.24, **≈ 15.4 h** at Kokoro RTF 0.83 (M1, 4 threads). This is why you must synthesise **lazily, per chapter, on demand** — never "convert the whole book" as a first-run step.

### 6.4 Caching strategy

```
userData/
  tts/
    <bookHash>/
      <chapterId>/
        manifest.json      # {engine, modelVer, voice, speed, sampleRate, sentences:[{i,startMs,durMs,text}]}
        audio.opus
```
- **Cache key = `hash(engine + modelVersion + voiceId + speed + text)`**. Invalidate the whole chapter when any component changes — a model upgrade must not leave stale audio with a stale offset table.
- **LRU evict** by total size (cap ~500 MB–1 GB, user-configurable), never by age alone.
- **Prefetch policy:** current chapter + next 2. Do it on an idle callback and pause when the app is on battery *only if* the user complains — CPU TTS is cheap enough that a 2-chapter lookahead finishes in seconds with MeloTTS.
- **Store the offset table even if you delete the audio** — regenerating identical text with the same model/voice/speed is deterministic for VITS/Kokoro, so the timeline stays valid and you can re-synthesise on demand.

---

## 7. Comparison table (ranked by Chinese naturalness × cross-platform shippability × licence)

Rank = my judgement for *this* app; "RTF" is M1-measured where I could run it.

| # | Engine / model | Offline | Chinese quality | RTF (M1, 4 th) | Licence (commercial?) | Electron integration effort | Word/sentence sync | Ship? |
|---|---|---|---|---|---|---|---|---|
| **1** | **MeloTTS zh_en via `sherpa-onnx-node`** | ✅ | **Good** (best speed/quality balance; native 中英混排) | **0.24** ✅ | MIT (engine+weights) — verify tarball LICENSE | **Low** — prebuilt all 3 OS, `asarUnpack`, worker | Sentence sync by construction ✅ | **✅ Default** |
| **2** | **Kokoro-82M v1.1-zh via `sherpa-onnx-node`** | ✅ | **Very good** for 82 M; flat prosody | **0.83** ⚠️ | **Apache-2.0** ✅ | **Low** (same addon) | Sentence ✅; word via per-sentence | **✅ "HQ" option** |
| 3 | **Chatterbox Multilingual V3** (0.5 B) | ✅ | Good, 23 langs incl zh | ~2–4 *(est.)* | **MIT** ✅ | **High** — ONNX exists but no maintained Node wrapper; Python or custom ORT | Sentence ✅ | ⚠️ Only if cloning wanted |
| 4 | **CosyVoice 2 / 3** (0.5 B) | ✅ | **Excellent** | >1 on CPU, GPU real-time | Apache-2.0 ✅ | **Very high** — Python sidecar, 1–2 GB | Sentence ✅ (offsets) | ⚠️ Premium plugin only |
| 5 | **MOSS-TTSD v0.5** (2.05 B) | ✅ | Very good | ≫1 on CPU | Apache-2.0 ✅ | Very high — Python, GPU-centric | Sentence ✅ | ⛔ Too big |
| 6 | **VibeVoice-1.5B** | ✅ | Good zh+en, long-form | ≫1 on CPU | MIT ✅ | Very high | Sentence ✅ | ⛔ Too big |
| 7 | **MegaTTS3** | ✅ | Good | ≫1 | Apache-2.0 ✅ | Very high (Python) | Sentence ✅ | ⛔ |
| 8 | **Piper zh_CN-huayan/xiao_ya** via sherpa-onnx | ✅ | **Fair** (robotic, 多音字 errors) | ~0.1 *(est.)* | voices: MIT-ish; **engine fork now GPL-3.0** ⚠️ | Low via sherpa | Sentence ✅ | ⚠️ Emergency tiny-footprint tier (13 MB int8) |
| 9 | **Web Speech API** (AVSpeech/SAPI/SpeechDispatcher) | ✅ | macOS **good**; Win fair; **Linux poor** | real-time by definition | OS EULA | **Trivial** (no download) | **Word-level on macOS** (measured) ✅ | ✅ Fallback |
| 10 | **ZipVoice distill int8** (zh+en, cloning) | ✅ | Good + cloning | ~0.5 *(est.)* | Apache-2.0 repo; weights *unverified* | Low (sherpa) | Sentence ✅ | ⚠️ Optional |
| 11 | IndexTTS2 (~1.2 B) | ✅ | **Best open Chinese** | ≫1 | **⛔ bilibili licence** | Very high | Sentence ✅ | ⛔ Licence blocker |
| 12 | F5-TTS / ChatTTS / Spark-TTS / OpenAudio S1-mini | ✅ | Good | ≫1 | **⛔ CC-BY-NC(-SA)** | Very high | Sentence ✅ | ⛔ Non-commercial |
| 13 | Higgs Audio v2 (3 B) | ✅ | Good | ≫1 | ⚠️ custom "other" | Very high | Sentence ✅ | ⛔ |
| 14 | NeuTTS Air / Kitten TTS | ✅ | **English only** | fast | Apache-2.0 | Medium | — | ⛔ No Chinese |
| 15 | macOS `say` / AVSpeechSynthesizer helper | ✅ | good | real-time | OS EULA | High (native+signing) | word-level | ⛔ macOS-only, redundant |

Legend: ✅ good/usable · ⚠️ caveat · ⛔ blocker.

---

## 8. Recommendations

### R1 — Ship `sherpa-onnx-node` as the single native dependency, with **MeloTTS zh_en as the default voice** and **Kokoro-82M-zh as the "high quality" option**

One addon, one API, prebuilt binaries for `darwin-arm64` / `win32-x64` / `linux-x64` (23–34 MB each), Apache-2.0 engine. MeloTTS's measured **RTF 0.24** is what makes "press play and hear it in a second" possible on a mid-range Windows laptop; Kokoro's 0.83 is not, which is why it must be a background-pre-synthesised option rather than the default. Both consume the same `OfflineTts` config shape, so this is one integration with two model bundles.

### R2 — Make sentence-level sync a **data structure**, not an engine feature

Split chapter text on `。！？；…` (plus a max-length fallback at `，`), synthesise per sentence, store `{startMs, durMs, text, charRange}` in `manifest.json`, concatenate the PCM, encode once to Opus. Highlighting becomes `binarySearch(currentTime)` — exact, engine-agnostic, and it works on day one without waiting for `onboundary` support. This also gives you free **scrubbing**, **per-sentence replay**, and **"read from here"**.

### R3 — Run TTS in `utilityProcess`/`worker_threads`, never the main process

`generate()` is synchronous; a 3 000-character chapter at Kokoro RTF 0.83 blocks for 9 minutes if you call it naively. Keep one warm worker (model load ≈ 1.4 s), feed it sentences, stream `Float32Array` back via `MessagePort`, and play through an `AudioContext` in the renderer or `ffplay`-free Node-side encoder → Opus file. Set `backgroundThrottling: false` so playback survives a minimized window.

### R4 — Use Web Speech as the **zero-install first-run experience**, honestly labelled

On macOS it is genuinely good and — as I measured in your own Electron binary — gives **real word-level `onboundary` events for Chinese**, so the first launch can read aloud before any 140 MB download completes. On Windows it is acceptable; on Linux it is poor, so **on Linux, skip straight to the neural engine** (or hide read-aloud until the model is downloaded). Never present Web Speech as the product's voice quality; present it as "instant start".

### R5 — Do not ship a Python sidecar in v1; design the seam for it

CosyVoice 2 / IndexTTS2 are the only engines that reach "near-human" Chinese, and both are Python + 1–2 GB. That is not a dependency a small Electron app should own on three OSes. Instead: define the engine interface (`synthesize(text, voice, speed) → {samples, sampleRate}`) so a **"Premium voice (cloud or local sidecar)"** plugin can slot in later. This keeps the offline core small while leaving the door open — and lets you decide about cloud on business grounds rather than architecture grounds.

### R6 (optional) — Prefetch current + next 2 chapters, cap the cache at ~500 MB

With MeloTTS a 3 000-character chapter costs ~2.6 min of CPU and ~2.6 MB of Opus; prefetching two chapters is a few seconds of background work and makes chapter turns feel instant without a 3 GB disk bill.

---

## 9. Explicit uncertainties & version-dependencies

Read these before quoting any number above:

1. **No web search was available** (`DEEPSEEK_API_KEY` missing) and `huggingface.co` was unreachable (I used `hf-mirror.com`). Consequences: I could **not** verify numeric **WER / SIM / CMOS** benchmarks (SeedTTS-eval, CV3-eval) for any model. All "quality" statements are **subjective**, based on running Kokoro/MeloTTS locally and on model-card/repo claims — **not** on measured intelligibility scores. If you need defensible quality ranking, run an A/B listening test on your own book text.
2. **RTF numbers are 1 machine**: Apple **M1**, 8 cores, 16 GB, macOS 15.7.4, `sherpa-onnx-node@2.0.1`, ORT CPU EP, 4 threads. **The Windows x86 column is an estimate** (§3.1) and I flag it as such. An M4/M5 will be meaningfully faster; a 15 W Tiger Lake will be slower. Re-measure on your minimum spec.
3. **Intel Macs** (`darwin-x64`) exist as a package but I did not test them — and they are slow. If you still support Intel, budget RTF ×1.5–2.
4. **Linux is the least-verified platform.** I did not run `sherpa-onnx-linux-x64`, did not test `.so` rpath behaviour, and did not confirm that Speech Dispatcher exposes word boundaries (it likely does not).
5. **Licence facts are as of 2026-11-07 from model cards**, and model cards get edited. `MeloTTS` (non-commercial history upstream), `GPT-SoVITS` weights, `ZipVoice` weights and `CosyVoice 3` weights are **explicitly unverified** — get counsel before shipping any of them. `IndexTTS2` is **definitively** not free for commercial use.
6. **Piper's licence fork is recent and easy to get wrong**: `rhasspy/piper` = MIT but archived; `OHF-Voice/piper1-gpl` = **GPL-3.0**. If you link Piper, you are linking GPL code.
7. **`sherpa-onnx` English OOV behaviour changed in 2.0**: `--kokoro-data-dir` is deprecated/ignored, so unknown English words are **silently skipped** (`OOV word skipped: 'opened'`, observed). Chinese is unaffected. Pin the version you validate against.
8. **Windows 11 Natural Voices**: unverified on real hardware in this session. Do not promise it.
9. **Personal Voice**: not testable here (none enrolled). Version/entitlement dependent; assume unavailable to third-party apps.
10. **Web Speech pause/resume** and **hidden-window** behaviour were reasoned from Chromium source plus one probe; I did not run a long-duration hide/minimise test with audio. `stop_speaking_when_hidden_ = false` is the default in `tts_controller_impl.h`, but Electron's wiring should be confirmed with a 30-minute test.
11. **`say -o out.opus` hanging** and the **16-byte mp3** are behaviours of `/usr/bin/say` on **macOS 15.7.4** specifically; they may differ on other versions.

---

## 10. Reproducing the measurements

```bash
# 1. Speed (M1, ~3 min after download)
mkdir -p /tmp/ttsbench && cd /tmp/ttsbench && npm init -y
npm i sherpa-onnx-node@2.0.1
curl -L -o kokoro.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2
tar xf kokoro.tar.bz2
# then: DYLD_LIBRARY_PATH=$PWD/node_modules/sherpa-onnx-darwin-arm64 node bench.js
# (DYLD_LIBRARY_PATH turned out to be unnecessary — @loader_path rpath covers it)

# 2. Web Speech boundary probe inside your own Electron 38
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  --no-sandbox --disable-gpu --in-process-gpu probe.cjs
# NOTE: the DSH sandbox blocks Chromium's nested sandbox, hence --no-sandbox.

# 3. `say` codec sizes
say -v Tingting -o a.aiff -f zh.txt && say -v Tingting -o a.m4a --data-format=aac --bit-rate=48000 -f zh.txt
afinfo a.aiff; ls -l a.aiff a.m4a
```

*Report written 2026-11-07 by the research subagent. Primary sources were read directly (Chromium `content/browser/speech/*`, npm registry metadata, HuggingFace model cards, GitHub release asset listings), and the speed/behaviour claims were measured on the target platform rather than cited.*
