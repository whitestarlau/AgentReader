# AgentReader

[English](README.md) | 简体中文

桌面端 AI 文档阅读工具，支持 PDF / EPUB 的导入、阅读、**高亮/矩形框选**与 AI 对话。设计参考 `Reference/pi` —— 麻雀虽小五脏俱全。

## 截图

![欢迎页](docs/images/screenshot-welcome.png)

![EPUB 双栏阅读 + AI 对话侧栏](docs/images/screenshot-epub-chat.png)

![书架：封面、阅读进度与同步状态](docs/images/screenshot-shelf.jpg)

## 功能

- **书架**：封面网格（PDF 渲染首页、EPUB 提取封面图），每本显示阅读进度条与同步状态（云端 / 待同步 / 已同步）；可按最近阅读、书名、导入时间排序
- **图书馆**：导入式管理 `library/{hash}/`，每文档独立文件夹（原文件 + `doc.json` + `annotations.json` + `chats.jsonl`）
- **阅读**：PDF.js `canvas+textLayer`，连续滚动 / 单页翻页双模式，适应宽度 / 适应页面 / 指针缩放，PDF 书签目录，精确恢复上次阅读位置（页内偏移）；EPUB 支持翻页（单/双栏）与连续滑动两种模式
- **标注**：选中文本弹出「高亮 / 引用提问 / 复制」菜单，**双击选词、三击选中整段**（与浏览器一致）；修饰键拖拽矩形框选（macOS `⌥`、其它平台 `Alt`），归一化坐标持久化；EPUB 高亮以 epub.js CFI 锚定
- **AI 对话**：侧边栏，选中文本或已有标注可按「引用」注入，`@` 联想引用章节 / 目录 / 页码 / 标注，分级上下文（选中/章节/全文RAG），流式输出
- **导出**：当前对话导出为 Markdown / 单文件 HTML / JSON，可选择引用、思考、工具调用与工具结果
- **朗读**：按句切分朗读，句级高亮跟读与自动翻页；引擎可切换 —— Edge 免费在线（含字级时间戳）、本地 sherpa-onnx 模型（MeloTTS 中英混排，离线可商用）、OpenAI 兼容 TTS 端点；引擎策略可选 **自动 / 在线优先 / 本地优先 / 仅本地 / 仅在线**（设置页与朗读时的工具栏都能切，朗读条会显示当前实际出声的引擎）；多音色试听、语速调节、内容寻址音频缓存与引擎失败回退
- **云同步**：WebDAV 优先，把阅读进度、标注与应用设置同步到你自己的网盘 —— 预设坚果云、InfiniCLOUD、Koofr、Nextcloud、群晖，也可填自建端点；按字段 + 设备时间戳合并，删除以墓碑跨设备传播，云端原书按需上传 / 下载；数据不经过任何中间服务器（详见 `docs/sync-research.md`、`docs/sync-webdav-plan.md`）
- **多提供商**：复刻 `pi-ai` 的 `Model/Context/StreamFn`，支持 OpenAI 兼容接口
- **自动更新**：从 GitHub Releases 按平台检查新版本，校验 SHA-256 后下载并原位覆盖，装完自动重启；状态栏提示 + 设置页「软件更新」（详见 `docs/update.md`）

## 技术栈

- Electron + Vite + React + TypeScript
- `packages/ai`：多提供商抽象（OpenAI 兼容）
- `packages/agent`：AgentLoop + `SessionManager` (JSONL)
- `packages/app`：主进程（IPC/图书馆/向量/OCR）+ 渲染进程（PDF/标注/对话）

## 快速开始

```bash
nvm use 22.23.2        # 要求 Node >=22.19.0
npm install           # 需代理/镜像以下载 Electron 二进制
# 代理示例：https_proxy=http://127.0.0.1:7890 npm install
# 镜像示例：ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install

npm run dev           # Electron + Vite
# 仅前端（无 Electron）：
npm run dev:web --workspace=@agentreader/app
```

设置 API Key：启动后点击侧边栏 `设置`，填 `Base URL / Model / API Key`。

> macOS 提示：`npm install` / `npm run dev` 会自动执行 `packages/app/scripts/patch-dev-app-name.mjs`，
> 把 `node_modules` 里 Electron.app 的名称补丁为 AgentReader 并 ad-hoc 重签名（macOS 菜单栏/
> Dock 名称取自 .app 包的 CFBundleName，`app.setName` 改不了）。如需还原：重装 electron 即可。

## 打包

在 `packages/app` 下构建 macOS 应用（`.app`）或安装包（`.dmg`）：

```bash
# 仅生成 .app（免签，验证最快）
npm run package:dir --workspace=@agentreader/app   # -> out/mac-arm64/AgentReader.app

# 生成 .dmg 安装包
npm run package --workspace=@agentreader/app       # -> out/AgentReader-<version>-arm64.dmg
```

产物输出到仓库根的 `out/` 目录。当前 macOS 仅支持 **arm64** 且 **未签名**（`packages/app/electron-builder.json` 中 `identity: null`）。首次启动时 macOS Gatekeeper 可能拦截未签名应用 —— 右键 → 打开，或执行：

```bash
xattr -dr com.apple.quarantine /Applications/AgentReader.app
```

Windows 端已预留打包配置（NSIS 安装包，x64，`build/icon.png` 自动转 ico）：

```bash
npm run package --workspace=@agentreader/app -- --win   # -> out/AgentReader-Setup-<version>.exe
```

未签名安装包在 Windows 上会触发 SmartScreen 提示（「更多信息 → 仍要运行」）；正式发布前需补代码签名证书。Windows 的菜单、快捷键提示（Ctrl+…）与单实例行为已适配，但尚未在真机验证。

## 文档

- `docs/requirements.md` 需求文档
- `docs/plan.md` 规划文档
- `docs/plan-v0.2.md` 提供商/多模型/Web Search/Skill 规划
- `docs/export-design.md` 对话导出（Markdown / HTML / JSON）设计
- `docs/tts-architecture.md` 朗读抽象层（引擎接口 / 缓存 / 回退）
- `docs/tts-research.md`、`docs/research/` 朗读方案调研与实测
- `docs/sync-research.md` 云同步（免费网盘 / GitHub / 设置同步）调研与架构建议
- `docs/sync-webdav-plan.md` WebDAV 先行方案：服务预设、应用内连接向导、InfiniCLOUD 端点反查
- `docs/sync-implementation-plan.md` 同步实施计划：任务分解、写盘审计、测试矩阵、里程碑
- `docs/progress.md` 进度记录
- `Reference/pi` 参考项目（已 gitignore，不提交）

## 目录

```
AgentReader/
├── docs/
├── packages/
│   ├── ai/         # 多提供商
│   ├── agent/      # AgentLoop + 会话
│   └── app/        # Electron 主/渲染/预加载
└── Reference/      # 参考（忽略）
```

## 路线图

- Phase 1 MVP：PDF + 标注 + 侧边栏对话 + 图书馆
- Phase 2：EPUB + RAG + 多提供商
- Phase 3：OCR 双轨（扫描版）+ 导出 + 扩展系统

## 开源协议

基于 [Apache License 2.0](LICENSE) 授权。
