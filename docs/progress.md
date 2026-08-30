# 进度记录

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
