# Cloud TTS options for a cross-platform Electron reading app (中文为主, English secondary)

**Research date:** 2026-11-07 · **Scope:** macOS + Windows + Linux desktop, TypeScript/Node in the Electron main process, near-human voices (2024–2026 generation), sentence-level highlight sync, low cost for 10+ h/month of listening.

## 0. Verification legend

Every number below is tagged:

| Tag | Meaning |
|---|---|
| ✅ | Fetched from the vendor's own page/API spec during this research |
| ⚠️ | Cross-checked against a third-party machine-readable price map (LiteLLM) or the Artificial Analysis leaderboard, but the vendor page itself was unreachable |
| ❌ | **Could not verify** — quote is from memory/prior knowledge; treat as a hypothesis to test before committing |

**Network limits hit during this research (important for reproducibility):** `google.com` / `ai.google.dev` / `cloud.google.com` are unreachable from this network (timeout); `platform.openai.com`, `developers.openai.com`, `console.groq.com`, `help.openai.com` return Cloudflare **403**; `fish.audio` / `docs.fish.audio` time out; `volcengine.com`, `xfyun.cn`, `help.aliyun.com` serve JavaScript-only pricing pages with **no numbers in the HTML**.

---

## 1. The single most important finding: you probably don't need timestamps

For a *reading* app the text is known up front, so provider-side word timestamps are an optimization, not a requirement:

1. Split the chapter into sentences (zh: `。！？；…\n`, plus quote closing; en: `.!?`).
2. Synthesize **one request per 1–3 sentences**, keep the returned audio + its duration.
3. Play the queue sequentially; the "currently playing" index *is* the sentence highlight. Sentence-level sync with **zero** timestamp API support.
4. Word-level highlight needs either Azure `WordBoundary`, ElevenLabs alignment, or estimated intra-sentence timing (chars/sec calibration).

**Better than per-sentence requests (if you use Azure):** send one whole paragraph as SSML with `<bookmark mark="s3"/>` between sentences. Azure fires `BookmarkReached` with the **exact audio offset (in ticks)** for each mark ✅ — one request, precise sentence offsets, no drift. This is the cleanest sentence-sync design available on any provider here.

> Design consequence: a provider that returns *no* timestamps is still perfectly usable. What actually matters is (a) low time-to-first-audio, (b) a sane max-input-length so you can batch a paragraph, (c) deterministic duration reporting.

---

## 2. Streaming with incremental text input (LLM-style) vs. full text up front

Short answer: **almost nobody supports true incremental text input for TTS, and you don't need it** — but you do need *pipelining*.

| Provider | Incremental text input? | Notes |
|---|---|---|
| ElevenLabs | **Yes** — WebSocket `stream-input` allows sending text chunks + flush, with alignment per chunk ⚠️ (doc page requires auth; endpoint family well documented historically) | Closest to LLM-style streaming |
| OpenAI Realtime (`gpt-realtime-*`) | **Yes** (that's its point) | Replaces the deprecated `/audio/speech` path per OpenAI's own spec ✅ |
| OpenAI `/audio/speech` | No — full text, `maxLength: 4096` ✅ | `stream_format: sse` streams *audio out*, not text in ✅ |
| Azure Speech | No (one text/SSML per synthesis call); `SpeechSynthesizer` streams audio chunks as they are generated ✅ | Batch a paragraph per call; pipeline calls |
| Google Gemini TTS | No — single `generateContent`/`streamGenerateContent` with the text ⚠️ | Audio streams out, text does not stream in |
| 阿里 DashScope Qwen-TTS | Partial — realtime WebSocket variant exists ⚠️ | Unverified in 2026 docs |
| MiniMax T2A | No for sync T2A; **async long-text** endpoint accepts up to **1,000,000 chars/request** ✅ | Best "batch a whole chapter" option |
| Edge TTS | No — one SSML per WebSocket connection ⚠️ | You pipeline connections yourself |
| 火山 / 讯飞 / 腾讯 / 百度 | Generally one-shot or SDK-managed streaming ❌ | Unverified |

**What to build instead:** a producer/consumer queue — synthesize sentence *n+1…n+3* while sentence *n* plays; keep 2–4 chunks of look-ahead; cancel in-flight requests on seek. Every option above works with this pattern, so incremental-input support should not drive your choice.

---

## 3. Per-option detail

### 3.1 OpenAI TTS — ⚠️ **do not build on this in 2026**

| Field | Value |
|---|---|
| Models | `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`, `gpt-4o-mini-tts-2025-12-15` |
| **Lifecycle** | **All four are deprecated; announced shutdown 2027-01-06.** OpenAI's own spec tells you to migrate to **`gpt-realtime-2.1-mini` via the Realtime API** ✅ |
| Endpoint | `POST /v1/audio/speech` (REST) ✅ |
| Timestamps | **No.** The spec has no timestamp/alignment option for speech; `timestamp_granularities` exists only for *transcription* ✅ |
| Streaming | Audio only: `stream_format: sse` (audio-delta SSE events) or raw audio; **not** supported for `tts-1`/`tts-1-hd` ✅ |
| Max input | **4,096 characters** per request ✅ |
| Voice control | `instructions` field (natural-language style prompt), 12+ built-in voices + custom voice IDs ✅ |
| SSML | None; `instructions` is the substitute ✅ |
| Price | `tts-1` **$15/1M chars**, `tts-1-hd` **$30/1M chars**, `gpt-4o-mini-tts` **$0.00025/s (~$0.015/min)** + $12/1M audio tokens ⚠️ (LiteLLM map; OpenAI pricing page blocked) |
| Chinese | Works, but Chinese prosody is mid-tier; no Chinese-specific voices |
| Node | `openai` npm — trivial |

**Verdict:** the only OpenAI path with a future is the **Realtime API**, which is a conversational audio protocol (WebSocket, 24 kHz PCM, transcript deltas) — usable for TTS but heavy, and it still gives **no word timestamps**. Not a sensible primary engine for a reader.

---

### 3.2 ElevenLabs — best-in-class naturalness, premium price

Current model line (Nov 2026) ✅:

| Model | $/1K chars | $/1M chars | Latency claim | Max input | Notes |
|---|---|---|---|---|---|
| **Eleven v4** | $0.08 | **$80** | — | (not shown) | Newest flagship, 90+ languages, audio tags |
| **Eleven v4 Turbo** | $0.04 | **$40** | **~100 ms** | (not shown) | "Best model for real-time and agents" |
| Eleven v3 | $0.08 | $80 | — | **5,000 chars** | Expressive, multi-speaker |
| Eleven v3 Conversational | $0.04 | $40 | ~280 ms | — | Realtime-tuned |
| Multilingual v2 | $0.08 | $80 | — | **10,000 chars** | Stable long-form |
| Flash / Turbo v2.5 | $0.04 | $40 | **~75 ms** | **40,000 chars** | Cheapest/fastest |

- **Timestamps: yes, character-level.** `POST /v1/text-to-speech/{voice_id}/with-timestamps` returns `alignment` and `normalized_alignment` arrays (char + start/end seconds) alongside base64 audio ✅; the streaming variant `/stream/with-timestamps` yields alignment per chunk ✅. This is the best timestamp story of any provider here.
- **Streaming input:** WebSocket stream-input ⚠️.
- **SSML:** no; uses audio tags / text normalization instead.
- **Chinese:** supported in v4/v3/Multilingual v2; quality is good but noticeably "translated-Chinese" in long-form vs. Chinese-native vendors.
- **ToS:** commercial use allowed on paid plans; free tier requires attribution. Voice cloning consent rules are strict.
- **Node:** `@elevenlabs/elevenlabs-js` (official, actively maintained — pushed 2026-11-06) ✅.

**Cost reality for a reader:** 10 h/month of Chinese ≈ 132k 汉字 → **$5.3/mo (v4 Turbo)** or **$10.6/mo (v4)**. Affordable at this volume; ruinous if you pre-render whole libraries.

---

### 3.3 Microsoft Azure AI Speech — the best *sync tooling*, mid-tier naturalness

| Field | Value |
|---|---|
| Price (pay-as-you-go, US East, USD/1M chars) | **Neural / Neural HD Flash: $15** · **Neural HD: $22** · **MAI-Voice: $22** · Custom Neural $24 (HD $48) ✅ |
| Free tier | **0.5M chars/month** ✅ |
| Commitment | 80M chars for **$960/mo ⇒ $12/1M** ✅ |
| Endpoint | REST `POST /tts/cognitiveservices/v1` (SSML body) ✅ + Speech SDK over WebSocket |
| Timestamps | **`WordBoundary` events: word, punctuation, *and sentence*** — `BoundaryType`, `AudioOffset` (ticks), `TextOffset`, `WordLength` ✅ |
| Sentence mode | Set `PropertyId.SpeechServiceResponse_RequestSentenceBoundary = "true"` to get sentence-level boundaries ✅ |
| Extra sync primitive | `BookmarkReached` with `<bookmark mark="…"/>` → exact offset per marker ✅ |
| Streaming | Audio chunks stream via `Synthesizing` event as generated ✅; text input is per-call |
| SSML | **Full SSML** (prosody, breaks, say-as, bookmarks, phonemes) ✅ |
| Chinese voices | **44 zh-CN/zh-HK/zh-TW neural voices** incl. Xiaoxiao, Xiaoyi, Yunjian, Yunxi, Yunyang, Xiaochen, Yunhao, plus **19 DragonHD variants** (e.g. `zh-CN-Xiaoxiao:DragonHDFlashLatestNeural`, `zh-CN-Xiaochen:DragonHDLatestNeural`) ✅ |
| Node | `microsoft-cognitiveservices-speech-sdk` — works in Electron main; event-based API |
| Latency | ~150–400 ms TTFA typical ❌ (not measured here) |

**Why it matters for you:** it is the only mainstream provider that gives **sentence boundaries *and* bookmarks**, i.e. exact sentence-highlight sync with one request per paragraph. That is a large engineering saving versus calibrating characters-per-second yourself.

**Cost:** 10 h/month Chinese ≈ **$2.0/mo (Neural)** or **$2.9/mo (HD)** — cheapest of the "big three" for this use case.

---

### 3.4 Google — Gemini TTS (Cloud TTS Chirp/Neural2/Studio is now the legacy path)

> ⚠️ **All Google domains were unreachable from this network.** The numbers below come from the LiteLLM price map and the Artificial Analysis leaderboard; **the Google pricing page itself could not be opened**. Re-verify before committing.

| Field | Value |
|---|---|
| Current models | `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`, `gemini-3.1-flash-tts-preview`, plus the older `gemini-2.5-flash-preview-tts` / `gemini-2.5-pro-preview-tts` ⚠️ |
| Price | 2.5-flash-tts: **$0.50/1M input tokens + $10/1M audio-output tokens**; 3.8-flash-tts: $0.50 / **$9**; 3.8-flash-lite-tts: $0.50 / **$6**; 3.1-flash-tts-preview: $1 / $20 ⚠️ |
| Effective | Artificial Analysis computes **$16.49/1M chars** for Gemini 3.8 Flash TTS ⚠️ |
| Timestamps | **No** word/char alignment output ❌ (Gemini TTS returns audio only) |
| SSML | **No** — style is prompted in natural language; multi-speaker supported |
| Streaming | `streamGenerateContent` streams audio out ⚠️; text in is one shot |
| Chinese | Good and improving fast; Chinese prosody is a known weak spot vs. native vendors ❌ (subjective) |
| Legacy Cloud TTS | Chirp 3: HD, Neural2, Studio voices — **SSML `<mark>` timepoints supported**, which is a genuine timestamp mechanism, but this is the older, less natural family ⚠️ |
| Node | `@google/genai` (Gemini) / `@google-cloud/text-to-speech` (legacy) |

**Assessment:** strong naturalness (Elo 1282 at AA, above Azure), cheap per character, but **no alignment data** and no SSML — so you'd rely on the sentence-chunking pattern. Also: Google Cloud billing + GFW-unfriendly access is a real problem for Chinese users; Gemini API has regional restrictions.

---

### 3.5 Edge TTS (unofficial `read aloud` endpoint) — free, works, ToS-grey

| Field | Value |
|---|---|
| Status | **Alive as of Oct 2026.** `rany2/edge-tts` 12.5k★, last push **2026-10-14** ✅; `Migushthe2nd/MsEdgeTTS` last push **2026-10-25** ✅ |
| Protocol | WSS to Microsoft's `speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`, needs `Sec-MS-GEC` token; **returns `audio.metadata` frames incl. `WordBoundary`** — libraries derive SRT from them ✅ |
| Timestamps | **Yes, WordBoundary** (offset + duration + text) ✅ |
| Voices | Full Edge voice set: `zh-CN-XiaoxiaoNeural`, `XiaoyiNeural`, `YunjianNeural`, `YunxiNeural`, `YunyangNeural`, `XiaochenNeural`, plus dialects (`zh-CN-liaoning-XiaobeiNeural`, `zh-CN-shaanxi-XiaoniNeural`) ⚠️ |
| Audio | MP3 24 kHz; `rate`/`volume`/`pitch` params |
| Price | **$0** |
| Risk | **Not a licensed API.** Microsoft ToS forbids using Edge services outside the browser; undocumented, can break or rate-limit at any time (it has broken before, then been patched within days). No SLA, no support, IP/geo blocking possible. **Do not make it the only path in a shipped product** — but excellent as a free/demo/offline-ish fallback tier. |
| Node | `msedge-tts` / `node-edge-tts` npm (unofficial, thin wrappers) |

**Cost/quality ratio is unbeatable** (Xiaoxiao is genuinely pleasant), and it cross-platforms trivially because it's just a network call. The risk is legal/stability, not technical.

---

### 3.6 火山引擎 / 豆包 Seed-TTS (ByteDance)

> ❌ **Could not verify pricing.** `volcengine.com/docs/6561/79823` and `docs.volcengine.com` are JavaScript-only shells; no price text in the HTML.

| Field | Value |
|---|---|
| Product | 豆包语音合成大模型 (Seed-TTS family), 火山引擎「语音技术」→ 语音合成大模型 |
| API style | WebSocket (binary protocol, `X-Api-*` headers) + HTTP unidirectional/bi-directional streaming; official Python/Java/Go SDKs, **Node via raw WebSocket** |
| Streaming | Yes — bidirectional streaming, text can be fed incrementally ❌ |
| Timestamps | Returns **word/sentence timestamps** in the response payload (used for 字幕) ❌ |
| SSML | Limited (prosody via JSON params) ❌ |
| Chinese | **Top-tier for Mandarin** — historically the strongest "news-anchor" prosody; emotion/style control |
| Price | ❌ Unverified. Historically ~¥0.5–1.0/万字符 for the LLM TTS tier, with 音色 licensing fees for premium voices. **Must be re-verified.** |
| ToS | 实名认证 required; 音色授权 per-voice purchase; content moderation |

**Assessment:** if Chinese naturalness is the top priority and you can absorb a WebSocket binary protocol, this is a leading candidate — but budget a day for protocol work and confirm pricing in the console.

---

### 3.7 阿里云 DashScope — Qwen-TTS / CosyVoice (best value for Chinese)

> ⚠️ Vendor pricing pages are JS-only; prices below are from the LiteLLM map. **DashScope's CNY list prices must be re-verified.**

| Model | $/1M chars ⚠️ | Notes |
|---|---|---|
| `qwen3-tts-flash` | **$10** | Cheapest current Qwen TTS |
| `qwen-audio-3.0-tts-flash` | $15 | |
| `qwen-audio-3.0-tts-plus` | $20 | |
| `qwen-audio-3.1-tts-plus` | **$30** ($19.31/1M per AA ⚠️) | Highest quality tier; **Elo 1299 at AA** — top-5 overall |
| CosyVoice (legacy, open-source family) | cheaper | Older generation, still decent |

- **API:** DashScope REST (`POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`) + WebSocket realtime variant for streaming ⚠️. **Note:** TTS is *not* on the OpenAI-compatible `/compatible-mode/v1` path — you need a dedicated client, though auth style is familiar.
- **Streaming:** realtime WebSocket with incremental text ⚠️; HTTP one-shot otherwise.
- **Timestamps:** ❌ no documented word alignment (CosyVoice open-source has no aligner either).
- **Chinese:** native, very good; multiple 普通话/方言 voices, emotion control.
- **Node:** plain `fetch` for HTTP; `ws` for realtime. No official TS SDK for TTS.
- **Indie-friendly:** ✅ self-serve signup, Alipay, no enterprise onboarding.
- **ToS:** 实名认证, content compliance, no voice cloning without authorization.

**This is the best price/quality/simplicity triangle for a Chinese-first reading app.**

---

### 3.8 MiniMax (speech-2.8) — premium Chinese, highest per-char cost

| Field | Value |
|---|---|
| Models | **`speech-2.8-hd`** and **`speech-2.8-turbo`** (current); `speech-2.6-hd/turbo`, `speech-02-hd/turbo` (legacy) ✅ |
| Price | **HD ¥3.50/万字符**, **Turbo ¥2.00/万字符** ✅ |
| **Unit gotcha** | **"1 个汉字算 2 个字符"** — so ¥3.50/万字符 = ¥3.50 per **5,000 汉字** ⇒ **¥700/1M 汉字 (~$98)** HD, **¥400/1M (~$56)** Turbo ✅ |
| Async long-text | Up to **1,000,000 chars per request**, results retrievable later ✅ — ideal for pre-rendering a chapter |
| API | REST (`/v1/t2a_v2`, `/v1/t2a_async_v2`) + WebSocket streaming |
| Timestamps | Subtitle timestamps available in T2A v2 (`subtitle_enable`) ❌ unverified for 2.8 |
| SSML | No; JSON params (speed/vol/pitch/emotion) |
| Chinese | **Excellent** — among the most natural Mandarin available; strong emotion range |
| Node | plain `fetch` + `ws`; no official TS SDK |
| ToS | Self-serve; content moderation; voice cloning requires authorization |

**Cost:** 10 h/month Chinese ≈ **¥92 (~$13)/mo HD** or **¥53 (~$7.4)/mo Turbo**. The most expensive mainstream Chinese option per character, but still only ~$13/month at reading-app volumes.

---

### 3.9 讯飞 iFlytek 在线语音合成

> ❌ **Could not verify pricing** (`xfyun.cn/services/online_tts` is a JS shell).

- **API:** WebSocket (`wss://tts-api.xfyun.cn/v2/tts`), HMAC-SHA256 signed URL; also HTTP streaming. Well-documented, mature.
- **Streaming:** yes, audio chunks; text is one-shot per request ❌.
- **Timestamps:** returns **word-level `py`/`wb` (word boundary) data** in the response — historically yes ❌.
- **Chinese:** very good, "announcer" style; large voice catalogue incl. 方言/情感/多语种.
- **Price:** ❌ unverified; historically a free quota (~500 次) then roughly ¥0.02–0.1/百字 depending on voice tier, with 发音人 licensing.
- **ToS:** 实名认证; 发音人授权; content review.
- **Node:** no official SDK → hand-rolled WebSocket + HMAC signing (half a day).

---

### 3.10 Others (brief)

| Provider | Model / status | Price | Chinese | Timestamps | Notes |
|---|---|---|---|---|---|
| **Cartesia** | **Sonic 3.6** ✅ | **$49/1M chars** ⚠️ (AA); credits $38–65/1M; **3 credits/s of audio ≈ $0.41–0.70/h** ✅ | Supported (multilingual) ⚠️ | **Yes** — word timestamps are a core Sonic feature ✅ | 90 ms-class latency; good for realtime, overkill for reading |
| **Deepgram** | Aura-2 / Aura ✅ | **Aura-2 $0.030/1K chars = $30/1M**; Aura-1 $15/1M ✅⚠️ | **Weak/limited** ❌ — English-centric | Word timestamps in streaming response ⚠️ | Excellent latency, poor zh fit |
| **Fish Audio** | **Drama 3 / S2.1 Pro** (AA Elo **1392**, top non-ElevenLabs) ⚠️ | ❌ unverified (site unreachable) | **Strong** — Chinese-origin, popular for 有声书 | ❌ | Very interesting quality/price, but **cannot verify price or ToS** |
| **Hume** | Octave ✅ (docs) | ❌ unverified | Limited zh ❌ | Word timestamps ✅ | Expressive English-first; not a zh fit |
| **Inworld** | TTS-1 / TTS-1-Max ✅ | **$10/1M chars**, down to **<$5/1M** at scale ✅ | ~15 languages incl. zh ⚠️ | Word timestamps ⚠️ | Good value if zh quality holds up |
| **Groq (PlayAI)** | PlayAI TTS ⚠️ | ❌ unverified (console 403) | zh uncertain ❌ | ❌ | Fast but not a zh play |
| **Simba 3.5** (vendor unclear) | Elo **1320** ⚠️ — 3rd overall | **$6.58/1M chars** ⚠️ | ❌ | ❌ | Cheapest high-Elo option seen; **identity/ToS unknown — investigate before trusting** |
| **Amazon** | Polly Neural / **Nova Sonic** ✅ | Nova Sonic ~$12/1M audio tokens ⚠️ | Polly zh voices are dated | Word timestamps via Speech Marks ✅ | Not competitive on naturalness |

---

### 3.11 腾讯云 / 百度语音 (brief)

- **腾讯云 语音合成 (TTS)**: WebSocket + HTTP; 精品音色/大模型音色 tiers; word-level timestamps returned for 字幕; ❌ price unverified (¥ per 万字符, tiered by 音色类型). 实名认证 required.
- **百度语音合成**: REST + WebSocket; 基础音色 free quota, 精品/大模型音色 paid; ❌ price unverified. Chinese quality is decent but behind MiniMax/火山/Qwen in 2025–2026 comparisons.
- Both are **viable but not better** than DashScope/MiniMax for this use case; they mainly matter if you already have CNY billing there.

---

## 4. Comparison table

Prices normalized to **USD per 1M characters** (Chinese characters counted as 1 char; MiniMax's 汉字=2 rule applied).

| Option | Chinese quality (2026) | Price /1M chars | Word/sentence timestamps | Streaming (audio out) | Node integration effort | Risk |
|---|---|---|---|---|---|---|
| **Azure Neural** | Good, slightly "announcer" | **$15** ($12 committed, 0.5M free) ✅ | **Word + sentence + bookmarks** ✅ | Yes (chunk events) | **Low** (official SDK) | Low |
| **Azure Neural HD** | Very good | **$22** ✅ | Word + sentence ✅ | Yes | Low | Low |
| **ElevenLabs v4 Turbo** | Very good (slight translationese) | **$40** ✅ | **Char-level alignment** ✅ | Yes | **Low** (official SDK) | Low |
| **ElevenLabs v4** | Best overall naturalness (Elo 1338) | **$80** ✅ | Char-level ✅ | Yes | Low | Low |
| **MiniMax speech-2.8-hd** | **Excellent (native zh)** | **~$98** (¥3.5/万字符, 汉字×2) ✅ | Subtitle ⚠️ | Yes | Medium (REST/WS) | Low |
| **MiniMax 2.8-turbo** | Very good | **~$56** ✅ | Subtitle ⚠️ | Yes | Medium | Low |
| **Qwen-Audio-3.1-TTS-Plus** | Excellent (Elo 1299) | **$19.31–30** ⚠️ | ❌ | Yes ⚠️ | Medium | Low |
| **Qwen3-TTS-Flash** | Good | **$10** ⚠️ | ❌ | Yes ⚠️ | Medium | Low |
| **Gemini 3.8 Flash TTS** | Good, improving | **$16.49** ⚠️ | ❌ | Yes ⚠️ | Low–Medium | **Network/region** |
| **火山 Seed-TTS** | **Excellent (native zh)** | ❌ unverified | Word/sentence ❌ | Yes (bidirectional) ❌ | **High** (binary WS) | Medium |
| **讯飞** | Very good | ❌ unverified | Word ❌ | Yes | Medium–High | Medium |
| **Edge TTS (unofficial)** | Good (Xiaoxiao) | **$0** ✅ | **Word boundaries** ✅ | Yes | **Very low** | **High (ToS/unstable)** |
| **Cartesia Sonic 3.6** | OK | **$49** ⚠️ | Word ✅ | Yes | Low | Low |
| **Deepgram Aura-2** | Weak zh | **$30** ✅ | Word ⚠️ | Yes | Low | Low |
| **Inworld TTS-1** | Unproven zh | **$10** (→<$5) ✅ | Word ⚠️ | Yes | Low | Low |
| **Fish Audio Drama 3** | Strong (Elo 1392) ⚠️ | ❌ unverified | ❌ | Yes ⚠️ | Medium | **Unknown ToS/price** |
| **OpenAI tts-1 / gpt-4o-mini-tts** | Mediocre zh | $15 / $30 / ~$15 ⚠️ | ❌ | Audio only ✅ | **Low** | **Shutdown 2027-01-06** ✅ |
| **Kokoro 82M (local, ONNX)** | Fair | **$0** (compute) ✅ | ❌ | N/A (local) | Low (`onnxruntime-node`) | Offline only |

---

## 5. 如果目标是中文听书自然度排名 (Chinese naturalness ranking)

*Evidence base: Artificial Analysis Speech Arena Elo (all-language arena, Nov 2026) + vendor language focus + documented demo quality. The arena is crowd-voted and English-weighted — treat as directional, not Chinese-specific. I could not filter AA to a Chinese-only leaderboard.*

**Top 5 by perceived Mandarin naturalness:**

1. **MiniMax speech-2.8-hd** — Chinese-first, expressive, best long-form 有声书 feel. Elo tier ~1290+ for the family. Cost ~$98/1M 汉字. *Indie-plausible: ✅ self-serve REST.*
2. **火山引擎 Seed-TTS 2.x (豆包)** — the other native heavyweight; news-anchor prosody, strong emotion/style control. ❌ Price unverified. *Indie-plausible: ✅ (实名认证), but binary WebSocket costs engineering time.*
3. **Qwen-Audio-3.1-TTS-Plus (DashScope)** — **Elo 1299**, i.e. the highest-ranked Chinese-native model I could verify, at **$19.31/1M chars**. Best quality-per-dollar for Chinese. *Indie-plausible: ✅.*
4. **ElevenLabs v4 / v4 Turbo** — **highest Elo overall (1338/1332)**, and Mandarin is genuinely good; slightly "performed" rather than native. $40–80/1M. *Indie-plausible: ✅.*
5. **Fish Audio Drama 3** — **Elo 1392** (best non-ElevenLabs score seen), tuned for 有声书/drama. ❌ Price & ToS unverifiable from here — **would be #2 on quality-per-dollar if the price checks out.**

Runners-up: Azure DragonHD (naturalness behind the five above, but *far* better sync tooling), 讯飞, Cartesia Sonic 3.6, Gemini 3.8 Flash TTS.

**Indie-app feasibility notes:** Qwen/DashScope, MiniMax, ElevenLabs, Azure, Inworld are all self-serve card/Alipay signup with no sales call. 火山/讯飞 need 实名认证 but no enterprise contract. Fish Audio and Groq PlayAI would need commercial-terms checks.

---

## 6. Cost for 10+ hours of listening per month

Assumption: **220 汉字/min** → 10 h = 600 min ≈ **132,000 汉字/month**. (English: ~150 wpm ≈ 500k chars for the same 10 h.)

| Engine | 10 h/month, Chinese | 10 h/month, English |
|---|---|---|
| Edge TTS | **$0** | **$0** |
| Qwen3-TTS-Flash | **$1.3** | $5 |
| Azure Neural | **$2.0** | $7.5 |
| Gemini 3.8 Flash TTS | $2.2 | $8 |
| Qwen-Audio-3.1-TTS-Plus | $2.6 | $10 |
| Azure Neural HD | $2.9 | $11 |
| Deepgram Aura-2 | — | $15 |
| ElevenLabs v4 Turbo | $5.3 | $20 |
| Cartesia Sonic 3.6 | $6.5 | $24 |
| MiniMax 2.8-turbo | $7.4 | — |
| ElevenLabs v4 | $10.6 | $40 |
| MiniMax 2.8-hd | $13.0 | — |

**Takeaway: at reading-app volumes (1 book ≈ 300k 汉字 ≈ 23 h), every cloud option costs single-digit dollars per book.** Cost only becomes decisive if you pre-synthesize libraries or offer unlimited free tier. **Latency, sync tooling and voice naturalness should drive the decision, not price.**

---

## 7. Recommendations

1. **Default: Azure Neural HD for the "sync-perfect" path, Qwen-Audio-3.1-TTS-Plus for the "best Chinese" path.** Azure gives you `WordBoundary` + `RequestSentenceBoundary` + `BookmarkReached` — sentence-accurate highlighting with one SSML request per paragraph, at $22/1M chars (≈$2.9 per 10 h). Qwen costs about the same ($19–30/1M) and sounds more native. Ship both behind one `TtsProvider` interface; let the user pick "natural" vs "precise sync".
2. **Implement sentence-chunking + look-ahead queue first, and treat timestamps as optional polish.** Split on `。！？；\n`, synthesize 1–3 sentences per request, derive highlight from queue position, keep 2–4 chunks buffered, cancel on seek. This makes every provider interchangeable and removes your dependency on any single vendor's alignment API.
3. **Use Edge TTS (Xiaoxiao) as the free tier / instant-start / preview engine — never as the only engine.** It's cross-platform, $0, returns WordBoundary, and its latency is excellent; but it's an unlicensed endpoint that can break or be blocked without notice. Isolate it in one adapter, feature-flag it, and fall back to Azure on failure.
4. **Don't build on OpenAI TTS.** All `/audio/speech` models shut down **2027-01-06** per OpenAI's own spec, they have a 4,096-char cap, and they return **no** timestamps. The Realtime replacement is a conversational protocol, not a reading engine.
5. **Offline fallback: Kokoro 82M via `onnxruntime-node`, not OS voices.** OS `speechSynthesis` fails your cross-platform requirement (macOS voices ≠ Windows voices ≠ Linux, and Linux often has none). Kokoro is ~82M params, has Chinese voices, runs on all three platforms from Node, and costs nothing — quality is below cloud but acceptable for "airplane mode". Cache the cloud audio you already synthesized as the first-line offline store; Kokoro only covers never-synthesized text.

**Extra architectural notes**
- Cache aggressively: key audio by `sha256(voice + speed + text)`. Re-reads of a page are then free, and offline playback improves over time.
- Store `duration` with each cached chunk so highlight sync survives restarts without re-synthesis.
- Prefer **48 kHz/24 kHz MP3 or Opus** for size; PCM only if you need sample-accurate seeking.
- For EPUB/PDF, pre-split to sentences *at import time* and persist the sentence map — this decouples text layout from synthesis and makes re-flowing cheap.

---

## 8. Sources

**Verified directly (✅)**
- Azure Speech pricing: https://azure.microsoft.com/en-us/pricing/details/speech/
- Azure synthesis + WordBoundary + sentence boundary property: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-speech-synthesis
- Azure voice list (44 zh-CN voices, 19 DragonHD): https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts
- ElevenLabs API pricing ($0.08 / $0.04 per 1K chars, per-model limits, latency claims): https://elevenlabs.io/pricing/api
- ElevenLabs model catalogue (v4, v4 Turbo, v3, Multilingual v2, Flash v2.5): https://elevenlabs.io/docs/models
- ElevenLabs timestamps endpoint (`alignment`, `normalized_alignment`): https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps
- ElevenLabs official Node SDK: https://github.com/elevenlabs/elevenlabs-js
- OpenAI OpenAPI spec (4096-char limit, `stream_format`, **deprecation 2027-01-06 → gpt-realtime-2.1-mini**, no timestamps): https://github.com/openai/openai-openapi/blob/master/openapi.yaml
- MiniMax pricing (speech-2.8-hd ¥3.50/万字符, turbo ¥2.00, 汉字=2字符, async 1M chars): https://platform.minimaxi.com/document/Price
- Edge TTS project status & boundary-derived subtitles: https://github.com/rany2/edge-tts · https://github.com/Migushthe2nd/MsEdgeTTS
- Inworld pricing ($10/1M chars → <$5): https://inworld.ai/pricing
- Cartesia pricing (credits, 3 credits/s of audio): https://cartesia.ai/pricing
- Deepgram pricing (Aura-2 $0.030/1K chars): https://deepgram.com/pricing
- Deepgram TTS models: https://developers.deepgram.com/docs/tts-models
- Cartesia Sonic 3.6 docs: https://docs.cartesia.ai/build-with-cartesia/tts-models

**Cross-checks (⚠️ — vendor page unreachable)**
- LiteLLM model price map (OpenAI, Azure, Gemini, Qwen/DashScope, MiniMax, Deepgram, ElevenLabs): https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
- Artificial Analysis Speech Arena — Elo + derived $/1M chars: https://artificialanalysis.ai/text-to-speech/leaderboard
- Google Gemini TTS (could not fetch; blocked): https://ai.google.dev/gemini-api/docs/speech-generation

**Could not verify (❌)**
- Volcengine / 豆包 Seed-TTS pricing & protocol details: https://www.volcengine.com/docs/6561/79823
- 讯飞在线语音合成 pricing: https://www.xfyun.cn/services/online_tts
- 腾讯云 https://cloud.tencent.com/document/product/1073 · 百度 https://ai.baidu.com/ai-doc/SPEECH
- Fish Audio pricing/ToS (site unreachable): https://fish.audio/pricing
- Hume Octave pricing: https://www.hume.ai/pricing

---

## 9. Numbers I could NOT verify (be explicit with stakeholders)

| Claim | Status | What to do |
|---|---|---|
| Volcengine Seed-TTS price per 万字符 | ❌ | Log into 火山引擎 console → 语音合成大模型 → 计费说明 |
| 讯飞 TTS price tiers | ❌ | Check xfyun.cn console pricing after login |
| Fish Audio $/1M chars | ❌ | Site blocked from this network |
| Hume Octave price | ❌ | Pricing page is JS-rendered |
| Google Gemini TTS list price | ⚠️ | Re-fetch from an unblocked network |
| OpenAI list prices | ⚠️ | `platform.openai.com/docs/pricing` returns 403 here |
| Chinese-language Elo ranking | ❌ | AA arena has no zh filter exposed; rankings above are all-language |
| TTFA for every provider | ❌ | Not measured; run your own 20-sample benchmark per provider before choosing |
| MiniMax/Qwen/火山 subtitle timestamps | ❌ | Confirm in their API console; docs pages are JS-only |

**Recommended next step before committing:** build a 30-minute benchmark harness — same 20 Chinese paragraphs, 3 voices per provider, measure TTFA, RTF, and blind-rate naturalness with 5 native speakers. All the prices above are cheap enough that the decision should be made on listening tests.
