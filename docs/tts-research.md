# 朗读（TTS）方案调研

> 调研时间：2026-11-07 | 状态：已完成，待决策
> 约束：**跨平台**（macOS / Windows / Linux）、**拟真自然**（优先 2024–2026 代模型）、中文为主、英文为辅、长文听书（10h+/月）

## 0. 结论

**云端神经 TTS 是唯一同时满足「跨平台 + 接近真人」的路线。** 端侧神经网络在 2026 年仍然只是「能听」，达不到听书的自然度；系统内置语音跨平台一致性差且音色明显过时。

推荐分层落地：

| 层 | 引擎 | 定位 | 成本 | 同步能力 |
|---|---|---|---|---|
| **免费层（默认）** | Edge Read Aloud（微软晓晓等 14 个中文音色） | 零配置、开箱即用 | **$0** | **字级**（WordBoundary，已实测） |
| **付费层（BYO Key）** | Azure 官方语音 / 阿里 DashScope Qwen-TTS / MiniMax | 稳定性 + 中文自然度上限 | $2–13 / 10h | Azure 字/句级 + SSML bookmark |
| **离线层（可选）** | 缓存 → sherpa-onnx（Matcha / MeloTTS / Kokoro 分档）→ 本地 TTS 端点 | 无网/隐私/免费 | $0 | 句子级（按句合成天然对齐） |
| **兜底层** | Web Speech API | 首启无下载即可开口 | $0 | macOS 字级；Win 一般；Linux 差 |

**不推荐**：OpenAI TTS（官方 spec 已标注 `tts-1`/`tts-1-hd`/`gpt-4o-mini-tts` 于 **2027-01-06 关停**，且完全不返回时间戳）；macOS `say` / AVSpeechSynthesizer（平台独占）。

## 1. 四条关键判断

### 1.1 系统语音不能作为主路线

Web Speech API 在 Electron 里确实跨平台可调（本机实测 Electron 38 / Chromium 140：191 个音色、21 个中文音色、词级 `onboundary` 可用），但「跨平台」只是 API 一致，**发声质量完全由 OS 决定**：

- macOS：AVSpeechSynthesizer，婷婷/美佳等，可用但明显是「机器朗读」；
- Windows：SAPI5（慧慧/瑶瑶），比 macOS 更机械；
- Linux：Speech Dispatcher / espeak，机械感最强，且部分发行版**根本没有可用音色**。

三条要求里它只满足「跨平台」，因此只能做兜底。

### 1.2 端侧神经网络：2026 年还不到「听书」

本机（M1 / 8 核 / 16GB）用 `sherpa-onnx-node@2.0.1` 实测同一段 62 字中文：

| 模型 | 精度 | 线程 | 实时率 RTF ↓ | 听感 |
|---|---|---|---|---|
| MeloTTS zh_en | fp32 | 4 | **0.24** | 中英混排自然，音色偏播音 |
| Kokoro-82M v1.1 (zh+en) | int8 | 4 | **0.83** | 音色更好，语调偏平 |
| Kokoro-82M (CoreML EP) | int8 | 4 | 0.82 | CoreML 无收益（动态 shape 回退 CPU） |

RTF < 1 才能边合成边播。MeloTTS 有 4 倍余量，Kokoro 在弱一些的 Windows 机器上会掉到实时以下。两者听感都**明显低于云端**：语调平、无重音、多音字偶发错误。

真正接近真人的开源中文模型（CosyVoice 2/3、IndexTTS2、MOSS-TTSD、Fish）都是 0.5B–8B、PyTorch 优先、1–3GB 的 Python sidecar，且 IndexTTS2 是 B 站商业授权、F5/ChatTTS/Spark/OpenAudio 是 CC-BY-NC，不能直接商用。**端侧定位为离线补偿，不是产品音色。**

### 1.3 「逐字高亮」不需要依赖厂商时间戳

听书应用文本是已知的，同步可以完全由架构保证：

1. 按句切分（`。！？；…\n`，中英混排加 `.!?`，超长句在 `，` 处兜底）；
2. **一句（或 1–3 句）一次合成请求**，记录每段的 `{startMs, durMs, charRange}`；
3. 播放队列的位置就是高亮位置 —— 任何引擎都有句子级同步；
4. 想要「卡拉OK」式字级高亮时，才需要厂商边界事件：Azure `WordBoundary`、Edge `WordBoundary`、ElevenLabs `with-timestamps` 都行。

**推论**：不返回时间戳的引擎（Qwen、Gemini、MiniMax）依然完全可用。不要用「有没有时间戳」当筛选条件。

Azure 还有一个独特优势：一次请求整段 SSML，句间插入 `<bookmark mark="s3"/>`，回调 `BookmarkReached` 给出每句精确音频偏移 —— 段落级合批 + 精确句级定位，是所有方案里同步最省事的。

### 1.4 在听书量级下，价格不是决定性因素

按中文 220 字/分钟、10 小时/月 ≈ **13.2 万字** 估算（1 本书 30 万字 ≈ 23 小时）：

| 引擎 | 10h/月 | 备注 |
|---|---|---|
| Edge Read Aloud | **$0** | 非官方接口 |
| Qwen3-TTS-Flash | ~$1.3 | ⚠️ 价格需复核 |
| Azure Neural | ~$2.0 | $15/1M，0.5M/月免费 ✅ |
| Azure Neural HD | ~$2.9 | $22/1M ✅ |
| ElevenLabs v4 Turbo | ~$5.3 | $40/1M ✅ |
| MiniMax 2.8-turbo | ~$7.4 | 注意「1 汉字 = 2 字符」 |
| ElevenLabs v4 | ~$10.6 | $80/1M ✅ |
| MiniMax 2.8-hd | ~$13.0 | 中文自然度第一梯队 |

**每本书都是个位数美元。** 决策应该由自然度、延迟、同步体验和分发模式（自备 Key 还是内置额度）决定，而不是单价。

## 2. 候选清单

### 2.1 云端

| 方案 | 中文自然度 | 价格 /1M 字符 | 时间戳 | Node 接入 | 风险 |
|---|---|---|---|---|---|
| **Edge Read Aloud**（非官方） | 好（晓晓/云希/云健） | **$0** | **字级** ✅实测 | 极低（`ws`） | ToS 灰色、可能被限流/封锁 |
| **Azure 官方语音** | 好（偏播音）→ HD 很好 | $15（HD $22）✅ | **字/句 + bookmark** ✅ | 低（官方 SDK） | 国内需国际版 Azure |
| **阿里 DashScope Qwen-TTS** | **很好**（Elo 1299） | ~$19–30 ⚠️ | 无 | 中（REST/WS） | 需实名 |
| **MiniMax speech-2.8** | **最好**（中文原生） | ~$98（hd）/ $56（turbo） | 字幕级 ⚠️ | 中 | 单价最高 |
| **火山 Seed-TTS（豆包）** | **最好**（新闻腔） | ❌未核实 | 字/句 ❌ | 高（二进制 WS） | 协议工程量 |
| **ElevenLabs v4 / v4 Turbo** | 很好（略「演」） | $80 / $40 ✅ | **字符级** ✅ | 低（官方 SDK） | 英文书更划算 |
| **Gemini TTS** | 好，进步快 | ~$16 ⚠️ | 无 | 低 | 国内网络不可达 |
| **OpenAI TTS** | 一般 | $15 / $30 | **无** | 低 | **2027-01-06 关停** ✅ |

补充：Cartesia Sonic（$49，字级时间戳、延迟极低）、Inworld（$10）、Deepgram（中文弱）、Fish Audio（Elo 1392 但价格/ToS 无法核实）。

### 2.2 离线：六种形态，不止「装个模型」

先分清诉求：用户说「离线」通常是三件事之一 —— ① 没网也能听**新**内容；② 隐私，文本不出本机；③ 不想付 API 钱。三者对应的方案不一样。

| 形态 | 代表 | 体积 | 中文质量 | 接入成本 | 适合 |
|---|---|---|---|---|---|
| **A 系统语音** | Web Speech / `say` / SAPI / espeak | 0 | 差 | 极低 | 兜底 |
| **B 应用内嵌 ONNX 引擎** | `sherpa-onnx-node` | 30–350MB | 中→良 | 低 | **默认离线引擎** |
| **C Python sidecar** | CosyVoice2 / IndexTTS2 / Chatterbox / GPT-SoVITS | 1–3GB | 优 | 很高 | 发烧友插件 |
| **D 连本地 TTS 服务** | Kokoro-FastAPI、Speaches（OpenAI 兼容 `/v1/audio/speech`） | 0（用户自装） | 良 | 低 | 已有 Docker 的用户 |
| **E 调用户已装 CLI** | piper / sherpa-onnx 命令行 | 0 | 不一 | 低 | 高级用户 |
| **F 云端合成 + 本地缓存** | 已合成音频落盘 | 0 | 优 | 极低 | **所有用户的默认离线体验** |

**D 被低估了**：你的 AI 配置已经是「OpenAI 兼容 baseUrl + key」，TTS 照同一形状加一个「自定义 TTS 端点」即可。用户 `docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu` 之后，应用指向 `http://localhost:8880/v1/audio/speech` 就能离线朗读（中文音色 `zf_xiaobei`，Kokoro-FastAPI 自测 CER 0.143）。零打包成本、三平台通用、复用同一适配器。Speaches（MIT，3.7k★，2026-11 活跃）同理，Kokoro + Piper。

**F 是多数人的真实需求**：「地铁上继续听刚才那本书」靠缓存就够，不需要先下 200MB 模型。缓存命中即离线，覆盖率随听书进度自然增长。

**B 的模型谱系**（`sherpa-onnx` v2.0.1，`tts-models` 共 646 个包，其中中文相关 31 个）：

| 模型 | 中文 | 体积 | RTF（RPi4/4线程） | 许可 | 定位 |
|---|---|---|---|---|---|
| aishell3 | 174 音色 | 30MB | **0.156** | Apache-2.0 | 极小极快，音色多但偏旧 |
| matcha-icefall-zh-baker | 1 女声 | 73MB | **0.391** | Apache-2.0 | **低配机首选** |
| vits-zh-hf-fanchen-C | 187 音色 | 116MB | 1.600 | 需核对 | 音色最多（游戏/动漫风） |
| sherpa-onnx-vits-zh-ll | 5 音色 | 116MB | 1.593 | 需核对 | 标准普通话 |
| vits-piper-zh_CN-* | 单音色 | 13MB (int8) | ~0.1（估） | ⚠️ 引擎 fork 已 GPL-3.0 | 最小，机械 |
| **MeloTTS zh_en** | 单音色 | 196MB | 2.518 | MIT | **中英混排最好**（M1 实测 RTF 0.24） |
| **Kokoro-82M multi-lang** | 103 音色 | 311MB | 3.191 | Apache-2.0 | 音色最好、最慢 → 预合成（M1 实测 0.83） |
| ZipVoice distill | 零样本克隆 | 104MB (int8) | ~0.5（估） | 权重待核 | 「用我的声音读」 |
| `kokoro-js`（npm） | **不支持中文** | — | — | — | 源码级确认，只能用 sherpa |

已排除：**SupertonicTTS 3**（31 语言，官方列表**不含中文**，已核实）、KittenTTS（15M，仅英文）、PocketTTS（零样本克隆向，无中文）。

**关键提醒**：上面的 RTF 是树莓派 4 的数据，不代表你的机器。**模型选型要看「最弱的目标机器」**——M1 上 MeloTTS 0.24 很宽裕，但换到老 Windows 笔记本可能就是 0.5–1.0；而 Matcha 在同一台 RPi4 上是 0.391，比 MeloTTS 快 6 倍。所以不要只挑一个模型：

- **兜底**（弱机 / 首次下载 30–73MB）：Matcha-zh-baker
- **默认**（中英混排、有声书）：MeloTTS zh_en
- **高质量**（后台预合成 + 缓存）：Kokoro-82M-zh
- **克隆**（可选）：ZipVoice
- **极客**：形态 D 的自定义端点

工程注意（已实测）：
- `sherpa-onnx-node@2.0.1` 有 darwin-arm64 / win32-x64 / linux-x64 预编译原生包（23–34MB），**需 `asarUnpack`**，否则 `.node` 与 dylib 的 `@loader_path` 相对路径在 asar 内失效；
- `generate()` 是**同步**的，必须放 `utilityProcess`/`worker_threads`，否则 3000 字章节会卡住主进程数分钟；
- 模型不要塞进安装包，首次使用时下载到 `userData`；
- `vits-melo-tts-zh_en` 的 `model.int8.onnx` 实际是 133 字节的 Git-LFS 指针，必须用 `model.onnx`（170MB）。

### 2.3 本机实测（macOS 15.7.4 / M1 / Electron 38.2.1 / Chromium 140）

**Edge Read Aloud**（`zh-CN-XiaoxiaoNeural`）：

- 音色：322 个总音色，**14 个中文**（晓晓/晓伊/云健/云希/云夏/云扬 + 辽宁/陕西方言 + 港台）；
- 16 字短句：首字节 **272ms**，总耗时 372ms；
- 2310 字整段：首字节 **381ms**，总耗时 **10.5s**（≈48× 实时）—— 流式可用，但**必须按句/段排队**，不要一章一个大请求；
- 返回 `WordBoundary`（offset/duration/文本）+ `SentenceBoundary`，中文按词切（「人工智能」「正在」「改变」），可直接做卡拉OK高亮。

**Web Speech API**：191 音色 / 21 中文 / 词级 `onboundary` 可用；窗口隐藏不中断朗读；但音色名本地化（`婷婷` 而非 `Tingting`），**不要按名字匹配音色**，按语言 + 索引选。

## 3. 推荐架构

```
渲染层
  PdfViewer / EpubViewer ── 当前句高亮（复用 textLayer range / epub CFI range）
  StatusBar ── 迷你播放器：播放/暂停/上一句/下一句/语速/音色
  useReadAloud() ── 句子队列、预取、自动翻页、断点续听
       │ IPC: tts:speech / tts:voices / tts:cancel / doc:page:text
主进程
  tts/engine.ts        TtsEngine 接口
  tts/providers/       edge.ts / azure.ts / qwen.ts / minimax.ts / elevenlabs.ts
  tts/segment.ts       中英混排切句（保留 charRange 映射回原文）
  tts/cache.ts         library/{docId}/audio/{hash}.mp3 + manifest.json
  tts/worker.ts        utilityProcess（离线引擎）
```

关键设计：

1. **复用现有文本管线**：`src/main/doc-text.ts` 的 `getPage(n)` 已能按「PDF 页 / EPUB 章」取出干净文本（含中文逐字 PDF 的几何重建），只需加一个 `doc:page:text` IPC，无需重写解析。
2. **句子即同步单元**：切句时记录 `charRange`，高亮时用它在 PDF textLayer（`pdf-paragraph.ts` 的 `buildTextSegments` 已有几何分段能力）或 EPUB CFI 上找区间。队列索引 → 高亮的映射是常数时间。
3. **缓存 key = hash(engine + voice + rate + text)**：同一句话重复听、回翻、离线重播都免费；缓存落在 `library/{docId}/audio/`，与 `annotations.json` 同级，删除文档时一并清理。
4. **预取 n+1..n+3**：播放当前句时后台合成后 2–3 句，切句无停顿；seek/换音色时取消在途请求。
5. **自动翻页**：句子队列耗尽 → `getPage(n+1)` → 追加队列并滚动视图；章节/文档结束则停。
6. **断点续听**：`reading:save` 已持久化页码，再存一个 `sentenceIndex` 即可从上一句位置继续。
7. **失败回退链**：Edge 失败（封域名/限流）→ 提示并切 Azure 或 Web Speech；设置页可固定引擎。

## 4. 分阶段实施

**P0（1–2 天，可用）**
- `TtsEngine` 接口 + Edge 适配器 + 切句器 + 渲染层播放队列
- 状态栏迷你播放器（播放/暂停/停止/语速）
- 当前句高亮 + 自动翻页 + 句子级缓存
- 验收：打开 PDF/EPUB，点播放，从当前页连续朗读，句子高亮跟随，翻页不中断

**P1（2–3 天，好用）**
- 设置页「朗读」分区：引擎、音色、语速、自动滚动、缓存上限
- 「朗读选中」进选中菜单（现有 高亮/引用/复制 之后）
- Azure 适配器（同协议 + SSML bookmark，字级高亮）+ BYO Key
- 断点续听、失败回退、朗读 AI 回复

**P2（可选，加分）**
- DashScope Qwen / MiniMax 适配器（中文自然度档）
- 离线引擎（sherpa-onnx：Matcha 兜底 73MB / MeloTTS 默认 196MB / Kokoro 高质量 311MB，worker + 首次下载）
- 自定义 TTS 端点（OpenAI 兼容 `/v1/audio/speech`，接 Kokoro-FastAPI / Speaches）
- 预取下一章、朗读进度导出、耳机媒体键

## 5. 成本与体积

- 听书 10h/月：Edge $0、Azure ~$2、Qwen ~$1.3、ElevenLabs Turbo ~$5.3、MiniMax HD ~$13。
- 音频体积：AAC-48k ≈ 5.3MB / 3000 字章，Opus-32k ≈ 2.6MB；一本 30 万字小说 ≈ 266MB（Opus）。缓存上限建议 500MB，LRU 淘汰。
- 离线模型：Matcha-zh-baker 73MB、MeloTTS 196MB、Kokoro multi-lang 311MB（均为首次下载，不随安装包分发）。

## 6. 风险与未决

| 风险 | 影响 | 应对 |
|---|---|---|
| Edge 接口非官方 | 可能限流/失效，违反微软 ToS | 只作免费层；单适配器隔离；失败自动回退；正式用户引导配置 Azure |
| 国内网络 | Edge/Azure/Google 可达性不稳 | 国内用户默认 Qwen/火山；引擎选择暴露到设置 |
| 分发模式 | 内置 Key 有滥用/成本风险 | 沿用现有 BYO Key（`ai-auth` + `safeStorage`），TTS 独立配置项 |
| PDF 文本顺序 | 双栏/表格/页眉页脚朗读成噪声 | 复用 `doc-text.ts` 几何重建；加页眉页脚/纯数字行过滤；扫描页走 OCR 文本 |
| 版权 | 公开分发朗读音频 | 仅本地缓存、不导出不分享；文档内注明 |
| 价格会变 | 决策依据漂移 | 引擎抽象 + 按量估算面板；不绑定单一厂商 |

**未核实的数字**（需登录控制台确认）：火山 Seed-TTS 单价与时间戳、讯飞分档价格、Fish Audio 价格/ToS、Gemini TTS 官方定价、Qwen 各档单价。另有：各家 TTFA 未做横向基准，建议选型前用同一段中文做一次 20 样本盲听 + 延迟测试。

## 7. 附录

- 抽象层实现与接口文档：[tts-architecture.md](tts-architecture.md)
- 英文原始调研笔记（云端，含全部价格出处与 ✅/⚠️/❌ 置信度标注）：[research/tts-cloud-2026-11.md](research/tts-cloud-2026-11.md)
- 英文原始调研笔记（端侧，含 M1 实测方法与复现步骤）：[research/tts-offline-2026-11.md](research/tts-offline-2026-11.md)
- 关键外部依据：Azure 语音定价与 WordBoundary 文档、ElevenLabs v4 模型页与 `with-timestamps` 接口、MiniMax T2A 定价（汉字=2 字符）、OpenAI OpenAPI spec 的 TTS 关停说明、`k2-fsa/sherpa-onnx` v2.0.1 预编译包。
