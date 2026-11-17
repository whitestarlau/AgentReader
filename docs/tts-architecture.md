# 朗读抽象层（TTS 引擎接口）

> 2026-11-07 | 状态：v1 已落地（2 个引擎 + 缓存 + 回退 + IPC）| 关联：[tts-research.md](tts-research.md)

## 0. 这层解决什么

「朗读」在方案层面至少有五种形态：云端 REST、云端 WebSocket、端侧 ONNX、本地 OpenAI 兼容服务、系统语音。它们的差异远大于相似：

| 差异点 | 例子 |
|---|---|
| 输出形态 | mp3 分片流 / base64 JSON / PCM Float32 数组 / 根本不产生音频（系统语音） |
| 时间戳 | 字级（Edge、Azure、ElevenLabs）/ 句级 / 完全没有（Qwen、Gemini） |
| 单次上限 | OpenAI 4096 字符 / 本地模型不受限 / Azure 建议按段 |
| 计费与可用性 | 按字符计费 / 免费但随时可能失效 / 纯本地 |
| 配置 | 需要 key / 需要 endpoint / 零配置 |

播放器不该知道这些。**渲染层只面对一个「合成这句文本」的调用**，其余全部收在这一层里。

## 1. 分层

```
渲染层
  read-aloud.ts   句子队列 / 预取 / 播放 / 暂停 / 上一句下一句
  readable.ts     DOM → 可朗读文本 + 偏移表 → Range + CSS Highlight
  ReadBar.tsx     底部播放条（播放/暂停、上一句/下一句、语速、停止）
  PdfViewer / EpubViewer  工具栏「朗读」按钮 + 自动翻页/翻章
      │ IPC: tts:info / tts:voices / tts:synthesize / tts:speak / tts:cache:*
主进程
  tts/index.ts            ← 唯一接触 Electron 的文件：读设置、建注册表、缓存、IPC
  tts/registry.ts         引擎注册 + 失败回退链
  tts/pipeline.ts         长文按句切分、拼接音频、平移边界
  tts/segment.ts          中英混排切句（纯函数，保留 charRange）
  tts/cache.ts            内容寻址音频缓存 + LRU
  tts/keys.ts             cache key
  tts/types.ts            TtsEngine 契约、TtsResult、TtsError
  tts/providers/*         edge（免费在线）/ sherpa（本地）/ openai-compatible / mock
  tts/edge-token.ts       Edge 朗读的 Sec-MS-GEC v2 令牌（CS64 + SHA-256）
  tts/wav.ts              Float32 → 16-bit PCM WAV（本地引擎用）
  tts/catalog.ts          可下载的本地模型清单（URL / 大小 / 许可）
  tts/models.ts           下载 → 校验 → 解包 → 验证 → 删除
shared/tts.ts             跨进程的 wire 类型（渲染层只 import 这个）
```

依赖方向是单向的：`providers → types`，`index → 全部`，`renderer → shared`。`segment / pipeline / cache / registry` 都不依赖 Electron，可以直接用 `node --test` 跑。

## 2. 引擎契约

```ts
interface TtsEngine {
  readonly id: string;
  readonly label: string;
  capabilities(): TtsCapabilities;
  listVoices(): Promise<TtsVoice[]>;   // 不可用时抛 not-configured
  synthesize(req: TtsRequest): Promise<TtsResult>;
  synthesizeStream?(req: TtsRequest): AsyncIterable<TtsEvent>; // 可选
}
```

`capabilities()` 是这一层的核心：UI 不猜、不试探，直接读能力位。

| 能力位 | 作用 |
|---|---|
| `boundaries: "none" \| "sentence" \| "word"` | 决定高亮精度；`none` 时仍可句子级同步（见下） |
| `streaming` | 是否支持边合成边出音频（首字延迟优化） |
| `maxCharsPerRequest` | 超过就由 `pipeline` 自动切句 |
| `offline` | 是否完全不联网（UI 可标注「离线可用」） |
| `requiresConfig` | 是否必须先配置才能出现在引擎列表里 |
| `rate` / `pitch` | 音频设置里对应滑块是否可点 |

`TtsResult`：

```ts
{
  audio: { format, sampleRate, data: Uint8Array },
  boundaries: [{ kind, textStart, textLength, audioStartMs, audioDurationMs }],
  durationMs?, firstAudioMs?
}
```

`textStart/textLength` 是**相对本次请求文本的 UTF-16 偏移**，所以能直接映射回原文做高亮。`pipeline` 在拼接时会把它们平移到整段文本的坐标系。

## 3. 三条设计原则

**① 句子是同步单位，时间戳只是加分项。**
播放器按句合成，队列位置就是高亮位置——这使 Qwen、Gemini 这类「不给任何时间戳」的引擎也能正常跟读。有 `boundaries` 的引擎（Edge/Azure/ElevenLabs）可以把高亮细化到词。

**② 能力先声明，UI 后适配。**
没有时间戳就不显示字级高亮；不支持语速就禁用滑块；本地引擎标注「离线」。避免每个引擎写一套 if。

**③ 错误分类驱动回退，而不是字符串匹配。**

| `kind` | 含义 | 回退行为 |
|---|---|---|
| `aborted` | 用户按了停止 | **立即终止**，不换引擎 |
| `not-configured` | 没 key / 没 endpoint / 404 | 换下一个 |
| `unsupported` | 格式、长度、语速不支持 | 换下一个 |
| `rate-limited` / `network` / `internal` | 临时故障 | 换下一个，并通过 `onFallback` 上报 |

免费层（Edge）失效时会自动降级到已配置的付费引擎，而不是整个功能报错。

## 4. 缓存

- **key** = `sha256(engineId | 引擎配置指纹 | voiceId | rate | pitch | format | text)`，见 `keys.ts`；
  指纹来自 `TtsEngine.cacheTag?()`（sherpa 是模型目录 + vocoder，OpenAI 兼容端点是 baseUrl + model）。
  没有它的话，切换模型后 `engineId`/`voiceId` 都没变，缓存会一直命中旧模型的声音；
- 落盘在 `{userData}/tts-cache/{key}.{mp3|wav|...}` + 同名 `.json`（存边界与时长）；
- 读取时 `utimes` 刷新 mtime，`prune()` 按 mtime 淘汰，默认上限 500MB（`ttsCacheMb`）；
- 写入超过预算 1/4 或 8MB 才触发一次扫描，避免逐句 stat。

这顺带解决了一部分「离线」：**已经听过的内容，断网也能重听**，不需要先下载模型。

## 5. IPC 面

| channel | 入参 | 返回 |
|---|---|---|
| `tts:info` | — | `{ engines, engineId, voiceId, rate, cacheBytes, endpointConfigured }` |
| `tts:voices` | — | `{ groups: [{ engineId, label, voices }] }` |
| `tts:synthesize` | `{ text, engineId?, voiceId?, rate? }` | `{ ok:true, engineId, cached, format, sampleRate, durationMs?, boundaries, data } \| { ok:false, kind, message }` |
| `tts:speak` | 同上 | 同上，但**绕过缓存**（用于「试听音色」） |
| `tts:cache:clear` | — | `{ freedBytes }` |
| `tts:cache:size` | — | `number` |
| `tts:models:list` | — | `{ models: TtsModelInfo[], modelDir }` |
| `tts:models:download` | `id` | `{ ok, message? }`（进度走事件 `tts:model:progress`） |
| `tts:models:cancel` | `id` | `boolean` |
| `tts:models:remove` | `id` | `boolean` |
| `tts:models:activate` | `id` | `boolean` |

失败**不抛异常**，而是返回 `{ ok:false, kind, message }`——否则渲染层只能拿到 Electron 包装过的 `Error invoking remote method...` 字符串，没法按类型处理。

## 6. 设置项

都写在现有 `settings.json`（字符串字典），密钥走 `auth.json`（`safeStorage` 加密，provider id = `tts`）：

| key | 含义 | 默认 |
|---|---|---|
| `ttsEndpoint` | OpenAI 兼容端点，如 `http://127.0.0.1:8880/v1` | 空（未配置） |
| `ttsModel` | 服务端模型名 | `kokoro` |
| `ttsVoice:<engineId>` | 每个引擎各自记住的音色 id（引擎间 id 不通用） | sherpa `0` / 端点 `zf_xiaobei` |
| `ttsVoices` | 音色列表（逗号分隔，服务端无法枚举时用） | — |
| `ttsLang` | 语言标签 | `zh-CN` |
| `ttsRate` | 语速，clamp 到 0.5–2 | `1` |
| `ttsMaxChars` | 单次请求上限 | `4000` |
| `ttsEngine` | 首选引擎 id | 空（自动选第一个可用） |
| `ttsCacheMb` | 缓存上限 | `500` |
| `ttsEnableMock` | 注册静音引擎（开发用） | 关 |
| `ttsSherpaModelDir` | 本地模型目录（解包后的 bundle） | 空（未启用） |
| `ttsSherpaVocoder` | matcha 系模型需要的 vocoder 文件 | 自动探测 |
| `ttsSherpaThreads` | 本地推理线程数（≤ 性能核数） | 4 |
| `ttsSherpaKind` | `auto` / `vits` / `matcha` | `auto` |
| `ttsModelPreset` | 目录里已安装模型中被选中的那个 id | 自动选第一个可用 |

## 7. 本地模型的下载与安装

用户不该看到 `.tar.bz2`。整条链路由应用负责：

```
渲染层「设置 → 朗读」  ── 点「下载」
      │ tts:models:download(id)
主进程 models.ts
      ├─ fetch 流式写入 {userData}/tts-models/.tmp/{id}/
      ├─ 每 250ms 推 tts:model:progress（渲染层画进度条）
      ├─ 校验字节数（容差 2%，GitHub 的 release 资产不可变）
      ├─ tar -xjf 解包到 {userData}/tts-models/{id}/（--strip-components=1）
      ├─ 把 vocoder 等附带文件搬进同一目录
      └─ isInstalled() 验证：真权重（>1MB）存在，matcha 还要有 vocoder
```

几个刻意的选择：

- **不用 JS 解压库**：Node 没有 bzip2 解码器，引入一个纯 JS 实现会多一个打进主进程 bundle 的依赖；`tar` 在 macOS / Linux / Windows 10+ 都是系统自带，`spawn` 即可。
- **校验而不是信任**：`model.int8.onnx` 可能是 133 字节的 LFS 指针，下载校验 + 安装后校验把这挡在外面。
- **失败即回滚**：任何一步失败都会删掉目标目录和临时目录，不会留下「看起来装好了」的半成品。
- **引擎自动接管**：模型装好后 `resolveSherpa()` 会自动选它（优先用户激活的，其次 MeloTTS），不需要用户再填路径；`ttsSherpaModelDir` 仍然保留给手动放了 bundle 的高级用户。

远程模型清单刻意只有两个，且都标了许可证：MeloTTS（MIT，可商用）和 Matcha Baker（训练数据**仅限非商用**）—— 后者在 UI 上直接打「仅非商用」标签，避免用户不知情地商用。

## 8. 播放器：从哪里触发、怎么跟读

入口有两个，都在阅读界面里：

- **PDF 工具栏「朗读」**：从当前页开始，读完自动翻页，直到文档末尾。
- **EPUB 工具栏「朗读」**：从当前章节开始，读完自动进入下一节。

播放时底部浮出播放条：上一句 / 暂停 / 下一句、`3 / 17 句`、语速（0.8–2×，对之后合成的句子生效）、停止；加载中显示转圈，出错直接显示原因（例如「还没有配置朗读引擎」）。

数据流：

```
当前页/章的 DOM
   │ buildTextMap()            提取文本 + 每个 Text 节点的 [start,end) 偏移
   ▼
splitSentences(maxChars=220)  按句切分，偏移继续指向同一份文本
   │
   ├── synthesize(text) ── IPC ── 主进程（缓存 / 回退链 / 本地引擎）
   │        ▲ 当前句播放时预取后 2 句
   ▼
<audio> 播放 ← Blob URL
   │
   └── onSegment(segment) ── rangeFor(map, start, end) ──> Range
         ├─ CSS Custom Highlight API 上色（不改 DOM，EPUB iframe 里同样有效）
         └─ revealRangeIn(container) 只滚动阅读容器（分页 EPUB 按整页对齐）
```

**为什么text从 DOM 取而不是主进程**：主进程的 `getPage()` 更干净，但它的偏移量对应不到 DOM 节点，就没法高亮。DOM 里的文本和用户看到的是同一份，句子偏移可以直接映射回 `Range`。代价是 PDF 逐字 span 的拼接需要启发式（CJK 之间不加空格、拉丁字母之间补空格）。

**为什么同步是免费的**：一句一次合成、按队列播放，**队列位置就是高亮位置**——不依赖任何厂商的时间戳。有 `WordBoundary` 的引擎（Edge/Azure）以后可以把高亮细化到词。

**交互规则**

- **从看到的地方开始**：按下朗读时，用 `firstVisibleIndex()` 找出视口内第一句（同时判断水平/垂直可见性，分页双栏时不会误选屏幕外的另一页），而不是从页/章首开始。
- **朗读期间由播放器接管导航**：滚轮、方向键/翻页键、工具栏的翻页与上一章/下一章全部禁用（PDF 阶段还会把 stage 的 `overflow` 设为 hidden，但用 `scrollbar-gutter: stable` 预留滚动条宽度，避免锁定/解锁时 fit-width 页宽跳动），要移动就用播放条上的上一句/下一句，或按 Esc 结束会话。
- **跟随语音滚动不会动外层布局**：`Element.scrollIntoView()` 会滚动所有可滚动祖先——在 EPUB iframe 里会把分页容器推到半页偏移（左右两栏都被裁切），在 PDF 里会把整个应用文档推走 18px（标题栏/状态栏被切）。现在只对已知容器调用 `revealRangeIn()`：PDF 与连续滑动 EPUB 直接滚动容器；分页 EPUB 用 `layout.delta` 对齐整页，句子已在当前屏时不动。
- **点哪读哪**：朗读中点正文任意位置，用 `caretRangeFromPoint` 取到文本偏移，换算成句子下标后 `playFrom()` 跳转；点按钮、浮层、链接不会触发。
- **跳转优先于朗读**：目录、搜索、标注、翻页等外部跳转先结束朗读会话，再执行跳转；否则朗读会继续念旧页面/章节并在读完后自动翻走。EPUB 目录保留 `href#fragment`，同一 spine 文件内的多个章节也能精确落点。
- **停止后不会复活**：换章/换页是异步的（`rendition.display`、等待 PDF 文字层），两者都用 `readSessionRef` 在 await 边界校验会话；停止会递增会话并清空队列，迟到的换章逻辑只退出，不再 `load/play`。

**分段**：标题被当作正文一起念、句子被读得很急，根因是切句前没有块边界。现在构建文本时按来源插入硬断句（`\n`，切句器把它当句子终止）：

- EPUB（HTML）：比较最近块级祖先，`<h2>` 与 `<p>`、两个 `<p>` 之间都断开；
- PDF（文字层是一串 span，没有语义）：用几何判断——垂直间距超过 0.45 行高算段落/标题断行，水平间距超过 0.25 行高补空格，紧挨着的字形（逐字 PDF）不拆。

已知限制（v1）：

- EPUB 双栏跨页会把两栏按阅读顺序拼起来读；分页模式在句子跨到下一屏时会按整页步进翻屏（不会停在半页），章节读完按 spine 直接跳下一节。
- PDF 双栏/表格的阅读顺序取决于 pdf.js 的文本层顺序，个别版面会串。
- 语速修改对「之后合成」的句子生效，当前这句不变。

## 9. 加一个引擎要写什么

1. 在 `tts/providers/` 新建文件，实现 `TtsEngine`；
2. 在 `tts/index.ts` 的 `buildRegistry()` 里按配置注册；
3. 如果它需要新的配置项，加进 §6 的表并在设置页暴露；
4. 补一个单测：能力位、错误分类、边界换算。

骨架：

```ts
export class MyTts implements TtsEngine {
  readonly id = "my";
  readonly label = "我的引擎";

  capabilities(): TtsCapabilities {
    return {
      streaming: false, boundaries: "word", formats: ["mp3"],
      maxCharsPerRequest: 2000, offline: false, requiresConfig: true,
      rate: true, pitch: false,
    };
  }

  async listVoices() { /* 抛 not-configured 表示还不可用 */ return []; }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    // 把网络错误映射成 TtsError("network" | "rate-limited" | "not-configured")
    // 返回 { audio, boundaries, durationMs }
  }
}
```

**注意**：长文切分、拼接、缓存、回退都不需要引擎关心，`pipeline` 和 `registry` 已经处理。

## 10. 现状与下一步

**已完成**
- 播放器：两个阅读器的工具栏入口、底部播放条、句子高亮跟随、PDF 自动翻页 / EPUB 自动翻章、语速与暂停。
- 音色：设置页「音色」分区按引擎分组列出可选音色（本地模型按 `numSpeakers` 展开，如 AISHELL-3 的 174 个），选择写入 `ttsVoice:<engineId>`；「试听」走 `tts:speak` 绕过缓存，换音色立刻能听出区别。
- 模型管理器：应用内下载（流式进度、可取消）、完整性校验、`tar` 解包、安装后校验、删除；实测真实下载 129MB（Matcha + vocoder）15.3 秒完成并验证通过。
- 设置页「朗读」分区：模型卡片（大小 / 许可证 / 占用）、下载进度条、取消 / 删除 / 切换使用，以及当前可用引擎与能力。
- `sherpa-onnx` 本地适配器：模型目录即配置，自动识别 **VITS / Matcha / Kokoro** 三族、自动收集 rule fsts、按 `numSpeakers` 生成音色列表；合成走 `generateAsync`（不阻塞主进程）；输出 16-bit WAV。
- Kokoro 中文（82M / Apache-2.0）：v1.1 是中文特化版，103 个音色 = 中文 100（55 女声 + 45 男声）+ 3 个英语；**v1.0 与 v1.1 的 sid 布局完全不同**（v1.0 的中文在 45–52 且带名字，v1.1 是 3–57 女 / 58–102 男），适配器按说话人总数分流映射。M1 实测 RTF 0.71–0.89（int8，4 线程）；另提供 fp32 高保真版（365MB）用于排查量化杂音。
- `openai-compatible` 适配器（零依赖 `fetch`）：可直接接 Kokoro-FastAPI、Speaches 或任何 `/v1/audio/speech` 服务；自动嗅探返回格式（mp3/wav/opus），不信任 `response_format`。
- `mock` 静音引擎：无网络也能把播放器 UI 做出来。
- 切句器（中英混排、引号/小数/缩写、超长句二次切分、不切断代理对）。
- 长文管线（按句切分 → 逐段合成 → 拼接 → 边界平移）。
- 注册表 + 回退链 + 错误分类。
- 内容寻址缓存 + LRU。
- IPC + preload + 类型声明。

**本地引擎实测（M1 / macOS 15.7.4 / 4 线程）**

| 模型 | RTF | 说明 |
|---|---|---|
| MeloTTS zh_en（VITS，196MB，MIT） | **0.25** | 中英混排；4 线程用满 3.9 核 |
| Matcha icefall zh-baker（73MB + vocoder 51MB） | **0.04** | 快 6 倍，但训练数据注明**非商用** |

三个坑，都已写进代码：

1. **`numThreads` 必须在 `model` 里**。放顶层会被静默忽略，退化成单线程 —— 同一模型 RTF 从 0.25 掉到 0.74（3 倍差距），而且线程数 1/2/4/8 全部一样，很容易误判为「机器不行」。
2. **`model.int8.onnx` 可能是 133 字节的 Git-LFS 指针**（MeloTTS/release 包就是这样）。选模型文件时必须校验大小 > 1MB，否则加载会失败或拿到空权重。
3. **Metal / CoreML 对这类模型没有收益**。实测 Kokoro 在 `provider=coreml` 下 RTF 0.88、CPU 0.82，加载还更慢：这些图是动态 shape，绝大多数节点回退到 CPU。Metal 真正有用的场景是重模型（如 llama.cpp-omni 跑 VoxCPM），不是 82M 的 ONNX TTS。
4. **Electron 禁止 external ArrayBuffer**。sherpa 默认把音频放在外部缓冲区里返回，纯 Node 允许、Electron 直接拒绝：同步接口报 `External buffers are not allowed`，异步接口被包装成完全看不出原因的 **`TTS settlement failed`**。调用时必须传 `enableExternalBuffer: false`。这个坑只有在 Electron 里才暴露，纯 Node 单测全绿也发现不了 —— 所以补了 `npm run test:electron`（见下）。

**Edge 朗读（免费在线）**

`edge` 引擎直接对接微软 Edge「朗读」用的接口：无需 Key、中文音色好（晓晓/云希/云健…），还带字级边界。两个工程难点已解决：

- **鉴权**：`Sec-MS-GEC v2`（Edge 版权行 + Windows 时间戳的 CS64 校验和，再拼 SHA-256），时间戳必须用 BigInt 保证精度；本地时钟跑偏时用 403 响应的 `Date` 头校正后重试一次。
- **传输**：该接口需要自定义 `Origin`/`User-Agent` 头，Node 自带 WebSocket 不支持 → 用 `ws`（无依赖）并在 Vite 里 external，打包时随 `node_modules/ws` 分发。
- **风险控制**：它不是正式 API，随时可能变。所以注册表加了**熔断**：某个引擎失败后 60 秒内跳过它，避免每句话都白等一次超时；Edge 挂掉就直接用本地 MeloTTS。

实测（本机）：一次中文合成 1.1s 出 3.8s 音频（含建连），返回 8 个字/句边界；音色列表 322 个，中文排在最前。

**待做（按建议顺序）**
1. **Edge 适配器**：免费默认层。微软已把鉴权升级到 `Sec-MS-GEC v2`（自定义 CS64 校验 + 服务器时钟校正，`Sec-MS-GEC-Version=2-143.0.3650.96`），手写 v1 token 会被 403；`msedge-tts` 依赖 axios + ws + buffer/stream polyfill，而主进程是**全打包**的，硬塞风险高。两条路：手写 ~120 行 WS 客户端 + 移植 v2 token，或调整打包策略（`files` 加 node_modules + external）。
2. **播放器**：句子队列、预取 2–3 句、自动翻页、断点续听、句子高亮（PDF textLayer / EPUB CFI）。
3. **设置页「朗读」分区**：引擎、音色、语速、缓存清理、试听。
4. **Azure / Qwen 适配器**：正版、稳定、字级/句级边界。
5. **字级高亮**：Edge 已返回 word boundaries，播放器目前仍按句高亮，可以接上做卡拉OK式跟随。
6. **模型清单扩充**：目前两个模型；后续可加 Kokoro 中文（适配器还没接 kokoro 分支）与更多女声/男声。

## 11. 验证

- 单测 60 项：切句 9、管线 4、注册表 6、缓存 4、mock 2、OpenAI 兼容适配器 5、WAV 2、sherpa 9、模型管理 7、播放器状态机 6、Edge 令牌 4、注册表熔断 2；其中 1 项 sherpa 集成测试需 `SHERPA_TTS_MODEL_DIR`，默认跳过；全量 66 项通过 65、跳过 1；
- `npm run typecheck --workspace=@agentreader/app` 通过；
- `npm run build --workspace=@agentreader/app` 通过（主进程 bundle ≈168KB）。
- `npm run test:electron --workspace=@agentreader/app`（需 `SHERPA_TTS_MODEL_DIR` 指向解包模型）在真实 Electron 里跑一次合成：3.34s 音频 / 1.36s 合成，通过。这是唯一能覆盖「外部缓冲区」这类宿主差异的测试。
