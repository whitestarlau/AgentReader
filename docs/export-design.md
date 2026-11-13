# AgentReader 对话导出设计（Markdown / HTML / JSON）

> 生成时间：2026-11-03 | 状态：已实现（v0.3 Phase 3）
> 范围：把**当前对话**导出为 `.md` / `.html` / `.json`

> **最终确认（2026-11-03）**：只导当前会话，不做「全部会话」；格式为 Markdown + HTML + JSON；默认引用开、思考关、工具调用开、工具结果关，导出对话框里可改。下面提到「全部对话 / PDF / JSON 导入」的段落是后续扩展设计，不代表本次实现。

## 0. 结论摘要

| 决策点 | 结论 |
|---|---|
| 导出在哪做 | **主进程**：直接读 `library/{docId}/` 源文件，原生保存对话框，写文件 |
| 支持格式 | **Markdown（.md）**、**HTML（.html）**、**JSON（.json）** |
| Markdown→HTML | `unified + remark-parse + remark-gfm + remark-rehype + rehype-sanitize + rehype-stringify`，与现有 `react-markdown` 同一套 remark 语义 |
| 安全 | **必须 sanitize**。实测裸 `rehype-stringify` 会保留 `javascript:` 链接；`rehype-sanitize` 可去掉 |
| UI 入口 | ChatPanel 标题栏下载按钮 + 导出对话框；文件菜单「导出对话…」`⌘⇧E` |
| 导出范围 | **当前对话**（本次）；「全部对话」留作后续扩展 |
| 本期不做 | 全部对话、导入恢复、PDF/DOCX、带标注 PDF、云分享（见 §10 Phase 2） |
| 预估 | Markdown+HTML+JSON+UI 约 2 人日；PDF/导入另计 |

**已交付的最小版本**：当前对话 → Markdown / HTML / JSON，主进程生成、`dialog.showSaveDialog` 保存，ChatPanel 标题栏下载按钮 + 文件菜单入口；默认内容与开关见 §7.2。

---

## 1. 现状盘点

### 1.1 数据源

| 路径 | 内容 | 代码 |
|---|---|---|
| `library/{docId}/doc.json` | `id / title / ext / hash / importedAt / originalPath / lastPage` | 导入：`packages/app/src/main/library.ts:39-56`；阅读位置：`doc-state.ts:63-86` |
| `library/{docId}/conversations.json` | 对话索引 `[{ id, title, createdAt, updatedAt }]` | `packages/app/src/main/conversations.ts:12-50` |
| `library/{docId}/chats/{convId}.jsonl` | 每个对话一个 JSONL，逐行一条消息 | `conversations.ts:17-19, 106-119` |
| `library/{docId}/annotations.json` | 标注（本期不导） | `doc-state.ts:14-22` |

关键点：

- 旧版本地数据可能还是单文件 `library/{docId}/chats.jsonl`；`ensureConversations()` 会在首次读取时迁移成 `chats/{uuid}.jsonl` + `conversations.json`（`conversations.ts:21-49`）。导出可以复用它，也可以只读地处理两种布局。
- `doc.json.title` 是**文件名**（含扩展名），不是 PDF/EPUB 元数据里的书名；导出时用它并 `stripExt` 即可，不必为了导出重新解析整本 PDF。
- 对话索引新在前（`create` 用 `unshift`）；导出「全部对话」时建议按 `createdAt` 升序重排，阅读顺序更自然。

### 1.2 JSONL 实际结构

用户消息（带引用时）：

```json
{
  "id": "uuid",
  "timestamp": 1762170000000,
  "role": "user",
  "content": "【引用文本 · 第12页 · 选中】\n利率是资金的价格……\n\n【引用标注 · P12 · 高亮】\n……\n\n【问题】\n这句话怎么理解？"
}
```

助手消息（可能带思考/工具/异常提示）：

```json
{
  "id": "uuid",
  "timestamp": 1762170005000,
  "role": "assistant",
  "content": "这句话的意思是……",
  "timeline": [
    { "kind": "reasoning", "content": "先看上下文……" },
    {
      "kind": "tool",
      "id": "call_1",
      "name": "search_document",
      "args": "{\"query\":\"利率 资金价格\"}",
      "result": "……",
      "pending": false
    }
  ],
  "notice": "已达到单轮工具调用上限……"
}
```

要点：

- `role` 只有 `user` / `assistant`；历史数据可能缺少 `timeline`、`notice`、`timestamp`。
- `timeline` 只出现在助手消息；工具项可能 `pending: true`、没有 `result`（生成中断/失败时）。
- **用户消息的引用块是拼进 `content` 的**，格式为 `【引用…】\n正文`，多条引用用空行分隔，最后可能有 `\n\n【问题】\n` 再跟真正的问题。现有解析在 `ChatPanel.tsx:126-147` 的 `parseUserPrompt()`。导出必须复用同一套解析，否则会把整段引用当问题。
- 助手 `content` 是 Markdown；`timeline` 里的思考/结果是纯文本。
- 目前**没有持久化模型名、token 用量**（`chat.ts` 里 usage 只通过事件发给界面）。导出暂时不显示模型信息；将来可在 `persistAssistant()` 里补 `model` 字段。

### 1.3 现有接入点

| 位置 | 作用 | 本次改动 |
|---|---|---|
| `packages/app/src/renderer/components/ChatPanel.tsx`（标题栏） | 对话标题栏 | 加「导出」按钮 + 对话框 + toast |
| `packages/app/src/shared/chat-export.ts` | `parseUserPrompt()` / 类型 / 文件名工具 | 从 ChatPanel 抽到共享模块 |
| `packages/app/src/preload/index.ts` | `window.api` 桥 | 加 `exportChat()` |
| `packages/app/src/main/index.ts` | 注册各 IPC | 加 `registerExportIpc()` |
| `packages/app/src/main/menu.ts` | 菜单命令类型与「文件」菜单 | 加 `export-chat` 与菜单项 |
| `packages/app/src/renderer/main.tsx` | 菜单命令分发 | 加 export token，打开对话栏 |
| `packages/app/src/renderer/styles.css` | `.modal` 样式 | 复用做导出对话框 + toast |
| `packages/app/src/renderer/components/Icons.tsx` | 图标集合 | 加 `download` 图标 |

### 1.4 参考实现

- **`Reference/pi` 的 HTML 导出**（`packages/coding-agent/src/core/export-html/index.ts`）：
  - 做法是「HTML 模板 + 把 session JSON base64 塞进 `<script type="application/json">` + 浏览器端 marked 渲染」；配套有 `test/export-html-xss.test.ts`，专门测 URL scheme 白名单、属性转义、`<script>` 注入。
  - 值得借鉴的是**模板/数据分离**和**把 XSS 当一等测试**；不必照搬它内联 `marked.min.js` 的做法——AgentReader 已经有 `react-markdown`/`remark` 依赖。
- **`Reference/opencode` 的导出选项**（`packages/tui/src/ui/dialog-export-options.tsx`）：
  - 选项粒度是「Include thinking / Include tool details / Include assistant metadata / Open without saving」；`packages/app/src/utils/session-export.ts` 用 JSON 作为可回导的完整备份。
  - 说明用户会在意「导出内容要不要带思考/工具细节」，我们的导出对话框也应该给这几个开关。

---

## 2. 目标与非目标

### 目标

- 当前对话导出为 Markdown、HTML、JSON。
- 内容可选：引用原文、思考过程、工具调用、工具结果。
- HTML **单文件、离线可看**：CSS 内联，不依赖应用资源；支持深色模式和打印。
- 安全：AI 生成的 Markdown 不能变成可执行脚本/危险链接。
- 跨平台文件名安全；导出中/生成中/空对话有明确状态。

### 非目标（本期不做）

- 「当前文档的全部对话」导出（后续 Phase 2；本次固定当前对话）。
- 导入 JSON 恢复对话（Phase 2；但 JSON schema 从第一天就按可回导设计）。
- 导出 PDF / DOCX（Phase 2；PDF 可以复用 HTML + `printToPDF`）。
- 「导出标注为 Markdown / 带标注 PDF」（需求 §4.8 的另一条线，和对话导出分开）。
- 标注截图、OCR 图片、工具调用里的二进制/图片附件不导出；引用按已经拼进用户消息的文本输出。
- 云分享、公开链接、协作。
- 导出单条消息/复制到剪贴板（可做，但不是核心）。

---

## 3. 总体方案

```text
┌─ Renderer ─────────────────────────────────────────────┐
│ ChatPanel 标题栏 [⤓]  →  ExportDialog                   │
│   options: scope / format / include*                    │
│   window.api.exportChat({ docId, convId, options })     │
└──────────────────────────┬─────────────────────────────┘
                           │ contextBridge IPC
┌──────────────────────────▼─────────────────────────────┐
│ Main: export-chat.ts                                    │
│  1. 校验 docId / convId                                 │
│  2. collectBundle():                                   │
│       doc.json + conversations.json + chats/*.jsonl     │
│  3. dialog.showSaveDialog()  ← 用户选路径                │
│  4. renderMarkdown / renderHtml / renderJson            │
│  5. writeFileSync(path, text, "utf-8")                  │
│  6. return { ok, path, format, bytes }                  │
└─────────────────────────────────────────────────────────┘
```

**流程**

1. 用户点导出按钮（或菜单 `⌘⇧E`），打开导出对话框。
2. 选择格式/内容开关（范围固定当前对话），点「导出…」。
3. 主进程校验参数，读取源文件，构造统一的 `ExportBundle`。
4. 弹原生保存对话框；格式由对话框筛选器 + 最终扩展名共同决定。
5. 主进程渲染文本并写盘；返回路径/大小。
6. 渲染层显示成功 toast；`openAfter` 勾选时由主进程用系统默认应用打开。

### 为什么放在主进程

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 渲染层抓 `.chat` 的 `innerHTML` | 最快 | 折叠的引用/思考**不在 DOM 里**；会带应用样式；只能导当前可见内容 | 否 |
| 渲染层 `renderToStaticMarkup(<ReactMarkdown>)` | 与应用显示一致 | 要把所有对话载入渲染层；主进程/CLI 不可用；对话框/写盘仍要 IPC | 备选 |
| **主进程读取 + 渲染** | 数据源唯一、可测、可复用于未来 CLI/批量导出、渲染层只传 id/options | 需要新增 Markdown 渲染依赖 | **采用** |
| 当前窗口 `webContents.printToPDF` | 最简单 | 含应用 UI、只导可见内容、分页不可控 | 否 |
| 外部 Pandoc | 格式多 | 额外二进制、打包/签名复杂、各平台不一致 | 否 |

渲染层仍然负责**选项和交互**；主进程只接受 `docId/convId/options`，不信任渲染层传来的文件路径。

---

## 4. 数据模型与收集

### 4.1 共享类型（`packages/app/src/shared/chat-export.ts`）

```ts
export type ExportFormat = "md" | "html" | "json";

export type ExportOptions = {
	format: ExportFormat;
	/** 是否包含用户消息里的引用原文（默认 true） */
	includeRefs: boolean;
	/** 是否包含思考过程（默认 false） */
	includeReasoning: boolean;
	/** 是否包含工具调用名称与参数（默认 true） */
	includeTools: boolean;
	/** 是否包含工具结果（默认 false；开启后单条截断到 4000 字） */
	includeToolResults: boolean;
	/** 导出成功后是否用系统默认应用打开 */
	openAfter: boolean;
};

export type ExportRequest = {
	docId: string;
	convId: string;
	options?: Partial<ExportOptions>;
};

export type ExportResult =
	| {
			ok: true;
			path: string;
			format: ExportFormat;
			bytes: number;
			messages: number;
	  }
	| { ok: false; canceled?: true; error?: string };

/** 从 JSONL 读出的原始行；字段保持宽松，兼容旧数据。 */
export type TranscriptRow = {
	id?: string;
	timestamp?: number;
	role?: string;
	content?: string;
	timeline?: ExportTimelineItem[];
	notice?: string;
	[key: string]: unknown;
};

export type ExportTimelineItem =
	| { kind: "reasoning"; content: string }
	| {
			kind: "tool";
			id?: string;
			name: string;
			args: string;
			result?: string;
			pending?: boolean;
	  };

export type ExportConversation = {
	id: string;
	title: string;
	createdAt?: number;
	updatedAt?: number;
	messages: TranscriptRow[];
};

export type ExportBundle = {
	format: "agentreader.conversation-export";
	version: 1;
	exportedAt: string; // ISO 8601 UTC
	generator: { app: "AgentReader"; version: string };
	document: {
		id: string;
		title: string; // 含扩展名
		name: string; // 去掉扩展名
		ext: string; // pdf / epub
		hash?: string;
	};
	scope: "current";
	conversations: ExportConversation[];
};
```

### 4.2 收集规则

- **当前对话**：`conversations.json` 里必须存在该 `convId`；否则返回「对话不存在或已删除」。
- **全部对话**：读取索引，按 `createdAt` 升序（缺失的排最后）；空对话也保留，渲染时显示「（暂无消息）」。
- **消息顺序**：严格按 JSONL 文件顺序，不按 `timestamp` 排序。编辑/重新生成会重写文件，文件顺序才是权威。
- **未知 role**：`assistant` 之外的都按 `user` 渲染（与 `ChatPanel.toMsg()` 一致）；JSON 保留原值。
- **损坏行**：导出用「宽松读取」：逐行 `JSON.parse`，坏行 `console.warn` 后跳过；不要让一条坏数据导致整个导出失败。
- **流式生成中**：`chat:send` 只在结束时 `persistAssistant()`；流式中的助手消息不在磁盘。**导出按钮在 `streaming` 时禁用**，或导出前提示「本轮回答尚未落盘，不含在导出中」。MVP 选禁用，最简单且不会产生误导。
- **不读全书**：只读 `doc.json`，不调 `getDocText()`，避免大 PDF 解析拖慢导出。

### 4.3 JSON 示例

```json
{
  "format": "agentreader.conversation-export",
  "version": 1,
  "exportedAt": "2026-11-03T14:11:32.000Z",
  "generator": { "app": "AgentReader", "version": "0.2.0" },
  "document": {
    "id": "9f2c1a7b3e5d4c60",
    "title": "利率与周期.pdf",
    "name": "利率与周期",
    "ext": "pdf",
    "hash": "9f2c1a7b3e5d4c60"
  },
  "scope": "current",
  "conversations": [
    {
      "id": "uuid",
      "title": "利率与周期",
      "createdAt": 1762170000000,
      "updatedAt": 1762170100000,
      "messages": [
        { "id": "uuid", "timestamp": 1762170000000, "role": "user", "content": "【引用…】\n\n【问题】\n这句话怎么理解？" },
        { "id": "uuid", "timestamp": 1762170005000, "role": "assistant", "content": "……", "timeline": [] }
      ]
    }
  ]
}
```

JSON 是**完整备份**：消息行原样保留（含 `id/timestamp/timeline/notice`），不做工具结果截断。`document` 里**不放 `originalPath`**，避免导出文件泄露本机路径。

---

## 5. 格式规范

### 5.1 Markdown

#### 文件头

单对话：

````md
---
generator: "AgentReader"
format_version: 1
document: "利率与周期.pdf"
document_name: "利率与周期"
document_type: "pdf"
conversation: "利率与周期"
scope: "current"
exported_at: "2026-11-03T22:11:32+08:00"
message_count: 6
---

# 利率与周期

> 文档：利率与周期.pdf · 6 条消息 · 导出于 2026-11-03 22:11

## 你 · 2026-11-03 22:05

> **引用文本 · 第 12 页 · 选中**
>
> 利率是资金的价格……

这句话怎么理解？

## 助手 · 2026-11-03 22:05

这句话的意思是……

<details>
<summary>思考与工具（2 步）</summary>

**思考**

```text
先看上下文……
```

**工具 `search_document`**

参数：

```json
{
  "query": "利率 资金价格"
}
```

结果（截断）：

```text
……
```

</details>
````

全部对话：

````md
---
generator: "AgentReader"
format_version: 1
document: "利率与周期.pdf"
document_name: "利率与周期"
document_type: "pdf"
scope: "all"
exported_at: "2026-11-03T22:11:32+08:00"
conversation_count: 3
message_count: 12
---

# 利率与周期

> 文档：利率与周期.pdf · 3 个对话 · 12 条消息 · 导出于 2026-11-03 22:11

## 利率与周期

### 你 · 2026-11-03 22:05

……

---

## 第二个对话

### 你 · 2026-11-03 23:01

……
````

#### 规则

1. **标题层级随范围变化**：
   - 单对话：`#` 对话标题，`##` 角色。
   - 全部对话：`#` 文档名，`##` 对话标题，`###` 角色。
2. **角色行**：`## 你 · 2026-11-03 22:05`（单对话）/ `### 你 · …`（全部对话），助手同理。时间用本地时区，秒级不需要。
3. **引用**：用 blockquote，不用 `<details>`：
   ```md
   > **引用文本 · 第 12 页 · 选中**
   >
   > 正文第一行
   > 正文第二行
   ```
   正文按行前缀 `> `；空行输出 `>`。引用体里即使出现 `</details>` 也不会破坏结构。单条引用无正文时只输出标题行。
4. **助手正文原样输出**：不包代码块，不转义，保留模型返回的 Markdown。
5. **思考/工具**：可选，包在 `<details>` 里；summary 形如「思考 2 段 · 工具 2 次」。
   - 思考用 `text` 代码块，工具参数用 `json`（能 pretty print 就 pretty print），工具结果用 `text`。
   - 代码围栏长度动态计算：取内容里最长反引号串 + 1，至少 3 个，避免内容里的三反引号提前闭合。
   - 工具结果默认截断到 4000 字，末尾 `…（已截断，原长 N 字符）`。
   - `pending` 的工具显示「（未完成）」。
6. **异常提示**：`> ⚠️ {notice}`。
7. **空消息**：助手无正文但有 timeline 时只输出 details；两者都没有时输出「（无内容）」。
8. **多对话分隔**：对话之间用 `---`。
9. **转义**：
   - 标题/元数据压成单行，YAML 值用 `JSON.stringify()`（合法的 YAML 双引号字符串）。
   - 引用/工具结果里的 `& < >` 不需要转义（Markdown 文本），但不要拼进 HTML 标签。
   - 用户问题按 Markdown 渲染；如果它以 `#` 开头，会变成标题——这是用户输入的原样，可接受。
10. **Markdown `<details>` 兼容性**：GitHub、VS Code、Obsidian 都支持；少数严格渲染器不解析 raw HTML，此时会看到 `<details>` 标签。核心问答不受影响，因为引用用的是 blockquote。

### 5.2 HTML

#### 结构

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="AgentReader 0.2.0">
  <title>利率与周期 · AgentReader</title>
  <style>/* 全部内联，样式要点见本节末尾 */</style>
</head>
<body>
  <header class="page-head">
    <div class="eyebrow">AgentReader · 对话导出</div>
    <h1>利率与周期</h1>
    <div class="meta">
      <span>文档：利率与周期.pdf</span>
      <span>6 条消息</span>
      <span>导出于 2026-11-03 22:11</span>
    </div>
  </header>

  <main>
    <article class="turn user" id="m1">
      <header class="turn-head">
        <span class="role">你</span>
        <time datetime="2026-11-03T14:05:00.000Z">22:05</time>
      </header>
      <div class="turn-body md">
        <p>这句话怎么理解？</p>
      </div>
      <details class="refs">
        <summary>引用 1 条</summary>
        <div class="ref">
          <div class="ref-head">引用文本 · 第 12 页 · 选中</div>
          <pre class="ref-body">利率是资金的价格……</pre>
        </div>
      </details>
    </article>

    <article class="turn assistant" id="m2">
      <header class="turn-head">
        <span class="role">助手</span>
        <time datetime="2026-11-03T14:05:05.000Z">22:05</time>
      </header>
      <div class="turn-body md">
        <p>这句话的意思是……</p>
      </div>
      <details class="trace">
        <summary>思考 1 段 · 工具 1 次</summary>
        <section class="step">
          <h4>思考</h4>
          <pre>先看上下文……</pre>
        </section>
        <section class="step">
          <h4>工具 <code>search_document</code></h4>
          <pre class="args">{ "query": "利率 资金价格" }</pre>
          <pre class="result">……</pre>
        </section>
      </details>
      <div class="notice">⚠️ 已达到单轮工具调用上限……</div>
    </article>
  </main>

  <footer>由 AgentReader 导出 · 2026-11-03 22:11</footer>
  <button class="print-btn no-print" type="button" onclick="window.print()">打印 / 另存为 PDF</button>
  <script>
    addEventListener("beforeprint", () => {
      for (const d of document.querySelectorAll("details")) d.open = true;
    });
  </script>
</body>
</html>
```

#### 内容规则

- **全部对话**：`<main>` 里每个对话一个 `<section class="conversation" id="c1">`，`<h2>` 对话标题；顶部加 `<nav class="toc">` 列出所有对话，锚点跳转。单对话不渲染目录。
- **用户消息**：问题用 Markdown 渲染；引用放在 `<details class="refs">`，默认折叠，summary 显示「引用 N 条」。引用正文用 `<pre class="ref-body">` + HTML 转义，`white-space: pre-wrap`，保证原文精确。
- **助手消息**：正文 Markdown；思考/工具放在 `<details class="trace">`，默认折叠；`notice` 用 `.notice`。
- **消息锚点**：当前对话用 `id="m{messageIndex}"`；以后加「全部对话」时再加 `c{conversationIndex}-` 前缀。
- **时间**：`<time datetime="ISO">` 显示本地 `HH:mm`；完整日期时间放在 `title` 属性里。
- **打印**：`beforeprint` 自动展开所有 `<details>`；`@media print` 隐藏按钮、白底、避免消息内断页。
- **暗色**：`@media (prefers-color-scheme: dark)` 覆盖 CSS 变量；`color-scheme: light dark`。

#### 安全渲染管线

```ts
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";

const schema = {
	...defaultSchema,
	attributes: {
		...defaultSchema.attributes,
		// 让 GFM task list 的勾选状态保留（默认 schema 会去掉 checked）
		input: [...(defaultSchema.attributes?.input ?? []), "checked", "disabled", "type"],
	},
};

const processor = unified()
	.use(remarkParse)
	.use(remarkGfm)
	.use(remarkRehype) // 不开启 allowDangerousHtml：raw HTML 丢弃，与 react-markdown 默认行为一致
	.use(rehypeSanitize, schema)
	.use(rehypeStringify);

export function renderMarkdownToHtml(markdown: string): string {
	return processor.processSync(markdown).toString();
}
```

**实测结果（2026-11-03）**：

| 输入 | `remark→rehype→stringify`（无 sanitize） | 加 `rehype-sanitize` | `markdown-it`（html:false） |
|---|---|---|---|
| `[x](javascript:alert(1))` | **保留 `href="javascript:…"`（危险）** | href 被移除，只剩文本 | 渲染为字面量 `[x](javascript:…)`，不生成链接 |
| `<script>alert(1)</script>` | 标签丢弃，`alert(1)` 文本保留 | 同左 | 整体转义为文本 |
| `<img src=x onerror=…>` | 整个节点丢弃 | 丢弃 | 整体转义为文本 |
| GFM 表格 / 任务列表 | 正确渲染 | 正确渲染 | 表格正确；任务列表显示 `[ ]` 字面量 |
| 单换行 | 源码保留换行，浏览器会折叠 | 同左 | `breaks:true` 生成 `<br>` |

结论：**不要只用 `rehype-stringify`**；必须加 `rehype-sanitize`，并给段落加 `white-space: pre-wrap` 保留聊天里的单换行。若想少两个依赖，`markdown-it` 是安全默认的替代，但任务列表与 remark 语义略有差异。

以上结论已用一个 mock 对话跑通最小原型验证：最终 HTML 中不含 `javascript:`、`onerror=`，用户内容也不会生成 `<script>`（模板自带的 `beforeprint` 脚本除外）；危险链接只保留文本、没有 `href`。

#### CSS 要点

- 字体：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`；代码用 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`。
- 版心 `max-width: 920px`，桌面两侧留白；窄屏 padding 缩小。
- `.turn` 用 grid：左侧角色条/头像，右侧正文；用户消息浅色卡片，助手透明。
- `.md p, .md li { white-space: pre-wrap; }`，让单换行保留；代码块/表格不受影响。
- 表格 `display: block; overflow-x: auto;`，窄屏可横向滚动。
- `details > summary` 可点击，加 `cursor: pointer`；打印时展开。
- `@media print`：`background: #fff; color: #111;`、`.no-print { display: none }`、`.turn { break-inside: avoid; }`。
- 不引入外部字体/图标/JS 库；HTML 只依赖内联 CSS 和一小段 `beforeprint` 脚本。

### 5.3 JSON

- 用途：**完整备份 + 未来导入恢复**；也是调试/二次处理的最好输入。
- `format` + `version` 用于导入时校验；`version` 从 1 开始。
- 消息行保留原始字段，不添加解析后的 `refs/question`；渲染时再解析，避免两套数据不一致。
- 不导出 `originalPath`、API Key、设置；工具结果不截断。
- 全部对话：`conversations` 数组；`scope: "all"`。
- 导入（Phase 2）建议：
  1. 校验 `format`/`version`/`conversations` 形状；
  2. 为每个对话生成新 `convId`（避免和现有冲突），写入 `chats/{newId}.jsonl`；
  3. 消息 `id` 重新生成，`timestamp` 保留；
  4. 追加到 `conversations.json`，标题冲突时加「（导入）」后缀；
  5. 导入到当前文档，而不是按原 `document.id` 找文档（原文档可能已删除）。

### 5.4 文件名、时间、编码

**文件名**

```text
AgentReader-{文档名}-{对话名|全部对话}-{YYYYMMDD-HHmm}.{md|html|json}
例：AgentReader-利率与周期-利率与周期-20261103-2211.md
```

- 非法字符 `\ / : * ? " < > |` 和 C0 控制字符替换成 `-`；连续空白合并；首尾的 `.`/空格去掉。
- 保留中文/emoji；文件名按 **UTF-8 字节**控制在 180 字节以内（macOS/APFS 的单个文件名上限是 255 字节，CJK 一个字 3 字节，不能按「120 字符」算），按 Unicode 码点截断，不切 surrogate。
- Windows 保留名 `CON PRN AUX NUL COM1-9 LPT1-9` 前加 `_`。
- 扩展名由格式决定；保存对话框里用户改成 `.html` 时按 HTML 渲染（见 §6.2）。

**时间**

- 文件内展示：本地时区 `YYYY-MM-DD HH:mm`（消息时间）；文件头 `exported_at` 用带时区偏移的 ISO，如 `2026-11-03T22:11:32+08:00`。
- JSON 的 `exportedAt` 用 UTC ISO（`toISOString()`），跨时区交换更稳。
- 缺失 `timestamp` 的历史消息：不显示时间，不阻塞导出。

**编码/换行**

- UTF-8，无 BOM。
- 统一 `\n`；读入时把 `\r\n` 归一化。Windows 记事本/VS Code 都能正常处理。

---

## 6. 模块与接口设计

### 6.1 文件结构

```text
packages/app/src/
├── shared/
│   └── chat-export.ts          # 类型 + parseUserPrompt + 文件名/时间/转义（纯函数，无 Electron）
├── main/
│   ├── export-chat.ts          # IPC + 保存对话框 + 写文件 + 结果
│   └── export/
│       ├── collect.ts          # doc.json + conversations + JSONL → ExportBundle
│       ├── markdown.ts         # bundle → .md
│       ├── html.ts             # bundle → .html（内部动态 import 渲染管线）
│       ├── markdown-to-html.ts # unified/remark/rehype + sanitize
│       ├── template.ts         # HTML 外壳 + CSS
│       └── json.ts             # bundle → .json
├── renderer/
│   ├── components/
│   │   ├── ExportDialog.tsx    # 范围/格式/内容选项
│   │   ├── ChatPanel.tsx       # 标题栏按钮 + dialog + 成功提示
│   │   └── Icons.tsx           # download 图标
│   ├── main.tsx                # 菜单 export token
│   └── styles.css              # 导出对话框/提示样式
├── preload/index.ts            # exportChat
└── main/menu.ts                # 文件 → 导出对话…
```

`tsconfig` 的 `include: ["src"]` 覆盖 `shared/`，主进程和渲染进程都能 import；`shared` 里不要 import `electron`/`node:fs`，否则渲染层打包会出问题。

### 6.2 IPC 契约

`packages/app/src/main/export-chat.ts`（`SaveDialogOptions` 从 `electron` 导入类型）：

```ts
ipcMain.handle("chat:export", async (event, req: ExportRequest): Promise<ExportResult> => {
	const win = BrowserWindow.fromWebContents(event.sender);
	try {
		safeDocDir(req.docId); // 见 §8.2
		const doc = readDocMeta(req.docId); // doc.json
		if (doc.id !== req.docId) throw new Error("文档元数据不匹配");
		const options = normalizeExportOptions(req.options);
		const bundle = collectBundle(doc, req.convId, app.getVersion()); // 读 conversations/chats
		const conversation = bundle.conversations[0];

		const saveOptions: SaveDialogOptions = {
			title: "导出对话",
			buttonLabel: "导出",
			defaultPath: join(
				app.getPath("documents"),
				defaultExportFileName(doc.title, conversation.title, options.format),
			),
			filters: FILTERS_BY_FORMAT[options.format],
			properties: ["createDirectory", "showOverwriteConfirmation"],
			showsTagField: false,
		};
		// 显式分支：dialog.showSaveDialog 的重载不接受 undefined 作为第一个参数
		const result = win
			? await dialog.showSaveDialog(win, saveOptions)
			: await dialog.showSaveDialog(saveOptions);
		if (result.canceled || !result.filePath) return { ok: false, canceled: true };

		// 用户在对话框里把扩展名改成 .html/.json 时，以最终扩展名为准
		const format = formatFromPath(result.filePath) ?? options.format;
		const filePath = ensureExtension(result.filePath, format);
		const finalOptions: ExportOptions = { ...options, format };

		const text = await renderBundle(bundle, finalOptions);
		writeFileSync(filePath, text, "utf-8");

		if (finalOptions.openAfter) void shell.openPath(filePath).catch(() => {});
		return {
			ok: true,
			path: filePath,
			format,
			bytes: Buffer.byteLength(text, "utf8"),
			messages: conversation.messages.length,
		};
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
});
```

保存对话框的 `filters`：把用户当前选择的格式放第一位，同时保留另外两种，允许用户直接改扩展名切换：

```ts
import type { FileFilter } from "electron";

const FILTERS_BY_FORMAT: Record<ExportFormat, FileFilter[]> = {
	md: [
		{ name: "Markdown", extensions: ["md", "markdown"] },
		{ name: "HTML", extensions: ["html", "htm"] },
		{ name: "JSON", extensions: ["json"] },
	],
	html: [
		{ name: "HTML", extensions: ["html", "htm"] },
		{ name: "Markdown", extensions: ["md", "markdown"] },
		{ name: "JSON", extensions: ["json"] },
	],
	json: [
		{ name: "JSON", extensions: ["json"] },
		{ name: "Markdown", extensions: ["md", "markdown"] },
		{ name: "HTML", extensions: ["html", "htm"] },
	],
};
```

`formatFromPath()` 只认 `.md/.markdown/.html/.htm/.json`；未知扩展名时按用户选的格式追加扩展名，避免「内容 md、后缀 txt」的歧义。

### 6.3 收集（`collect.ts`）

```ts
export function collectBundle(doc: DocMeta, convId: string, appVersion: string): ExportBundle {
	const list = ensureConversations(doc.id) as ConversationIndexRow[];
	const conv = list.find((c) => c.id === convId);
	if (!conv) throw new Error("对话不存在或已被删除");

	return {
		format: "agentreader.conversation-export",
		version: 1,
		exportedAt: new Date().toISOString(),
		generator: { app: "AgentReader", version: appVersion },
		document: {
			id: doc.id,
			title: doc.title,
			name: stripExt(doc.title),
			ext: doc.ext,
			...(doc.hash ? { hash: doc.hash } : {}),
		},
		scope: "current",
		conversations: [
			{
				id: conv.id,
				title: conv.title || "未命名对话",
				createdAt: conv.createdAt,
				updatedAt: conv.updatedAt,
				messages: readTranscriptLenient(chatFile(doc.id, conv.id)),
			},
		],
	};
}
```

`readTranscriptLenient()` 与现有 `transcript.ts` 的区别：逐行 `try/catch`，坏行跳过并 `console.warn`；现有 `readTranscript()` 保持严格，供 `chat:edit` 使用（编辑时不应静默丢数据）。

### 6.4 Markdown（`markdown.ts`）

关键函数：

```ts
export function renderMarkdown(bundle: ExportBundle, opts: ExportOptions): string {
	const lines: string[] = [];
	lines.push("---", ...frontmatter(bundle), "---", "");

	if (bundle.conversations.length === 1) {
		const c = bundle.conversations[0];
		lines.push(`# ${oneLine(c.title)}`, "");
		lines.push(`> ${metaLine(bundle, c)}`, "");
		for (const m of c.messages) lines.push(...renderMessageMd(m, opts, 2), "");
	} else {
		lines.push(`# ${oneLine(bundle.document.name)}`, "");
		lines.push(`> ${metaLine(bundle)}`, "");
		bundle.conversations.forEach((c, i) => {
			if (i > 0) lines.push("---", "");
			lines.push(`## ${oneLine(c.title)}`, "");
			for (const m of c.messages) lines.push(...renderMessageMd(m, opts, 3), "");
		});
	}
	return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
```

`renderMessageMd()`：

- 角色标题：`${"#".repeat(level)} ${roleLabel}${time ? ` · ${time}` : ""}`。
- 用户：`parseUserPrompt()` → 引用 blockquote（`includeRefs` 时）→ 问题 Markdown。
- 助手：正文 → timeline `<details>`（`includeReasoning`/`includeTools`/`includeToolResults` 控制）→ notice。
- 所有动态值先 `oneLine()`；代码围栏用 `fence(text, lang)` 动态长度。

### 6.5 HTML（`html.ts` + `template.ts`）

```ts
export async function renderHtml(bundle: ExportBundle, opts: ExportOptions): Promise<string> {
	// 只有 HTML 才动态加载 unified/remark/rehype，避免拖慢主进程启动
	const { renderMarkdownToHtml } = await import("./markdown-to-html.ts");
	const body = renderBody(bundle, opts, renderMarkdownToHtml);
	return htmlDocument({ title: pageTitle(bundle), body, exportedAt: bundle.exportedAt });
}
```

- `renderBody()` 负责转义所有非 Markdown 字段（标题、引用头、引用体、工具名/参数/结果、notice）。
- `renderMarkdownToHtml()` 统一走 §5.2 的 sanitize 管线。
- 模板只做字符串替换，CSS 放在 `template.ts` 的常量里；不要从磁盘读模板，打包后路径容易出问题。
- 渲染层不参与 HTML 生成，避免 `react-dom/server` 进主进程或把全部对话载入渲染层。

### 6.6 JSON（`json.ts`）

```ts
export function renderJson(bundle: ExportBundle): string {
	return `${JSON.stringify(bundle, null, 2)}\n`;
}
```

### 6.7 渲染层

`ExportDialog.tsx`：

- Props：`open / docId / convId / conversationTitle / documentTitle / messageCount / streaming / onClose / onExported`。
- 本地状态：`format / includeRefs / includeReasoning / includeTools / includeToolResults / openAfter / busy / error`。
- 打开时从 `localStorage["chat.export.options.v1"]` 恢复；导出成功后写回。
- `format === "json"` 时禁用内容开关，并提示「JSON 始终包含完整内容」。
- 提交：`await window.api.exportChat({ docId, convId, options })`；`canceled` 不报错；`ok` 后 `onExported(result)` 并关闭；失败在对话框内显示错误。
- 复用 `.modal-backdrop/.modal/.modal-body/.modal-footer` 样式；**不要**复用 `.field`：全局 `.field input { width: 100% }` / `.field label` 会把 checkbox 撑满、把选项变粗。弹窗用独立的 `.export-field` 作用域，并让全局输入样式排除 checkbox/radio。
- `Esc` 关闭，`aria-modal`；弹窗限定最大高度，内容区 `overflow-y: auto`，窄屏（≤560px）格式卡片改为单列。

`ChatPanel.tsx`：

- 标题栏在 `+` 前加一个 `icon-btn`，图标 `download`，`title="导出当前对话"`。
- `disabled={!convId || convLoading || streaming || msgs.length === 0}`；`streaming` / 加载中 / 空对话时 tooltip 说明原因。
- 新增 `exportChatToken?: number` prop；`useEffect` 收到 token 时打开对话框（菜单入口）。
  - 对话栏收起时 ChatPanel 会卸载；用**模块级** `lastConsumedExportToken` 记录已消费的 token，重新挂载时不会把旧 token 当成新命令。
  - 如果 token 到达时对话还在加载（`convId` 为空），effect 不消费 token；依赖里带上 `convId`，加载完成后再打开。
- 成功提示：底部 toast 显示「已导出 Markdown · 12 条消息 · 文件名」，`path` 放在 `title` 里；不额外做「在 Finder 中显示」按钮，避免多一个 IPC。
- `docId` 变化时关闭对话框，避免把 A 文档的对话导到 B 文档。

`Icons.tsx`：加 `download`：托盘 + 向下箭头，和现有线性图标风格一致：

```tsx
download: (
	<>
		<path d="M8 2.8v7.4" />
		<path d="M5 7.6 8 10.6l3-3" />
		<path d="M3 12.4h10" />
	</>
),
```

`preload/index.ts`：

```ts
exportChat: (req: unknown) => ipcRenderer.invoke("chat:export", req),
```

`main.tsx`：

```ts
const [exportChatToken, setExportChatToken] = useState(0);
// menuHandler 里：
else if (cmd === "export-chat") {
	if (!selected) return; // 或提示先打开文档
	setChatOpen(true);
	setExportChatToken(Date.now());
}
// ChatPanel:
// exportChatToken={exportChatToken}
```

`menu.ts`：

```ts
export type MenuCommand =
	| "settings" | "import" | "new-chat" | "export-chat" | "toggle-sidebar" | "toggle-chat";

// 文件菜单，在「新建对话」后：
{ type: "separator" },
{ label: "导出对话…", accelerator: "CmdOrCtrl+Shift+E", click: () => sendCommand("export-chat") },
```

注意：`CmdOrCtrl+Shift+E` 目前没有被占用；不要用 `Cmd+E`（macOS 的「使用所选内容查找」）。

### 6.8 依赖

```bash
npm install --workspace=@agentreader/app \
  unified remark-parse remark-gfm remark-rehype rehype-sanitize rehype-stringify
```

版本参考（当前 `node_modules` 里已有前四个）：

```json
"unified": "^11.0.5",
"remark-parse": "^11.0.0",
"remark-gfm": "^4.0.1",
"remark-rehype": "^11.1.2",
"rehype-sanitize": "^6.0.0",
"rehype-stringify": "^10.0.1"
```

- `packages/app/package.json` 里显式声明，不依赖 workspace 提升（`react-markdown`/`remark-gfm` 目前是从根 `package.json` 提升上来的，属于隐式依赖）。
- Vite 会把这些打进 `dist-electron` 的 chunk；`rehype-*` 只在 HTML 导出时动态 import，Markdown/JSON 不会把它拉进主包。
- 本机 `~/.npm` 若因历史 root 文件报 `EPERM`，先 `sudo chown -R $(id -u):$(id -g) ~/.npm`，或临时 `--cache /tmp/npm-cache`。这是环境问题，不是代码问题。

---

## 7. UI / UX

### 7.1 入口

```text
ChatPanel 标题栏：
┌──────────────────────────────────────────────┐
│ 💬 利率与周期 ▾                    [⤓] [+] │
│                                     │        │
│                                     └─ 导出对话
└──────────────────────────────────────────────┘
```

- 下载图标放在「新建对话」左侧；有对话且不在生成中才可用。
- 菜单：文件 → 导出对话… `⌘⇧E`；如果对话栏收起了，自动展开再打开对话框。
- 对话下拉菜单里也可以加一个「导出…」项，但 MVP 不必，避免重复入口。

### 7.2 导出对话框

```text
┌ 导出对话 ────────────────────────────────────┐
│ 导出「当前对话」的 12 条消息 · 利率与周期.pdf │
│                                              │
│ 文件格式                                     │
│  [ Markdown ]  [ HTML ]  [ JSON ]            │
│   ⤓ .md          ⤓ .html     ⤓ .json        │
│                                              │
│ 包含内容                                     │
│  [x] 引用与标注原文                          │
│  [ ] 思考过程                                │
│  [x] 工具调用（名称与参数）                  │
│  [ ] 工具结果（单条截断）                    │
│  [ ] 导出后打开                              │
│                                              │
│                          [ 取消 ]  [ 导出… ] │
└──────────────────────────────────────────────┘
```

- 范围固定为当前对话；没有范围选择器（「全部对话」是后续扩展）。
- 默认：格式=上次使用，引用开、思考关、工具开、结果关、导出后打开关。
- JSON 选中时：内容开关置灰，显示「JSON 始终包含完整消息与工具结果」。
- 当前对话为空时：「导出」禁用，提示「先和 AI 聊几句」。
- 生成中：入口禁用；菜单触发时打开对话框但「导出」禁用，提示「回答生成中，结束后可导出」。
- 成功后：关闭对话框，ChatPanel 底部 toast 3–5 秒自动消失；`path` 可显示在 tooltip 里。

### 7.3 错误状态

- 取消保存：静默返回，不弹错误。
- 权限/磁盘错误：对话框内红字「导出失败：…」，保留选项让用户重试。
- 对话已被删除（另一个窗口/操作）：主进程返回「对话不存在或已被删除」，渲染层刷新对话列表。
- 文档已删除：同上。

---

## 8. 安全与健壮性

### 8.1 HTML/XSS

- **必须 sanitize**：`rehype-sanitize` + 默认 schema；不要 `allowDangerousHtml`、不要 `rehype-raw`。
- **所有非 Markdown 动态字段都转义**：文档名、对话名、引用头/体、工具名/参数/结果、`notice`、`<title>`、meta。
- **链接**：默认 schema 会移除 `javascript:`/`vbscript:`/`data:` 等；导出后 `<a>` 可能没有 `href`，文本仍保留。不要为了「新窗口打开」而放宽 `target`，除非同时加 `rel="noopener noreferrer"`。
- **远程图片**：Markdown 里的 `![...](https://…)` 会保留，打开 HTML 时浏览器会请求外链。若要求绝对离线/隐私，可在 sanitize schema 里去掉 `img`，或把图片改成链接。MVP 建议保留并在文档里注明；后续加「不加载远程图片」选项。
- **不用 innerHTML 拼动态文本**：模板字符串只拼「已经过 sanitize 的 Markdown HTML」和「已转义的纯文本」。
- **Markdown 不是可执行上下文，但也不是「安全 HTML」**：`.md` 里保留模型原始 Markdown，包括 raw HTML；GitHub/VS Code/Obsidian 的预览一般会 sanitize，但宽松渲染器可能解析 `<script>`/`onerror`。如果不放心，可以在导出时把用户/助手内容里的 raw HTML 标签转义或移除；默认保留原文，优先可读性。
- **测试**：把 `javascript:` 链接、`<script>`、`onerror`、属性逃逸（`" onmouseover=…`）写进单测，断言导出 HTML 不含 `javascript:`、不含未转义的 `onerror=`。

### 8.2 路径安全

- `docId` 只允许 `^[0-9a-f]{16}$`（导入时 `sha256(...).slice(0,16)`），再 `resolve()` 检查必须位于 `resolve(libraryRoot()) + sep` 下。
- `convId` **必须**同时满足 UUID 格式（`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`）并在 `conversations.json` 里查得到；不要直接 `join(chats, convId + ".jsonl")`，否则 `../` 可以逃逸。
- 保存路径只来自 `dialog.showSaveDialog`，**渲染层不传路径**。
- `openAfter` 只打开用户刚选定的路径；`shell.showItemInFolder` 用主进程记录的最近导出路径，不接受渲染层任意路径。
- 符号链接：库目录由应用创建；`docId` 白名单 + resolve 检查已足够。

### 8.3 数据健壮性

| 情况 | 处理 |
|---|---|
| JSONL 坏行 | 跳过并 `console.warn`，导出继续 |
| `conversations.json` 不存在 | `ensureConversations()` 迁移/创建；仍为空则报「暂无对话」 |
| 旧版 `chats.jsonl` | 复用现有迁移逻辑 |
| 消息缺 `timestamp` | 不显示时间 |
| 工具 `pending`/无 `result` | 显示「（未完成）」；不输出结果块 |
| 空对话/空消息 | 正文显示「（暂无消息）」/「（无内容）」，不崩 |
| 超大工具结果 | MD/HTML 单条截断 4000 字；JSON 完整保留 |
| 超大对话 | 字符串拼接在内存完成；10MB 以内无压力；P2 可改流式写 |
| 生成中导出 | 入口禁用；不导出未落盘的本轮 |
| 并发写 | 导出只读；`chat:send` 追加写，读取可能看到最后一行未写完 → 宽松读取跳过坏行 |
| 换行 | 读入 `\r\n` → `\n`；输出 `\n` |
| Unicode | 文件名 `NFC` 归一化；按码点截断，不切 surrogate |
| Windows 保留名/尾部点 | 前加 `_`，去掉尾部 `.`/空格 |

### 8.4 性能

- Markdown/JSON 渲染是纯字符串操作，几十万字毫秒级。
- HTML 的 unified 管线在导出时动态 import；首次导出多几十毫秒，主进程启动不受影响。
- 导出不触发 PDF 解析/OCR/向量检索，只读小文件。
- 「全部对话」逐个读 JSONL；对话数量通常个位数到几十个，足够。

---

## 9. 测试计划

### 9.1 单元测试（纯函数，优先）

| 用例 | 断言 |
|---|---|
| `parseUserPrompt` 带引用 + 问题 | refs 数量和 header/body 正确，question 不含引用 |
| 无引用纯问题 | refs 空，question 原文 |
| 只有 header 的引用（章节/页码） | body 为空，仍渲染标题 |
| 多条引用 | 按空行拆分，顺序保留 |
| `sanitizeFilename` | 斜杠、反斜杠、冒号、星号、问号、引号、尖括号、竖线、控制字符、尾点、Windows 保留名、超长、纯中文 |
| `formatFromPath/ensureExtension` | `.md/.markdown/.html/.htm/.json`、未知扩展名 |
| Markdown 快照 | 单对话/全部、引用、思考、工具、结果、notice、空消息 |
| 动态围栏 | 内容含 3/4 个连续反引号时不提前闭合 |
| YAML 转义 | 标题含 `"`、换行、`---` |
| HTML XSS | 无 `javascript:`、无 `onerror=`，用户内容不产生 `<script>`（模板脚本除外）；标题/引用已转义 |
| JSON | `format/version`、原始字段、无 `originalPath` |
| collect | 当前/全部、缺失 transcript、坏行、空对话 |

### 9.2 手动验收

1. 打开一本 PDF，聊 3 轮（含一次工具调用），导出 `.md`：
   - VS Code 预览、GitHub 预览、Obsidian 各看一遍；引用折叠/思考 details 是否正常。
2. 同一对话导出 `.html`：
   - Safari/Chrome 打开；浅色/深色；窄窗口；表格/代码块横向滚动。
   - 打印预览：details 是否自动展开、消息是否避免跨页。
   - 检查「查看源代码」：没有 `<script>alert`、没有 `javascript:`。
3. 「全部对话」导出：目录锚点可跳转；对话之间分隔清晰。
4. 取消保存、只读目录、覆盖已有文件。
5. 生成中入口是否禁用；空对话是否禁用。
6. 文件名含 `/ : ? " < > |`、超长中文、emoji。
7. Windows（如有环境）：保留名、路径分隔符、保存对话框扩展名。
8. 导出 JSON 后用 `jq` 校验；确认工具结果未被截断。

### 9.3 命令

```bash
npm run typecheck --workspace=@agentreader/app
npm run check
# 若给 app 加 test script：
npm test --workspace=@agentreader/app
```

---

## 10. 实施状态

### 已实现（本次）

- [x] `shared/chat-export.ts`：类型、`parseUserPrompt`、文件名/时间/围栏/转义工具。
- [x] `main/export/collect.ts`：读 doc + conversations + JSONL（宽松）。
- [x] `main/export/markdown.ts`：当前对话 Markdown。
- [x] `main/export/html.ts` + `markdown-to-html.ts` + `template.ts`：自包含 HTML + sanitize。
- [x] `main/export/json.ts`：完整备份 JSON。
- [x] `main/export-chat.ts` + `registerExportIpc()` + preload `exportChat`。
- [x] ChatPanel 标题栏下载按钮 + `ExportDialog`（格式/内容开关、localStorage 记忆、错误显示）。
- [x] 菜单「导出对话…」`⌘⇧E` + `main.tsx` token + 自动展开对话栏。
- [x] 成功 toast；`streaming`/空对话禁用；文档切换关闭对话框。
- [x] 单测：`shared/chat-export.test.ts` + `main/export/render.test.ts`（12 项：parser、文件名、默认选项、扩展名、围栏、Markdown、HTML XSS、JSON）。
- [x] 打包验证：`npm run package:dir` 成功，`app.asar` 内含 `dist-electron/main.js` 与 `markdown-to-html` chunk。
- [ ] 待补：Electron 真机点击验收（保存对话框、打开文件、菜单快捷键）。

### Phase 2 — 后续增强（按需）

- [ ] 全部对话：Markdown 分节、HTML 目录、JSON 数组；或「选择文件夹，每对话一个文件 + index」。
- [ ] PDF：复用 HTML，隐藏 `BrowserWindow` + `webContents.printToPDF`，`printMode` 展开 details。
- [ ] JSON 导入恢复：校验、重映射 id、追加到当前文档。
- [ ] 「复制 Markdown 到剪贴板」。
- [ ] 标注附录（`annotations.json` → Markdown 列表）。
- [ ] 助手消息持久化 `model`/`usage`，导出显示模型信息。
- [ ] 远程图片开关 / 图片转链接。
- [ ] 导出目录记忆（记住上次保存位置）。

---

## 11. 风险与待决问题

### 11.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| HTML XSS（AI 输出含危险链接/标签） | 高 | `rehype-sanitize` + 全字段转义 + 单测 |
| 依赖安装/打包失败 | 中 | 显式声明依赖；动态 import；跑一次 `package:dir` 验证 chunk |
| Markdown `<details>` 兼容性 | 低 | 引用只用 blockquote；核心 Q&A 不依赖 details |
| 全部对话文件过大 | 中 | 工具结果截断；P2 文件夹模式/流式写 |
| 生成中导出内容缺失 | 中 | 禁用入口；P2 可传渲染层实时快照 |
| 跨平台文件名 | 中 | sanitize + 单测；Windows 保留名处理 |
| 远程图片泄露访问 | 低 | 文档注明；P2 开关/转链接 |
| 无模型/用量元数据 | 低 | P2 在 `persistAssistant` 补字段 |
| `printToPDF` 分页/字体差异 | 中 | P2 单独做；`@page`/打印 CSS 实测 |

### 11.2 已确认的决定

1. **范围**：只导当前对话，不做「全部对话」。
2. **默认内容**：引用开、思考关、工具调用开、工具结果关；导出对话框里可改。
3. **格式**：Markdown + HTML + JSON。
4. **JSON 导入**：暂不做；先保留可回导的 schema。
5. **PDF**：暂不做；需要时复用 HTML + `printToPDF`。
6. **标注附录**：暂不做；与对话导出分开。
7. **语言**：中文标题与固定文案。
8. **默认保存目录**：系统「文稿 / Documents」；对话框里可改。

---

## 12. 附录

### 12.1 参考链接

- Electron `dialog.showSaveDialog`：<https://www.electronjs.org/docs/latest/api/dialog#dialogshowsavedialogwindow-options>
- Electron `webContents.printToPDF`：<https://www.electronjs.org/docs/latest/api/web-contents#contentsprinttopdfoptions>
- unified：<https://github.com/unifiedjs/unified>
- remark-gfm：<https://github.com/remarkjs/remark-gfm>
- rehype-sanitize：<https://github.com/rehypejs/rehype-sanitize>
- rehype-stringify：<https://github.com/rehypejs/rehype-stringify>

### 12.2 仓库内参考

- `Reference/pi/packages/coding-agent/src/core/export-html/index.ts`：模板 + JSON 数据 + 浏览器端渲染。
- `Reference/pi/packages/coding-agent/test/export-html-xss.test.ts`：URL scheme/属性转义测试。
- `Reference/opencode/packages/tui/src/ui/dialog-export-options.tsx`：思考/工具详情/元数据选项。
- `Reference/opencode/packages/app/src/utils/session-export.ts`：JSON 导出与文件名处理。

### 12.3 一句话总结

**主进程读 JSONL → 统一 `ExportBundle` → 三个纯渲染器（Markdown / HTML / JSON）→ 原生保存框写盘；HTML 必须 sanitize，UI 只传 id 和选项。**

