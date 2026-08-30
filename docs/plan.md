# AgentReader 规划文档 v0.1

> 参考设计：`Reference/pi` | 理念：麻雀虽小五脏俱全

## 1. 总体架构（抄 Pi 三层隔离）

```
AgentReader (Electron)
├── packages/ai          # 抄 pi-ai：统一多提供商 StreamFn
├── packages/agent       # 抄 pi-agent：AgentLoop + Tool 协议 + 会话树
├── packages/app         # Electron 主进程 + 渲染进程
│   ├── main/            # 图书馆、文件、向量、OCR
│   └── renderer/        # PDF视图、标注层、侧边栏、状态
└── extensions/          # 预留 Pi 式插件（on('tool_call')）
```

**分层原则**：`ai` 不知 UI，`agent` 不知文件，`app` 负责粘合。任意层可替换。

参考 Pi 构建顺序：`ai → agent → app`，共享 `tsconfig.base`、`biome`、`typebox`。

## 2. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面 | Electron + Vite + React | 生态成熟，PDF.js 兼容最好，复用 Pi 的 Node 链 |
| PDF | PDF.js (pdfjs-dist) | 文本层坐标精准，选区可靠 |
| EPUB | epub.js + epubcf | MVP 后接入，流式排版 |
| 状态 | Zustand / Jotai | 轻量，适合标注/对话状态 |
| AI 抽象 | 自研 `packages/ai` 抄 pi-ai | `Model/Context/AssistantMessageEventStream` |
| 向量 | sqlite-vec / LanceDB | 本地轻量，存于 `{doc}/vectors.db` |
| OCR | Tesseract.js (本地) / 云 OCR | 双轨降级 |
| 打包 | electron-builder | 参考 Pi 的 Bun 二进制思路 |

## 3. 目录结构（初始化目标）

```
AgentReader/
├── docs/                # 需求/规划
├── packages/
│   ├── ai/              # 多提供商
│   │   └── src/{types,providers/api,auth}
│   ├── agent/           # AgentLoop + tools
│   │   └── src/{agent,agent-loop,tools,session}
│   └── app/             # Electron
│       ├── src/main/{library,ipc,vector,ocr}
│       └── src/renderer/{pdf,annotation,chat,library}
├── library/             # 运行时图书馆（gitignore）
└── Reference/pi         # 参考
```

## 4. 核心模块设计

### 4.1 packages/ai（抄 pi-ai）
- `types.ts`：`Model`, `Context{systemPrompt,messages,tools}`, `StreamFn`
- `providers/*` + `api/*`：OpenAI/Anthropic 适配器 → 归一化 `AssistantMessageEvent`
- `utils/event-stream.ts`：流式 `EventStream`，错误不抛异常而以 `stopReason` 表达

### 4.2 packages/agent（抄 pi-agent）
- `types.ts`：`AgentTool {name, parameters: TypeBox, execute}`, `AgentState`, `AgentEvent`
- `agent-loop.ts`：双循环（内：stream+tool，外：followUp），`prepareNextTurn` 注入上下文
- `tools/`：`readPdf`, `searchDoc`, `summarize` 皆为 Tool，AI 自主调用
- `session/`：`library/{docId}/chats.jsonl` JSONL 追加，`parentId` 分支，`reduceLaneState` 回放

### 4.3 主进程 (main)
- `library.ts`：导入时 `hash(pdf) → {docId} → mkdir + copy + doc.json`
- `ipc.ts`：`open-doc`, `get-annotations`, `chat:stream` 等
- `vector.ts`：全文切片 + embedding + 检索（v0.2）
- `ocr.ts`：页面图片 → Tesseract → 文本回填（v0.3）

### 4.4 渲染进程 (renderer)
- `pdf/`：PDF.js `<canvas> + textLayer`，监听 `textSelection` 与 `mouseDrag`
- `annotation/`：SVG 覆盖层渲染高亮/矩形，坐标归一化 0-1，`visibleWidth` 等 ANSI 无关但需像素精确
- `chat/`：侧边栏，`PendingMessageQueue`（抄 Pi 的 `all/one-at-a-time`），流式渲染
- `library/`：文档网格，搜索与标签

## 5. 数据流（选中→对话）

```
用户框选 → annotation 层生成 Annotation{rects,text,screenshot}
        → 侧边栏自动注入引用块
        → 用户输入 "解释一下"
        → agent 构建 Context{选中text + 级别对应的章节/向量 + tools}
        → ai.StreamFn(model, context) → 流式事件 → 渲染
        → 结束追加 chats.jsonl → 更新 UI
```

## 6. 路线图

### Phase 0 — 初始化（1周）
- [ ] `npm create electron + vite react ts`
- [ ] 抽 `packages/ai` 空壳（仅 OpenAI 兼容）
- [ ] `library/` 导入流程 + `doc.json` 读写
- [ ] PDF.js 单页渲染可翻页

### Phase 1 — MVP v0.1（2-3周）
- [ ] 高亮 + 矩形标注 + `annotations.json` 持久化
- [ ] 侧边栏对话 + 选中注入 + 流式
- [ ] `chats.jsonl` 会话持久化与恢复
- [ ] 打包可安装

### Phase 2 — v0.2 可用（2周）
- [ ] EPUB 支持
- [ ] 分级上下文 L2/L3 + `vectors.db` RAG
- [ ] 多提供商 + Key 管理
- [ ] 标注列表与跳转

### Phase 3 — v0.3 完整（2周）
- [ ] OCR + 截图双轨（扫描版）
- [ ] 导出 Markdown/带标注 PDF
- [ ] 扩展系统 `extensions/` + 示例 `translate` 插件
- [ ] 深色模式、快捷键可配置（抄 Pi 的 `DEFAULT_KEYBINDINGS`）

## 7. 关键决策记录（ADR）

- **ADR-1 导入式而非 sidecar**：便于管理、原子化、支持 RAG/缩略图等衍生文件
- **ADR-2 每文档一文件夹**：隔离性好，迁移/删除原子操作，SQLite 仅作索引时可退化
- **ADR-3 抄 Pi StreamFn 不抛异常**：流式错误可恢复，`chats.jsonl` 回放不中断
- **ADR-4 坐标归一化 0-1**：适配缩放与不同 DPI
- **ADR-5 先不做扩展系统但预留目录**：MVP 保持极简，接口按 Pi 的 `on(event)` 设计

## 8. 风险与对策

- PDF.js 文本层错位 → 锁定版本 + 归一化坐标 + 截图兜底
- 大 PDF 内存 → 虚拟滚动 + 按需渲染 ±2 页
- Token 成本 → 默认 L1，L3 需向量检索限 topK=5
- OCR 慢 → 后台异步 + 进度条，不阻塞阅读

## 9. 下一步行动

1. 初始化 Electron + packages/ai 空壳
2. 实现图书馆导入与 PDF 单页渲染
3. 按 Phase 1 逐项交付，每步可演示
