# 进度记录

## 2026-10-03 M3.5 脚本技能（host 执行）

- [x] `main/skills.ts` 增加 `runSkillCommand`：`/bin/sh -c` 在技能目录内运行（cwd 锁定），
  超时（默认 30s，上限 120s）杀进程组，stdout/stderr 各截断 20k 字符
- [x] 运行时：生成 `{userData}/bin/node` shim（`ELECTRON_RUN_AS_NODE=1` + Electron 自带 Node，
  无需系统 node）；`detectRuntimes()` 检测系统 `python3`/`python`
- [x] 信任存储 `{userData}/skills-trust.json`（`readTrusted`/`writeTrusted`）；
  总开关 `settings.json` 的 `skillsExecutionEnabled`（默认关）
- [x] **执行时逐条确认**：主进程执行前发 `permission:request`（技能名 + 完整命令 + cwd），
  弹窗选「允许一次 / 始终允许此技能 / 拒绝」；「始终允许」写入信任表，之后免确认
- [x] 工具 `run_skill_script`：仅当总开关开启且技能「本书启用」时才注入；
  参数 `{skill, command, timeoutMs}`，返回 exit/stdout/stderr
- [x] 系统提示：标注技能是「免确认」还是「执行时需用户确认」
- [x] 设置「技能」分区：总开关（执行前确认）+ 每技能「免确认」勾选 + 显示检测到的 Python/Node
- [x] 安全边界：无沙箱、以当前用户权限运行；网络隔离与 Docker 容器留待后续
- [x] 验证：typecheck/build 通过；真实主进程模块验证 node 脚本执行（cwd/参数/workdir 正确）、
  超时被杀、信任存储、运行时检测

## 2026-10-03 M3 技能（提示词版）

- [x] `packages/app/src/main/skills.ts`：技能库 `{userData}/skills/{name}/SKILL.md`，frontmatter
  解析（name/description）+ 名称规范化（`a-z0-9-`）；加载、正文读取、删除
- [x] 导入 `skills:import`：支持包含 `SKILL.md` 的文件夹 / 单个 `.md` / `.zip`（JSZip 解压保留资源），
  校验后写入技能库；同名拒绝；校验失败自动回滚
- [x] 按书启用：`library/{docId}/skills.json` 存 `{enabled:[]}`，IPC `skills:doc:get` / `skills:doc:set`
- [x] 对话注入：只把启用技能的 name+description 放进系统提示，正文由 `read_skill` 按需加载；
  启用技能时 maxTurns 提到 8；系统提示声明当前不执行脚本
- [x] 设置新增「技能」分区：导入 / 列表 / 删除 + 按当前书勾选启用（`docId` 由 main 传入）
- [x] 范围：仅提示词技能，不执行任何脚本；脚本型技能单列 M3.5（见 `docs/plan-v0.2.md` §14）
- [x] 验证：typecheck/build 通过；用真实主进程模块验证加载 / 正文 / 按书启用 / 目录导入 / 非法导入回滚

## 2026-10-03 M2 联网搜索（Web Search）

- [x] `packages/ai` / `packages/agent`：`ToolDefinition`/`AgentTool` 增加 `native` 标记，
  `AgentConfig` 增加 `maxTurns`；`agent-loop` 默认 5、可按配置提升
- [x] 适配器：Anthropic 把 `native` 工具映射为服务端 `web_search_20250305`；
  openai-completions 过滤掉 native 工具（该协议无服务端搜索）
- [x] 后端（`app/src/main/web-search.ts`）：默认 `auto` —— 免 key 调用 Exa/Parallel 的公开 MCP
  端点（`mcp.exa.ai/mcp`、`search.parallel.ai/mcp`，与 OpenCode 内置 websearch 同源），按会话稳定
  选择并失败互相切换；另支持 brave / tavily / exa（自带 key）与 duckduckgo 兜底；
  MCP 文本截断到 12k 字符；DuckDuckGo HTML 解析抽为 `parseDuckDuckGoHtml` 便于测试
- [x] 修复（实测反馈）：`settings:save` 原本整份覆盖 `settings.json`，点「完成」保存 ocrLang 时
  会把 `webSearchEnabled` 和当前 `model` 一起冲掉，导致「勾选启用搜索下次又变回未勾选」。现改为
  主进程 `updateSettings()` 合并写入，`ai:model:set` / `ai:websearch:set` 也统一走合并
- [x] 工具：`web_search` 注入系统提示；结果用 `<untrusted_web_result>` 边界包裹并声明不可信，
  snippet 截断、条数受限；启用时 `maxTurns` 提升到 8
- [x] 配置：启用/后端/条数存 `settings.json`（不重写 models.json），Key 存 `auth.json`
  （`websearch:<backend>`），并支持 models.json 的 `tools.webSearch` 与默认环境变量
- [x] IPC：`ai:websearch:set` / `ai:websearch:test`；`ai:config` 返回 webSearch 状态
- [x] 设置界面新增「联网搜索」分区：启用、后端、Key、测试搜索（显示前几条结果）
- [x] 验证：typecheck/build 通过；原生工具在 openai（过滤）与 anthropic（映射）两条协议验证；
  DuckDuckGo HTML 解析用样本验证；DDG 在当前网络不可达（预期内的兜底）

## 2026-10-03 M1 提供商预设 + 配置文件 + 全局模型切换

- [x] `packages/ai` 重构：`Model` 增加 `api`/`baseUrl`/`maxTokens`/`reasoning`；新增 `ApiType`，`StreamOptions` 携带 `apiKey`/`baseUrl`/`headers`/`sessionId`
- [x] 适配器拆分：`api/openai-completions.ts`（原 `providers/openai-compatible.ts`）+
  `api/anthropic-messages.ts`（新增，含文本/思考/工具流与 tool_result 合并）
- [x] 内置预设与目录：`config/builtin.ts`（openai/anthropic/deepseek/opencode/opencode-go），
  opencode 两个提供商的目录用脚本从公开 `/models` 生成到 `config/catalog-opencode.ts`
- [x] `config/schema.ts`：JSONC（注释/尾逗号）解析 + 字段级校验错误定位 + 起始模板
- [x] `runtime.ts`：`createModelRuntime` 合并「内置 → 用户 models → 覆盖/禁用 → /models 缓存」，
  按 `model.api` 分发；配置清洗保证坏配置不崩，`getModel`/`resolveApiKey`/`stream`
- [x] 主进程新增 `ai-config.ts`（models.json 读写/迁移/缓存）、`ai-auth.ts`（auth.json +
  safeStorage）、`settings.ts`；旧 `settings.json` 首次启动自动迁移为 `legacy` 提供商并转移密钥
- [x] IPC：`ai:config` / `ai:config:save` / `ai:config:open` / `ai:model:set` / `ai:key:set` /
  `ai:models:refresh`（拉取 `/models` 缓存到 `models-cache.json`，不污染 models.json）
- [x] 设置界面重做：提供商/当前模型/API Key/刷新模型列表/models.json 编辑器（含错误定位）；
  状态栏新增模型快速切换弹层
- [x] 文档：`docs/config-schema.md`、`docs/prompts/config-editor.md`
- [x] 验证：`npm run check` 通过、`vite build` 通过；本地 SSE 冒烟验证 openai/anthropic
  两条流的文本/思考/工具解析；畸形配置不崩溃
- [x] 修复（实测反馈）：模型下拉未按所选提供商过滤，导致把 5 个提供商的模型混在一起显示，
  且当前模型可能落在别的提供商上而显示「未配置 Key」。现改为：
  「当前模型」只列所选提供商的模型；保存 Key / 切换模型立即通知外层刷新；
  状态栏只列已配置提供商的模型；Key 输入框回车或点「完成」也会保存
- [x] 新增「OpenAI 兼容」手动配置：设置里填 ID/名称/Base URL/模型 ID/Key 即可，
  写入独立的 `custom-providers.json`（不重写带注释的 models.json，冲突时 models.json 优先）；
  支持编辑/删除，保存后自动切到该提供商的第一个模型
- [x] 设置弹窗改版（参考 VS Code）：左侧分类导航 + 右侧可滚动内容区 + 固定底栏，
  展开内容不再被裁切；弹窗垂直居中并自适应小屏；`.setting` 行「左标签 + 右控件」布局

## 2026-10-03 修复 EPUB 页码不显示

- [x] 根因：`EpubViewer` 从不向上报告页码；`main.tsx` 又用
  `total={isEpub ? 0 : total}` 强制清零，`page` 停留在上一个文档的值，
  于是状态栏对 EPUB 永远显示 `1 / – 页`
- [x] `EpubViewer`：后台 `book.locations.generate(1600)` 生成分页映射，
  `relocated` 时用 `locationFromCfi(start.cfi) + 1` 报告页码，
  生成完成后 `length()` 报告总页数；用 ref 保存回调避免重复订阅
- [x] `main.tsx`：`StatusBar` 直接透传 `total`；新增 `selected` 变化时重置
  页码/总页数的 effect（EPUB 置 1 / 0，等 viewer 上报）；EPUB 划词引用
  用当前页码而非硬编码 1
- [x] `StatusBar`：EPUB 尚未生成完 location 时显示「页码生成中…」
- [x] 验证：离屏 Electron + epubjs 对两本书生成 location，
  `length()` = 65 / 581，`locationFromCfi` 返回 0..total，
  页码 1..length 与总页数一致

## 2026-10-03 修复 EPUB「翻页对不上 / 丢内容」

- [x] 定位根因：epub.js 在 paginated 双栏下，`currentLocation().start.cfi`
  再用 `rendition.display()` 重定位会**错位一页**（报告 page 5/7/9，实际落到
  page 3/5/7）。代码在「恢复阅读位置 / 切换分栏 / 初始化确认分栏 / 容器 resize」
  四处都用 `clear()+display(cfi)`，于是恢复/重排时跳回上一页 → 用户看到"接不上"。
  - 复现：Electron 离屏窗口 + epubjs，`display(startCfi)` 前后 scrollLeft
    由 3600 变成 2400（差一页）
- [x] 改为按「章节 href + 章节内 scroll 偏移」保存/恢复（`reading.ts`
  新增 `EpubLocation` / `loadReadingLoc` / `saveReadingLoc` / `parseEpubLocation` /
  `serializeEpubLocation`），`lastLocation` 存 JSON `{t:"epub",href,offset}`，
  旧 CFI 值仍可回退解析
- [x] `EpubViewer`：恢复用 `display(href)` + `manager.scrollTo(offset)`；
  `applySpread` / 初始化确认 / ResizeObserver 重排后都按偏移校正，不再用
  CFI 重定位（`spread()` 自身会重排，无需额外 `resize()`）
- [x] 验证：三本书（三体 / 巴菲特 / 周期）恢复位置 **drift=0**；
  分栏切换、单栏 9 页翻页均完整（逐字符扫描无缺失）

## 2026-08-30 Phase 0-1

- [x] monorepo 初始化 (ai/agent/app)
- [x] packages/ai StreamFn + OpenAI兼容
- [x] packages/agent AgentLoop + SessionManager(jsonl)
- [x] Electron 图书馆导入 `library/{hash}/`
- [x] PdfViewer (canvas+textLayer, 翻页/缩放/文本选择)
- [x] AnnotationLayer (高亮/矩形框选 Alt+拖拽, 归一化坐标)
- [x] ChatPanel (选中注入 + 快捷按钮 + mock chat)

## 2026-10-01 框选取词 + OCR 双轨

- [x] 修复 pdfjs v5 文本层：`renderTextLayer` 已移除，改用 `TextLayer` 类 + `.textLayer` CSS
  - 此前 textLayer 从未生成 span → 划词拿不到文本，框选也取不到词（静默失败）
- [x] 框选（修饰键拖拽，Mac ⌥ / 其它 Alt）从 `.textLayer` span 按矩形相交抽取文本 → 注入 `selectedText`
- [x] AnnotationLayer 覆盖层改为 `pointer-events: none`（按住修饰键时才捕获），不再挡原生划词
- [x] 选区带元数据 `Selection { text, page, kind }`，prompt 注入「引用文本 · 第N页 · 框选/选中/OCR」
- [x] OCR 双轨：`packages/app/src/renderer/ocr.ts`（tesseract.js）
  - 框选无文本时按矩形区域 OCR（`rectangle` 参数，快速）
  - 工具栏「OCR 本页 / OCR 全书」，逐页缓存到 `library/{hash}/ocr.json`
- [x] 主进程 `getDocText` 合并 OCR 缓存（文本层优先，空页回退 OCR），并检测扫描版
- [x] 系统提示注入当前页文本 + 扫描版/OCR 状态提示
- [x] 设置项新增 `ocrLang`（默认 `chi_sim+eng`，首次使用从 CDN 下载语言包）

## 2026-10-01 工具调用链路 + 搜索工具修复

- [x] 修复 AgentLoop 丢字段：`currentMessages.map` 之前只保留 `{role, content}`，导致
  assistant 的 `toolCalls` 和 tool 的 `toolCallId` 丢失 → 工具回合后请求非法（400），
  一直被主进程"无工具重试"兜底吞掉；现透传完整消息，`AgentMessage` 补 `toolCalls`
- [x] `getDocText` 改为按页懒加载：`getPage(n)` 任意页按需抽取并缓存，`numPages` 为真实页数
  - 去掉原来的 `Math.min(numPages, 80)` 上限（前 80 页仍预先抽取供系统提示用）
- [x] `search_document` 重写：trim、多词容错、每页统计全部命中次数并保留最多 3 条片段、
  按命中次数排序、修掉 `[] || hint` 死代码、覆盖全书；`read_page` 走 `getPage`
- [x] `get_document_info` / 系统提示改用真实 `numPages`

## 2026-10-01 删除文档

- [x] 新增 `library:remove` IPC：`rmSync(dir, { recursive: true, force: true })` 删除
  `library/{hash}/`（含 original 副本、标注、对话、OCR），并释放内存缓存
  （`pdfDocCache` 关闭 pdfjs 文档、`docTextCache`/`rawPageCache`/`ocrCache` 清除）
- [x] preload 暴露 `removeDoc`；侧栏文档项加删除按钮（二次确认）
- [x] 删除当前打开的文档时重置选中态/标注/选区

## 待做

- [ ] 真实流式 chat (接 packages/ai)
- [ ] chats.jsonl 持久化到 doc 文件夹
- [ ] 标注精确 rect (基于 Range 坐标, 非全宽)
- [ ] EPUB 支持
- [ ] 向量 RAG（当前为子串检索）；OCR 结果目前按页缓存，可增量入向量库
- [ ] OCR worker/core 本地打包（离线可用，当前依赖 jsDelivr CDN）
- [ ] 搜索按词频/相关度之外，可考虑中文分词与 BM25
