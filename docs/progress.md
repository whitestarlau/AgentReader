# 进度记录

## 2026-10-09 对话滚动：仅在贴底时自动跟随

- [x] 问题：`ChatPanel` 每当 `msgs` 变化（流式每个 delta）都强制滚到底部，用户向上
  翻阅历史时会被反复拽回底部
- [x] 改为「贴底跟随」：用 `stickRef` 记录是否贴底；`onScroll` 距底 < 48px 视为贴底。
  仅当贴底时才跟随新输出，且用瞬时滚动（非 smooth）避免流式抖动
- [x] 发送消息 / 切换会话时重置为贴底并滚到底部
- [x] 非贴底时右下角显示「回到最新」按钮（`scroll-down-btn`），点击平滑回底并恢复跟随
- [x] 验证：app typecheck 与 build 通过

## 2026-10-09 重构：拆分 main 进程 god-file `index.ts`

- [x] 背景：`packages/app/src/main/index.ts` 已膨胀到 1779 行，单个 `chat:send` 处理器
  就占约 620 行。按职责拆成多个模块，`index.ts` 收敛为组合根（83 行）
- [x] 新增模块（行为不变，纯搬移）：
  - `paths.ts`：`LIBRARY_ROOT` / `getDocDir` / `ensureLibrary`
  - `doc-text.ts`：`DocText`、`getDocText`（EPUB/PDF 解析）、OCR 缓存、页/章缓存、
    `doc:ocr:*` / `doc:outline` / `doc:path` / `doc:read`、`clearDocCaches`
  - `doc-state.ts`：标注、当前章、阅读位置（`doc:annotations:*` / `doc:chapter:*` /
    `reading:*`）
  - `conversations.ts`：会话索引与 JSONL 读写（`conversations:*` / `chat:list` /
    `chat:append` / `chat:edit`）
  - `ai.ts`：模型运行时/配置载荷/联网配置/标题生成（`ai:*` 与 `settings:*`）
  - `skills-ipc.ts`：技能相关 IPC
  - `library.ts`：导入/列出/删除
  - `permissions.ts`：脚本执行确认（`requestPermission` + `permission:reply`）
  - `chat-tools.ts`：一次对话的 agent 工具集（文档读写/搜索/联网/技能）
  - `chat.ts`：`chat:send` / `chat:stop`（模型解析、agent 循环、流式与落盘）
- [x] 验证：IPC 通道与 webContents 事件名与重构前逐一比对一致；`biome lint` 无告警；
  app typecheck 与 build 通过

## 2026-10-09 输入框 @ 引用 + EPUB 高亮标注

- [x] EPUB 选中文本不再「直接进入引用」：`EpubViewer` 的 `selected` 事件改为弹出浮动菜单
  （高亮标注 / 引用提问 / ✕），由用户选择；点击页面空白处自动收起
- [x] EPUB 高亮持久化：`Annotation` 增加可选 `cfi` 字段，高亮以 epub.js CFI range
  落盘到 `annotations.json`；`EpubViewer` 用 `rendition.annotations.highlight()` 渲染，
  新增/删除标注时增量增删（`appliedRef` 去重），翻页/分栏重排由 epub.js 自动重挂
- [x] 点击已有高亮显示「引用 / 删除」操作条；侧栏标注卡片对 EPUB 显示「第 N 章」，
  空态提示区分 EPUB / PDF
- [x] 输入框 `@` 联想引用：新增 `doc:outline` IPC（复用 `getDocText`，EPUB 返回
  `chapterLabels`），`ChatPanel` 内 `@` 触发弹层，支持章节（显示章节名）与用户标注，
  方向键/回车选择、Esc 关闭；选中项以 token 插入输入框，发送时展开为
  `【引用章节 · 第N章 · 名称】` / `【引用标注 · 位置 · 类型】+文本` 注入提示词
- [x] `@` 弹层改为两级：未输入时先列分类（章节 / 标注，带数量），选中分类再列具体条目；
  输入时跨分类搜索；Backspace 清空查询回到分类；Esc 先退分类再关闭
- [x] 修复 EPUB 章节名解析（此前引用的章节名是 `index_split_XXX` 文件名）：
  - 根因一：`<item>` 属性顺序不定，原 NCX 探测正则要求 `media-type` 在 `href` **之前**，
    calibre/EPUB2 常见 `href` 在前 → 探测失败，TOC 为空，回退文件名
  - 根因二：原实现把 NCX 全部 `<text>` 按序号与 spine 对齐，但 NCX 含 `docTitle`、
    深层嵌套 navPoint（本书 507 条 vs spine 80 个文件），序号根本对不上
  - 修复：按 id 解析 manifest（属性顺序无关）；优先 `spine@toc`，再 NCX `media-type`，
    再 EPUB3 `properties="nav"`；解析 navPoint（navLabel + 最近 content src）或 nav 文档
    的 `<a>`，按「文件名」映射到 spine，取落入该文件的**首个**导航项作为章节名；
    无导航时回退 XHTML 的 `<h1..3>` / `<title>`，最后才是文件名。实测两本真实书
    章节名正确（三国志集解 / 陈老师课程合集）
- [x] 对话中引用过长：用户消息解析为「引用块 + 问题」，引用块默认折叠成一行（标题 +
  前 48 字预览），点击展开正文（限高滚动）；普通消息照旧。完整文本仍原样发送给模型、
  仍落盘，仅展示层压缩
- [x] 验证：app typecheck 与 build（renderer + main + preload）通过

## 2026-10-04 EPUB 定位改为「章节锚点」：彻底废弃页码/页表

- [x] 结论：EPUB 是可重排文本，**不存在稳定页码**。epub.js 有两套互不相干的分页
  （屏幕按像素列分页 vs `locations.generate(1600)` 按字符分页），两者边界不对齐，
  任何「状态栏页码 = 工具页码」的尝试都会 ±1 漂移。先后尝试「渲染层生成页表」
  「全局字符偏移」均因跨 DOM/空白归一化差异而不可靠，且需遍历全书渲染，太慢
- [x] 最终方案：以**章节**为唯一位置锚点。渲染层用 `section.index + 1` 上报当前章
  （与主进程 spine 顺序天然一致，已实测验证），主进程存 `reader-chapter.json`
- [x] 删除：`page-map.json` 生成与 `doc:pages:*`、全局字符偏移与 `doc:offset:*`、
  `read_text`、`read_page`（EPUB）、页表相关类型/缓存
- [x] 工具（EPUB）：`read_chapter(章号)` / `search_document`（按章返回命中）/
  `locate_text(原文片段 → 章)`；PDF 仍用 `read_page`（物理页）
- [x] 提示词：明确「EPUB 无固定页码，勿用页码定位」，当前位置改为「第 N 章」+
  该章原文开头；`chapterLabels` 附章节名
- [x] 状态栏：EPUB 显示「第 N 章」（不再显示假页码）；引用标签/对话提示词对 EPUB
  用「第 N 章」，PDF 用「第 N 页」
- [x] 验证：epub.js `book.spine`(20) 与主进程 `<itemref>`(20) 顺序一致；
  typecheck（agent+app）与 build 通过

## 2026-10-04 read_page 支持真实页码 + 新增 read_chapter（已废弃，见上）

- [x] 背景：上一步采用章节口径后，AI 遇到「读第 1046 页」只能回复「工具按章读取」，
  read_page 形同废物。改为由渲染层生成真实页映射喂给主进程
- [x] 渲染层 `EpubViewer`：`locations.generate(1600)` 完成后，用 epub.js 的
  CFI 边界（`cfiFromLocation` + `book.getRange`）逐页抽取「第 N 页实际显示的文本」，
  连同章节归属（CFI 解析 spinePos）落盘 `page-map.json`；分块 yield，不阻塞渲染；
  已存在且 chars/total 一致则跳过重建
- [x] 主进程：新增 `doc:pages:get/save` IPC；`DocText` 增加 `pageTexts`/`pageToChapter`；
  `read_page` 有页映射时按**用户看到的页码**读取（返回 `【第 N 页（属第 X 章·名）】`），
  无映射时回退章节序号
- [x] 新增 `read_chapter` 工具（仅 EPUB）：按章节读整段，语义明确
- [x] `search_document` 命中项附 `readerPage`（该章在阅读器中的起始页）
- [x] 系统提示：有页映射时说明 read_page 用用户页码、read_chapter 用章号；
  否则维持「按章计数」提示
- [x] 验证：真实书生成 151 页映射、全部非空、均 ~1429 字；章节索引正确递增
  （cover→1、正文→2…）；agent/app typecheck + build 通过

## 2026-10-04 修复 EPUB 「引用 PXX」与 read_page 页码对不上

- [x] 修复选区引用页码恒为「第 1 页」：`EpubViewer` 主 effect 依赖 `[docId]`，
  `rendition.on("selected")` 只绑一次，闭包捕获了 mount 时的 `page`（=1）。
  改为 `pageRef` 同步最新页码，`onTextSelected(text, page)` 传实时值，
  `main.tsx` 用回调传入的 `p`（对齐 PdfViewer 的既有做法）

- [x] 定位根因：EPUB 存在两套互不相关的「页」坐标系——阅读器 UI 的 `PXX`
  来自 epub.js `locations.generate(1600)`（按渲染宽度/字符数动态分页），
  而主进程 `getDocText()` 的 `read_page(n)` 实际是 **spine 第 n 个 XHTML 章节**。
  同一本书一套约 135 页、一套 28 章，无法直接映射（UI 分页依赖渲染宽度，
  JSZip 静态解析复刻不出精确页码）
- [x] 采用「章节口径」：`DocText` 增加 `unit: "page" | "chapter"` 与
  `chapterLabels`；EPUB 走 `chapter`，PDF 仍走 `page`
- [x] 顺带修 EPUB 解析的两个真 bug：原先用宽松正则把所有 `<item>`（含 CSS/图片）
  当章节，且要求 `id` 在 `href` 前（`href` 在前的 OPF 直接解析出 0 章）。
  改为按 `<itemref idref>` 的真实 spine 顺序 + 任意属性顺序解析
- [x] `get_document_info`/`search_document`/`read_page`：描述与返回带 `unit`/`label`；
  `read_page` 对 EPUB 返回前缀 `【第 N 章 · <章节名>】`
- [x] `prompt.ts`：系统提示区分「页/章」，EPUB 列出章节清单，并明确提示
  「read_page 按章计数，与阅读器页码不是同一套编号」
- [x] 验证：四本真实 EPUB spine 章节数 = 28/62/49/37（与阅读顺序一致），
  三体系列 NCX 章节名正确映射；agent/app typecheck 通过

## 2026-10-04 修复 EPUB 双栏翻页跳内容 / 回翻翻两页

- [x] 定位根因：`EpubViewer` 同时注册了两条 keydown 通道——`rendition.on("keydown")`
  （epubjs 内部已在每个 iframe 文档上监听 keydown 并转发）与 `rendered` 里的
  `doc.addEventListener("keydown")`。焦点在 iframe 内时一次按键触发两次
  `next()`/`prev()`：双栏一次前进两屏（4 页）=「跳内容」，回翻同理=「翻两页」。
  - 复现：离屏 Electron + epubjs 加载真实书，装两条通道后单次 ArrowRight
    scrollLeft 步进 2400（2×delta）；只留一条则 1200（1×delta）
- [x] 修复：合并为单一通道，只保留 iframe 文档监听（非 passive，`preventDefault`
  生效）并用 `__arKeys` 标记去重；`rendered` 时给新建 view 绑定，初始 view 的
  `rendered` 在监听注册前已触发，用 `rendition.getContents()` 补绑。父窗口的
  window 监听继续负责焦点在 iframe 外的情况（两者互斥，不会叠加）
- [x] 顺带修复分栏切换对齐：`applySpread` 原来用 `layout.pageWidth` 对齐（双栏只有
  一屏的一半），会把位置卡到屏中间导致左右半屏拼接。改用 `layout.delta`（一屏步进）
- [x] 验证：typecheck 通过；双栏/单栏各 4 次前进 + 4 次回退，每次步进均为 ±delta
  且页码逐次变化，无跳屏

## 2026-10-03 对话编辑 + 停止生成（打断）

- [x] 修复：用户消息此前**没有落盘**（`chat:append` 存在但无人调用，`chat:send` 只写 assistant），
  重载会话只剩回答。现在 `chat:send` 落盘用户消息并回传 `id`，历史会话完整
- [x] 编辑历史用户消息：新增 `main/transcript.ts`（`editTranscript`）把 chats JSONL 截断到该条并替换内容；
  IPC `chat:edit`；UI 用户气泡悬停出现编辑按钮，行内编辑后「保存并重新生成」，以该条为界重跑，后续对话丢弃
- [x] 停止/打断：`chat:send` 用 `AbortController` 注册在途对话（`activeChats`），IPC `chat:stop` 触发 abort，
  信号透传给 AgentLoop 与流式适配器；保留已输出部分
- [x] UI：流式时发送按钮变「停止」（Esc 也可触发），停止后末条显示「已停止」；编辑流不重复落盘（`persistUser=false`）
- [x] 验证：typecheck/build；`transcript.editTranscript` 截断+替换冒烟（含非法消息拒绝）

## 2026-10-03 M4 打磨（首轮）

- [x] 抽出系统提示：新增 `packages/agent/src/prompt.ts` 的纯函数 `buildDocumentSystemPrompt`，
  把 `chat:send` 里内联的书籍上下文/目录/当前页/OCR/工具/联网/技能提示统一收拢，行为不变
- [x] `maxTurns` 可配置：`settings.json` 的 `agentMaxTurns`（默认 8，范围 1–20），
  设置新增「对话」分区可改，取代原先「有联网/技能就写死 8」的逻辑
- [x] 设置导航新增「对话」分区
- [x] 文档：`docs/plan-v0.2.md` §9 与里程碑进度更新
- [x] 验证：typecheck/build 通过；`buildDocumentSystemPrompt` 输出与迁移前一致（含技能/联网标注）

> 仍待做：容器/网络隔离、同名技能覆盖更新、旧 `settings.json` 中 legacy 字段清理。

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
