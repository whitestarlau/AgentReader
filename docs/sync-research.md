# 云同步方案调研与建议 v0.3

> 生成时间：2026-11-25 | 状态：调研 / 建议（未实现） | 目标：用现成免费云空间做书籍与笔记的跨设备同步
>
> 修订 2：补入 VSCode 两代设置同步的实现对照（§2.4），据此把 GitHub 载体从「仓库」改成「Gist」、把合并策略从「纯 CRDT」改成「基线三方合并 + 全序键兜底」（§3.4）。
>
> 修订 3：新增 §4「设置同步（L0 层）」整章，回答「最好能同时把设置也同步了」；补 §2.5 说明 Google Drive / OneDrive 这两家的具体接法；新增可运行原型 [`research/settings-sync-prototype.ts`](research/settings-sync-prototype.ts)（净化策略 + key 级三方合并，含性质测试）。
> 修订 4（决策）：本期**只实现 WebDAV**，但保留 §3.1 的后端抽象层；接入体验（预设表 / 连接向导 / InfiniCLOUD 端点反查）拆到独立文档 [`sync-webdav-plan.md`](sync-webdav-plan.md)，原型见 [`research/webdav-presets.ts`](research/webdav-presets.ts)；实施任务分解、写盘审计与验收标准见 [`sync-implementation-plan.md`](sync-implementation-plan.md)。Gist / S3 / Google Drive / OneDrive 全部顺延至 W5 之后。

## 0. 结论先行

一句话：**不要绑定单一云厂商，做一个薄的后端抽象，先实现「本地文件夹」和「WebDAV」两个后端**。这两个后端就能覆盖绝大多数免费空间（含 iCloud Drive、OneDrive、坚果云、InfiniCLOUD、群晖、Nextcloud），且**不需要应用审核、不需要服务端、不需要维护 OAuth 客户端**。GitHub 作为第三个后端补上（对开发者用户最顺手）；Google Drive 与 OneDrive 技术上很干净但需要注册开发者应用、国内不可达，排在其后（§2.5）。

| 优先级 | 后端 | 免费空间 | 为什么是这个位置 |
|---|---|---|---|
| **1** | 本地文件夹（把 `library/` 镜像到任意同步目录） | 取决于网盘客户端 | 零 API、零审核；macOS 选 iCloud Drive 目录、Windows 选 OneDrive 目录、装了坚果云客户端选其同步目录，等于「顺手白嫖」了这些网盘的客户端 |
| **2** | WebDAV 通用 | 坚果云 1GB/月流量、InfiniCLOUD 20GB、Koofr 10GB、自建 | 一套代码吃四家；国内可直连；缺点是请求配额紧（见 §2.3），正好用「每本书一次请求」的布局化解 |
| **3** | **GitHub Gist（私有）** | 私有 gist 不限量；单文件经 API 读取超 1MB 会截断；单个 gist 最多 300 个文件 | 认证只要一个 PAT（`gist` 权限）、不用建仓库、一次 `PATCH` 更新多个文件，请求数最少；VSCode 第一代设置同步就是这么干的（§2.4）。同样受 AUP 约束，且不适合放原书 |
| **5** | S3 兼容（Cloudflare R2 / Backblaze B2） | R2 10GB 存储 + 出口免费 | 工程上最舒服（条件写、分片上传齐活），代价是要绑支付方式、要填 AK/SK |
| **6** | Google Drive | 15GB（与 Gmail/Photos 共享） | `drive.file` 是非敏感 scope，免审核、免安全评估，实现成本低；但国内连不上，且 Google 已废弃 OOB 复制粘贴授权，必须走 loopback + PKCE（接法见 §2.5） |
| **7** | OneDrive | 5GB | `Files.ReadWrite.AppFolder` 同样免审核、只碰应用自己的文件夹；要注册 Entra 应用，接法见 §2.5 |
| ✗ | iCloud 私有 API / CloudKit | — | 锁死 macOS，与「跨端」目标冲突；用「本地文件夹」指到 iCloud Drive 目录即可达到同样效果 |
| ✗ | 百度网盘 / 阿里云盘开放平台 | 大 | 个人开发者需资质与审核，授权范围受限；绕过去用 AList 之类桥接依赖其网页会话，易失效且有封号风险 |
| ✗ | Dropbox | 2GB | 额度最小，且同样要注册开发者应用，性价比最低 |

如果只是想「先接一家云再说」，**Gist 是成本最低的那个**（一个 PAT、两个接口、不用建仓库）；如果用户主要在国内，**WebDAV 的实用面更广**。

**技术栈（推荐落地组合，逐项都有理由）**

| 层 | 选型 | 为什么是它 |
|---|---|---|
| 运行位置 | Electron **主进程**（`packages/app/src/main/sync/`） | 凭据读写要用 `safeStorage`、文件要落 `userData`，这两件事只有主进程能做；渲染进程只拿状态 |
| 传输 | Node 内置 `fetch` + `node:fs`，**不引第三方 SDK** | 后端抽象只有 `list/get/put/del` 四个动作，WebDAV 是裸 HTTP，Gist/S3/Graph 都是 REST JSON；引 SDK 反而每个后端多一个依赖和一套升级节奏 |
| WebDAV 报文 | 手写 40 行 `PROPFIND` 解析（或 `fast-xml-parser`） | 只需要 `getcontentlength` / `getlastmodified` / `getetag` / `resourcetype` 四个字段，正则足够；受不了再加 `fast-xml-parser`（纯 JS、无原生编译） |
| OAuth（GDrive / OneDrive） | `node:http` 起 `127.0.0.1` 回环 + PKCE（`node:crypto`） | 桌面端唯一不被废弃的做法；不需要 client secret，开源仓库不用藏密钥 |
| 本机凭据 | `electron.safeStorage`（已有先例：`ai-auth.ts`） | 系统钥匙串托管，**不落明文**；注意它不可跨机器解密（§4.6） |
| 跨机器加密 | `node:crypto`：PBKDF2 / scrypt + AES-256-GCM | 用户空间是别人的服务器，笔记与设置应当可选择加密后再上传（§3.7） |
| 渲染进程状态 | 现有 `zustand` store + 一条 `sync:status` 推送 | 不引入新状态库 |
| 合并算法 | 纯函数（`merge3.ts` / `mergeSettings`）+ `node:test` 性质测试 | 与仓库现有 `node --experimental-strip-types --test` 风格一致，可 fuzz |
| 调度 | 主进程 `setTimeout` 去抖 + 持久化队列 `sync/queue.json` | 无需引入 job 库，崩溃可续 |

## 1. 先定「同步什么」

### 1.1 现状数据布局

```
{userData}/library/{docId}/
  original.pdf|epub      原书（只读，MB~百MB 级）
  doc.json               元数据 + 最后阅读位置（lastPage / lastLocation）
  annotations.json       标注数组（整文件覆盖写）
  reader-chapter.json    当前 EPUB 章节
  conversations.json     对话索引（id / title / createdAt / updatedAt）
  chats/{convId}.jsonl   逐条对话，追加写（自带 id + timestamp）
  (vectors.db, 音频缓存等)  可重建的缓存
```

### 1.2 三个决定性事实

1. **`docId` 是内容寻址**：`sha256(文件内容).slice(0,16)`（`library.ts:38`）。两台设备导入同一个文件，得到同一个 `docId`，**天然对齐**，不需要任何服务端映射表。
2. **标注坐标已归一化**，EPUB 用 epub.js CFI 锚定。即同一个文件在不同设备、不同字号、不同窗口尺寸下，标注位置仍然一致。
3. **对话是追加式 JSONL，条目自带 `id` 和 `timestamp`**。这意味着对话可以按 `id` 求并集合并，不需要「后写覆盖先写」这种粗暴策略。

这三点决定了：**同步可以完全去中心化，不需要账号体系、不需要服务端**。这也是为什么「用户自己的免费网盘」这条路在 AgentReader 上格外成立——我们没有服务端，本来就没有地方放用户数据。

### 1.3 分层同步

| 层 | 内容 | 体积 | 建议 |
|---|---|---|---|
| **L0 配置层** | `settings.json`（界面偏好 / OCR / 联网搜索 / TTS 选择）、`custom-providers.json`、`model-overrides.json` | 每台几十 KB | **默认同步**（净化后）。整章设计见 §4；凭据、本机绝对路径、`models.json` 默认不进同步体 |
| L1 笔记层 | `doc.json`（位置/标题）、`annotations.json`、`reader-chapter.json`、`conversations.json`、`chats/*.jsonl` | 每本 KB~几 MB | **默认同步**；这是「换台电脑接着读」的核心价值 |
| L2 书体层 | `original.pdf|epub` | 每本 1MB~200MB | **可选**（默认关）。开了才能「新设备一键拉全书」，但会吃光免费流量 |
| L3 缓存层 | 向量索引、TTS 音频缓存、缩略图、OCR 结果、`models-cache.json`、`model-metadata.json` | 大 / 可重建 | **不同步**，一律本地重建 |
| — | 安全决策：`skills-trust.json`、`permissions` 的「always」、`auth.json` | 小 | **永不同步**。理由见 §4.2 |

数据量估算：50 本书，L1 合计通常 < 5MB（对话多了会到几十 MB），L2 约 1GB。所以真正需要规划容量的是 L2。

## 2. 候选方案横向对比

### 2.1 总表

| 服务 | 免费额度 | 协议 | 认证方式 | 国内直连 | 适配成本 | 主要坑 |
|---|---|---|---|---|---|---|
| Google Drive | 15GB（与 Gmail、Photos 共享） | REST v3 | OAuth2 loopback + PKCE，scope `drive.file`（非敏感，免审核） | ❌ | 中 | OOB 授权已废弃；`drive.file` 只看得见本应用创建的文件；客户端 ID 要随包分发 |
| GitHub **Gist** | 私有 gist 不限量；API 读取**单文件上限 1MB**（超出 `truncated: true`）；单 gist 列举上限 300 文件 | Gist REST | PAT（`gist` 权限）或 Device Flow（**不需要 client secret**） | ⚠️ 时好时坏 | **最低** | AUP 禁止当文件托管；无 `If-Match`（无服务端条件写），并发要自己兜 |
| GitHub 仓库 | 私有仓库不限个数；单文件 ≤100MB（>50MB 警告）；仓库建议 <1GB | REST + Git Data API | 同上 | ⚠️ 时好时坏 | 低 | 同上；且 Git 历史随每次同步膨胀，**只在要放原书时才有优势** |
| 坚果云 | 每月上传 1GB / 下载 3GB；单文件 500MB | WebDAV | 应用密码（HTTP Basic） | ✅ | 低 | 免费版 **600 请求/30 分钟**；列目录一次最多 750 项需翻页 |
| InfiniCLOUD | 20GB，不限流量 | WebDAV | 应用密码 | ✅ | 低 | 日本服务，速度一般；连接 URL 每账号不同（在 My Page 里）；长期不登录可能清号 |
| Koofr | 10GB（另有 10GB 邀请赠送） | WebDAV | 应用特定密码（必需） | ✅ | 低 | 端点 `/dav/Koofr` **大小写敏感**；它的 429 不是限流而是「密码错太多次 → 锁号 1 小时」，绝不能自动重试（详见 [`sync-webdav-plan.md`](sync-webdav-plan.md) §1） |
| Nextcloud / 群晖 | 自建 | WebDAV | 账号密码 | 视部署 | 低 | 需要用户自己有服务器 |
| Cloudflare R2 | 10GB 存储 + 100 万 A 类请求/月；**出口流量免费** | S3 | Access Key / Secret | ✅ | 中 | 启用需要绑支付方式（免费额度内不扣费） |
| Backblaze B2 | 10GB | S3 | keyID / appKey | ✅ | 中 | 需绑卡；海外 |
| OneDrive | 5GB | Microsoft Graph | OAuth2 PKCE，`Files.ReadWrite.AppFolder` | ⚠️ | 中 | 需要注册 Azure 应用；个人版有节流 |
| Dropbox | 2GB | REST | OAuth2 PKCE，app folder | ⚠️ | 中 | 额度最小 |
| 阿里云盘 / 百度网盘 | 大 | 无面向个人开发者的开放写入 API | — | ✅ | — | 第三方桥接依赖网页会话，易失效、有封号风险 |
| iCloud Drive | 5GB（与 Apple ID 共享） | 无公开写入 API | — | ✅ | 极低（走本地文件夹） | 只有 macOS 能写；「优化存储空间」会把文件驱逐成 `.icloud` 占位符 |

### 2.2 几家重点点评

**坚果云（WebDAV）** —— 国内用户最现实的免费入口。帮助中心原文给出的限制比「1GB 空间」这种说法更要命：单文件 500MB、免费版每 30 分钟 600 次请求、单次列目录 750 项。600 次/30 分钟意味着**绝对不能「每个文件一次请求」地轮询**，必须做到「一本书一次请求」，并且靠去抖 + 手动触发控制频率。

**InfiniCLOUD（前 Teracloud）** —— 20GB 免费、不限流量，是「书库较大又不想绑卡」场景下最合适的。注意两点：新版认证体系下 WebDAV 地址和 app password 都要去 My Page 里取，不是固定的老域名；另外它对长期不活跃账号有清理政策。

**GitHub（用 Gist，不用仓库）** —— 免费额度看起来最爽，但两个硬约束：AUP 写明保留「限制文件托管、删除给基础设施造成不合理压力的仓库」的权利；单文件 100MB 那条在仓库里是死线。**真正该用的载体是私有 Gist 而不是仓库**：一个 gist 就是一个私有的、带版本历史的小文件集合，一次 `PATCH /gists/{id}` 可以同时更新几十个文件——同样的同步量，仓库路线要走 4 个请求（blob → tree → commit → ref），Gist 只要 2 个（GET + PATCH）。VSCode 第一代设置同步扩展正是这么做的，跑了多年，见 §2.4。Gist 的坑也很具体：API 读回来的单个文件超过 1MB 会被截断（要用 `raw_url` 取全文），一个 gist 最多列 300 个文件，而且**没有条件写**（没有 `If-Match`），并发得自己兜。所以定位是「笔记层 + 少量小书」，原书不要指望它。

**Google Drive** —— 技术上其实是最优雅的：`drive.file` 是**非敏感**权限，只要访问"本应用创建的文件"，因此**不需要 Google 的 OAuth 审核，也不需要 CASA 安全评估**（那是 `drive`、`drive.readonly` 这些受限权限才要的）。但代价是应用只能看到自己创建的文件——用户手动扔进 Drive 的书，应用看不见。另外 Google 早已废弃 `urn:ietf:wg:oauth:2.0:oob` 那种「复制授权码回填」的流程，桌面端必须起一个 `127.0.0.1` 端口接回调。对国内用户，最致命的是**连不上**。

**S3 兼容（R2 / B2）** —— 从工程角度看是「最像正规后端」的选项：条件写（`If-Match`）、分片上传、生命周期规则都是现成的，适合放原书。R2 的出口流量免费这一点对「换设备重新下载全书」特别友好。

**不建议的方向**：iCloud 私有 API（锁死 macOS）；百度网盘/阿里云盘开放平台（个人开发者拿不到写权限，桥接方案易失效）；把整本书塞进 git 并以「commit per change」方式同步（历史膨胀，很快撞上仓库体积建议值）。

### 2.3 已实测 / 已核实的关键点

- `https://dav.jianguoyun.com/dav/` 存在且可连通（未认证返回 401）。
- 坚果云 WebDAV 限制：单文件 500MB；免费版 600 请求 / 30 分钟；单次列目录 750 项（来源：坚果云帮助中心「坚果云第三方应用授权 WebDAV 开启方法」）。
- GitHub：单文件 >50MB 有警告、>100MB 直接被拒；仓库建议 <1GB、强烈建议 <5GB（来源：GitHub Docs "About large files on GitHub"）。AUP 带宽条款见同节引用。
- InfiniCLOUD：20GB 免费、不限流量；WebDAV 凭据在 My Page（来源：infini-cloud.net 首页与 "Utilizing InfiniCLOUD with WebDAV Applications"）。
- Cloudflare R2 免费额度：10GB-month 存储、100 万 Class A、1000 万 Class B、出口免费（来源：R2 Pricing）。
- GitHub Device Flow 的第 1 步（`POST /login/device/code`）与第 3 步（轮询换 token）**只要求 client_id**，不需要 client_secret（来源：GitHub Docs "Authorizing OAuth apps"）。
- Gist API 的截断规则：单文件最多返回 1MB 内容（`truncated: true`），files 列表最多 300 项；超出时需用 `raw_url` 或 clone（来源：GitHub Docs "Gists — Truncation"）。

### 2.4 前车之鉴：VSCode 的两代设置同步

这条线值得单独写，因为它把「用免费云空间同步本地状态」这件事的坑几乎全踩过一遍，而且两代实现的取舍正好对应我们要做的选择。

**第一代：社区扩展（`shanalikhan/code-settings-sync`，GitHub Gist）**

| 方面 | 做法 |
|---|---|
| 存储 | 用户私有 Gist。固定槽位 `settings.json` / `keybindings.json`（另有 `keybindingsMac.json`）/ `launch.json` / `locale.json` / `extensions.json` / `cloudSettings`；snippets 这类多层级目录，用 `snippets\|javascript.json` 把路径编码进扁平文件名 |
| 认证 | 主路径是用户粘一个 PAT，Octokit 以 `token xxx` 调用，只要 `gist` 权限 —— 不需要注册 OAuth App，也不需要 client secret。后期版本追加了 OAuth 登录：用 express 在本地端口起 `/callback` 接授权码（就是 loopback 流程），并支持配置 GitHub Enterprise 地址 |
| 云端元数据 | `cloudSettings` 里只有 `{ lastUpload, extensionVersion }`。判断「云端是否比我新」就靠 `lastUpload > 本地lastDownload` |
| 同步语义 | **整文件覆盖**，没有字段级合并，也没有基线 |
| 冲突 | 不检测。给两个按钮：Force Upload / Force Download |
| 并发 | 只有一个**本地** lockfile（npm `lockfile` 打在本地文件上）挡住同机多窗口；**跨机器完全没锁** |
| 自动上传 | chokidar 盯 VS Code 的 User 目录（depth 2），窗口聚焦时改动即上传；扩展列表变化也触发 |
| 删除远端文件 | `PATCH /gists/{id}` 时把该文件的值置 `null` |

结论：方案成立（gist 足够承载设置这种小数据），但「覆盖式同步 + 单个壁钟时间戳」就是它常年被吐槽「换机器把设置冲掉」的根因。**这两点都不能抄。**

**第二代：VS Code 内置 Settings Sync（1.48+，`src/vs/platform/userDataSync/`）**

| 方面 | 做法 |
|---|---|
| 存储 | 微软的 blob 存储（`vscode-sync.trafficmanager.net`），按资源类型分桶：settings / keybindings / snippets / tasks / extensions / globalState / profiles-manifest |
| 读 | `GET /{resource}/latest` 带 `If-None-Match: <上次的 ref>`，返回 304 表示没变 —— 省流量、省请求 |
| 写 | `POST /{resource}` 带 `If-Match: <ref>`，用服务端 ETag 做**乐观并发**；输的一方拿到 412 后重跑整个合并 |
| 定位清单 | `GET /manifest` 一次拿到所有资源的 ref，同样支持 `If-None-Match` |
| 合并 | 每个资源本地存一份 `lastSyncUserData`（上次同步成功的快照 + ref），合并是**三方**的：`merge(local, remote, base)`。以 `settingsMerge.ts` 为例，逐 key 比较 base→local 与 base→remote，**只有「两边都改且改得不一样」才算冲突**，其余自动采信改过的一方 |
| 冲突呈现 | 不静默覆盖，进「Settings Sync」视图逐条选边；`MergeState ∈ {Accepted, Conflict, Preview}` |
| 机器维度 | 远端数据带 `machineId`，机器专属设置不会串到别的机器 |
| 首次安装 | 本地没有基线但存有历史状态时，直接整份接受远端（`acceptRemote`），避免新机器把空设置推上去 |

**照抄清单**

- Gist 作为存储形态，PAT 单凭据，`manifest` + 每资源 `ref` 的定位方式；
- 「基线三方合并 + 只对真冲突打扰用户」；
- 扩展/依赖清单跟着设置一起同步（对应我们的「书库清单」）；
- 新设备首次同步走 `acceptRemote`，绝不拿空状态去覆盖云端；
- **可配置的 endpoint**（它支持 GitHub Enterprise，对应我们要支持的自建 WebDAV / S3 兼容服务）。

**不能抄的**

- 覆盖式同步、跨机器无锁、用单个壁钟时间戳判断谁新；
- 依赖服务端 `If-Match` —— Gist 和 WebDAV 都不保证有，得自己用「写完回读校验」兜（§3.4）。

### 2.5 用户点名的那两家：Google Drive 与 OneDrive 具体怎么接

这两家在最前面那张表里排在后面，**不是因为难，而是因为两件与代码无关的事**：要注册开发者应用（一次性、要人工填表），以及国内连不上。但它们的协议是最「正规」的，各写 300 行后端即可，所以结论是「排在后批，但一定要留好位置」。

三家（含前面的大多数）共享一个关键设计：**只碰应用自己创建的文件**。这既是免审核的前提，也是隐私卖点——用户网盘里其他东西我们看不见。

| | Google Drive | OneDrive |
|---|---|---|
| 权限 | `https://www.googleapis.com/auth/drive.file`（非敏感，走「已创建/已打开」的文件集合） | `Files.ReadWrite.AppFolder`（只能读写 `Apps/AgentReader/`） |
| 授权端点 | `https://accounts.google.com/o/oauth2/v2/auth` | `https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize` |
| 换 token | `POST https://oauth2.googleapis.com/token` | `POST …/oauth2/v2.0/token` |
| 桌面端流程 | 回环 `http://127.0.0.1:{PORT}` + PKCE(S256)；OOB 已被废弃 | 同上；Entra 里把平台登记为「移动和桌面应用」并允许公共客户端流 |
| 需要 `client_secret` | 不需要（安装型应用的 secret 本身也不保密；PKCE 足够） | 不需要（公共客户端 + PKCE） |
| 免费额度 | 15GB，与 Gmail/Photos 共享 | 5GB |
| 上限 | 简单上传 5MB 级别，大文件走 resumable upload（可断点续传） | `PUT …:/content` 支持到 **250MB**（已核对官方文档），更大走 `createUploadSession` |
| 节流 | 按用户每小时查询配额（远高于我们的量级） | 429 + `Retry-After`，个人版偶尔限速 |
| 目录语义 | `files.list(q="'<folderId>' in parents and trashed=false")`，`fields` 一定要显式限定 | `GET /me/drive/special/approot/children`，天然就是「应用文件夹」 |
| 条件写 | 支持 `If-Match: etag` | 支持 `If-Match: cTag/eTag` |

落地时真正会卡住的三件事（都不是文档里写着的）：

1. **Google 的「测试状态」坑**：OAuth 同意屏幕停在 *Testing* 时只有测试用户能授权，而且 **refresh token 只有 7 天寿命**。必须把应用 *Publish* 到生产（非敏感 scope 不需要 Google 人工审核，但要求填隐私政策 URL 与主页）。这一步不做，用户「用了一周突然要重新登录」。
2. **client ID 的归属**：client id 需要随包分发（它是公开信息），但开源项目里人人可拿去用，配额与审核责任会落在上游作者头上。做法照 rclone：**官方包内置一个，设置页允许用户填自己的 client id / tenant**（对应 §2.4 里 VSCode 支持 GitHub Enterprise 的同类抽象）。
3. **一次性开关**：这两家都要求「首次使用前先去网页端建应用」，与 WebDAV 的「填一个应用密码就能用」体验差一个量级。所以设置页的文案要把「需要 5 分钟注册」提前说清，否则用户会在授权失败时认为应用有 bug。

顺带把「谁来存 OAuth token」定下来：token 依旧是**本机凭据**，进 `safeStorage`，不进同步体（否则同步凭据会变成递归问题，见 §4.6）。token 过期后走静默刷新；刷新失败就把同步状态降级为「需要重新授权」，别弹窗轰炸。

## 3. 推荐架构

### 3.1 后端抽象

一个刻意做薄的接口。所有后端只做「键值 + 原子写」这一件事，冲突合并全部由上层完成——**这样即使后端不支持 ETag 或条件写，正确性也不受影响**。

```ts
// packages/app/src/main/sync/backend.ts
export type RemoteEntry = {
  path: string;          // 相对同步根，POSIX 风格，如 "state/ab12cd34ef567890.json"
  size: number;
  mtime?: number;
  etag?: string;
};

export type PutOptions = {
  /** 乐观并发：不满足则抛 SyncConflict，而非静默覆盖。不支持的后端可忽略。 */
  ifMatch?: string;
  ifNoneMatch?: boolean;
};

export interface SyncBackend {
  readonly id: "local-folder" | "webdav" | "github" | "s3" | "gdrive" | "onedrive";
  readonly label: string;
  readonly caps: {
    conditionalWrite: boolean;   // 是否支持 ifMatch
    maxObjectSize: number;       // 单文件上限，用来决定原书能不能传
    requestBudgetPerMinute: number; // 用于限流器，坚果云填 20
  };
  /** 一次调用拿到整个前缀下的条目清单；后端应尽量批量（WebDAV 用 PROPFIND Depth:1）。 */
  list(prefix: string): Promise<RemoteEntry[]>;
  get(path: string): Promise<Buffer | null>;
  put(path: string, data: Buffer, opts?: PutOptions): Promise<{ etag?: string }>;
  del(path: string): Promise<void>;
  /** 连通性与权限自检，给设置页的「测试连接」按钮用。 */
  test(): Promise<{ ok: boolean; error?: string; freeBytes?: number }>;
}
```

### 3.2 远端布局

扁平、按「一本书一个状态文件」，把请求数压到最低：

```
AgentReader/                      ← 同步根（用户可自定义子目录名）
  manifest.json                   ← 索引：schema 版本 + 每本书的 rev/size/是否有原书 + 设置的 rev
  state/{docId}.json              ← 一本书的全部 L1 状态（位置 + 标注 + 章节 + 对话索引）
  chats/{docId}/{convId}.jsonl    ← 对话正文（追加式，天然可合并）
  books/{书名} [{docId}].pdf|epub ← 可选，原书（书名可读，方括号里是内容 hash）
  settings/state.json             ← L0 配置（净化后），见 §4
  settings/creds.enc              ← 可选，E2E 加密的凭据库，见 §4.6
```

为什么不「本地文件原样镜像到云端」：一是文件数多（请求数爆炸，坚果云扛不住）；二是本地结构会演进（比如 `chats.jsonl` 拆成 `chats/*.jsonl` 已经发生过一次），远端格式应当与本地文件布局解耦，只与数据语义绑定。

**原书的文件命名**：`书籍元数据里的书名 [docId].扩展名`（如 `深入理解计算机系统 [ab12cd34ef567890].pdf`）。纯 `docId` 可读性太差、纯书名会撞车，所以两者都留：hash 保证「换设备/重新导入/云端被改名」都还能对上同一本书，书名保证用户在网盘网页里一眼能认出。`docId` 只在文件名里，不影响内容寻址本身。

**映射到 Gist 时**：一个私有 gist 就是同步根，上面每个文件对应一个 gist 文件，`/` 用 `|` 编码进文件名（沿用第一代 VSCode 扩展的写法：`chats|{docId}|{convId}.jsonl`）。所以一个 gist 的文件数上限（300）就是我们的书数上限——按「一本 L1 状态 + 若干对话」算，够用几百本，超了就提示改用仓库或 S3。注意 gist **放不下原书**（1MB 读取截断），原书要走仓库或 S3 后端；这也是为什么后端接口要能声明 `caps.maxObjectSize`。

`manifest.json` 只放索引，不放冲突数据：

```jsonc
{
  "schema": 1,
  "updatedAt": 1764112345678,
  "library": {
    "ab12cd34ef567890": {
      "title": "深入理解计算机系统.pdf",
      "ext": "pdf",
      "rev": 17,                 // 每次写入 +1，用于「要不要拉」的判断
      "stateSize": 48213,
      "original": { "size": 18874368, "sha256": "ab12cd34ef567890…" } // null 表示未同步原书
    }
  }
}
```

### 3.3 同步流程

```
pull():                                    # 每 30~120s 一次，或启动时
  manifest = get("manifest.json")
  for docId, entry in manifest.library:
     local = localIndex[docId]             # 存在 {userData}/sync/index.json
     if entry.rev > local.rev:
        remoteState = JSON.parse(get(`state/${docId}.json`))
        merged = merge3(base(docId), localState(docId), remoteState)   # §3.4
        writeLocal(docId, merged)                    # 先备份旧文件
        base(docId) = merged                         # 基线只在 pull 成功推进时更新
  # 原书：只在用户点「下载本书」或首次打开缺原书时才拉

push():                                    # 本地写入后去抖 20s 排队
  pull()                                   # 必须先拉：基线失效就不能三方合并
  for docId in dirtySet:
     state = readLocalState(docId)
     state.rev = max(local.rev, remote.rev) + 1
     put(`state/${docId}.json`, state)     # 失败则留在队列，指数退避
     verifyAfterWrite(state)               # 回读校验，见 §3.4.3
     for convId in dirtyConvs: put(`chats/${docId}/${convId}.jsonl`, …)
  put("manifest.json", manifest)           # 最后写 manifest
  base(docId) = state for each pushed doc
```

关键点：
- **push 之前必须 pull**。基线是三方合并的前提，跳过拉取就等于退回「覆盖式同步」。
- **manifest 最后写**。中途崩溃最多导致「manifest 落后于 state」，下次 pull 时用「state 目录列表 + rev 不一致」兜底重拉，不会丢数据。
- **写后回读**。没有条件写的后端（Gist、多数 WebDAV）靠这一步发现「被别的设备覆盖了」，再重走合并。
- **推送串行 + 令牌桶**。所有后端共用一条队列，按 `caps.requestBudgetPerMinute` 限速。坚果云填 20 就很安全（600/30min = 20/min）。

### 3.4 冲突合并：基线三方合并，全序键兜底

这是整个功能里唯一真正需要小心的地方。上一版草稿我给的是「纯 CRDT 式：LWW + 墓碑」，读完 VSCode 的两代实现（§2.4）后改成了**基线三方合并为主、全序键兜底**——理由下面写清楚，不是推翻，是分层。

#### 3.4.1 主策略：基线三方合并

每个 doc 在本地额外存一份 `{userData}/sync/base/{docId}.json`：**上一次成功同步后的 L1 快照**。它只存在本地，不传云端。合并时以它为基准做三方比较：

```
base   = 上次同步成功的快照
local  = 本机当前状态
remote = 云端当前状态
```

对集合型数据（标注、对话索引、对话条目）逐 `id` 判定：

| local vs base | remote vs base | 结果 |
|---|---|---|
| 未变 | 未变 | 不变 |
| 未变 | 变了（含被删） | **取 remote** |
| 变了 | 未变 | **取 local** |
| 都变了且结果相同 | — | 取任一 |
| 都变了且结果不同 | — | 真冲突 → 按 §3.4.3 处理 |
| 一侧删除、另一侧未改 | — | 删除 |
| 一侧删除、另一侧改过 | — | 真冲突（默认保留，不丢用户数据） |

对单值数据（阅读位置、当前章节）：单侧变更直接取；两侧都变才落到兜底规则。

这套规则的价值：

- **不需要墓碑**。删除由「base 里有、现在没有」推导，省掉墓碑字段和 30 天 GC 窗口 —— 相比草稿版，数据模型少改一处。
- **不依赖时钟判断谁新**。时钟只用于展示和兜底 tie-break，所以用户在不同时区、系统时间没校准也不会丢数据。
- **能区分「只有一方改」和「双方都改」**。前者静默自动合并（占绝大多数），后者才打扰用户 —— 这正是 VSCode 内置同步的做法。
- **首装安全**：新设备没有 base 但云端有数据时，直接整份接受远端，不会拿空状态覆盖云端（对应 VSCode 的 `acceptRemote`）。

代价只有一个：**基线必须有效**，即「推送前必须先拉」。所以 §3.3 的流程是严格的 pull → merge → push，不允许跳过拉取直接推。

#### 3.4.2 兜底：全序键

真冲突（或单值两边都变）时要有个确定性的裁决，用 `(updatedAt, deviceId, id)` 的全序取最大。

`deviceId` 必须是**每条记录自带的字段**，不能作为合并函数的入参。草稿版的随机化原型里就是这么翻车的：两台设备同一毫秒各翻到不同页，`updatedAt` 相等又无末位键，`merge(a,b)` 取 a、`merge(b,a)` 取 b，第一轮就分叉。壁钟毫秒碰撞在真实场景里完全可能（同一设备连续两次写也会），所以 `deviceId` 必须是**记录里的字段**。

还有第二个坑，跑测试时才暴露：**`updatedAt` 必须在一台设备内严格递增**，不能直接用 `Date.now()`。同一毫秒内写两次（比如拖动阅读位置时连续 `reading:save`）会产生两个 `(updatedAt, deviceId)` 完全相同的记录、内容却不同，全序键就退化成非全序，合并结果随拉取方向变化。做法是每台设备维护一个混合逻辑时钟：

```ts
// 严格递增：同一设备内任意两次写入的时间戳必然不同
let lastTs = 0;
const nextTs = () => (lastTs = Math.max(Date.now(), lastTs + 1));
```

这是 HLC（hybrid logical clock）的最简形式，代价为零，却把「兜底一定收敛」从概率变成保证。

| 数据 | 合并方式 | 兜底裁决 |
|---|---|---|
| 标注 | 三方（§3.4.1） | `(updatedAt, deviceId)` 取最大；或按设置「都保留」（副本换新 id） |
| 对话索引 | 三方 | 同上 |
| 对话条目 | 追加式并集（`id` 唯一，天然可合并） | 内容被编辑过（`editedAt`）才走三方 |
| 阅读位置 / 章节 | 单侧变更直接取 | `(positionUpdatedAt, positionDevice)` 取最大 + 提示「另一台设备读到第 N 页」 |

顺带一提：改用基线之后，`editTranscript` 的破坏性截断**不再需要控制行**——「base 里有 m6~m10、现在没有」本身就是删除证据，git 式合并天然处理。这又省掉一处改造。（两台设备各自重新生成同一段对话仍会产生重复条目，属于极小概率，交给用户删除即可。）

#### 3.4.3 没有 `If-Match` 的后端怎么保证不互相覆盖

VSCode 内置同步靠服务端 ETag + `If-Match` 做乐观并发。Gist 和多数 WebDAV 服务**都没有**这个能力，所以要自己兜：

1. 推送前 `GET` 当前远端 ref（gist 用 `updated_at` / history 版本号，WebDAV 用 `getlastmodified` + `getetag`）；
2. `PUT`/`PATCH` 写入；
3. **回读校验**：再 `GET` 一次，确认落盘内容和自己的写入一致；不一致说明中途被别的设备覆盖 → 重新拉取、重新三方合并、重试（上限 3 次，之后报冲突让用户决定）。

多花一次 GET，换来「不会静默吃掉另一台设备的写入」。这个回读还顺带验证了服务端有没有悄悄截断/改写内容。

#### 3.4.4 数据模型改造清单

| 文件 | 改动 | 说明 |
|---|---|---|
| `doc.json` | 加 `positionUpdatedAt` / `positionDevice` | 位置和标题共用一个时间戳会让改标题把阅读位置也判新 |
| `annotations.json` | 加 `updatedAt` / `deviceId`（**不需要墓碑**） | 仅用于兜底裁决与冲突展示；旧数据缺省视为 `0`/空串 |
| `chats/*.jsonl` | 无需改动 | 条目已带 `id` + `timestamp`；截断由基线推导 |
| `settings.json` | 加 `deviceId`（首次启动生成的 UUID） | 兜底 tie-break + 「最后修改来自哪台设备」 |
| 新增 `sync/base/{docId}.json` | 上次同步快照 | **只在本地**，不传云端；丢了也能工作（退化为整份比较） |

> **已验证**：两个策略都写了原型并跑通，见 [`docs/research/sync-merge-prototype.ts`](research/sync-merge-prototype.ts)（`node --experimental-strip-types` 直接可跑）。
> - 三方合并 A：6500 轮随机用例 —— 单侧变更 2000 轮必须原样落地、交叉变更 2000 轮必须零冲突合并、同 id 双侧改动 1500 轮必须报冲突且与顺序无关、删除守卫 1000 轮（一侧删一侧改必须保留并标记冲突）。
> - 兜底 B：2000 轮 —— 交换律、幂等、结合律、同毫秒跨设备 tie-break 全部通过。
>
> 实现时把 `merge3` / `mergeLWW` 搬进 `merge3.ts`，把这两个 fuzz 循环转成 `node:test` 用例即可。

### 3.5 请求预算

以 50 本书、一次同步 3 本有变化为例（WebDAV）：

| 步骤 | 请求数 |
|---|---|
| `GET manifest.json` | 1 |
| `GET state/{docId}.json` × 3 | 3 |
| `PUT state/{docId}.json` × 3 | 3 |
| `PUT manifest.json` | 1 |
| 合计 | **8** |

即使「全部 50 本都变了」也是 ~101 次请求，远低于坚果云 600/30min。反过来说：如果按「一本书拆 6 个文件」同步，50 本就要 300+ 请求，配额立刻告急——这就是 §3.2 那个布局的真正原因。

各后端的成本差异（同样「50 本书、3 本有变化」）：

| 后端 | 一次同步的请求数 | 说明 |
|---|---|---|
| 本地文件夹 | 0 | 纯粹的文件读写，没有网络配额概念 |
| Gist | **2~3** | 1 次 GET 拿 gist + 1 次 PATCH 更新全部文件（+ 1 次写后回读） |
| WebDAV | 8~9 | 清单要 `PROPFIND`，每个文件一个 `PUT`，再算上回读 |
| 仓库（Git Data API） | 4 + N | blob × N 之后 tree/commit/ref 各 1，但**每次同步都会新增一份历史** |
| S3 / R2 | 2 + N | `ListObjectsV2` 一次 + 每对象一次 `PUT`；新版 S3 有条件写（`If-Match`/`If-None-Match`），支持的话可省掉回读（R2 需实测） |

Gist 之所以最省，是因为「一个 gist = 一个批次」这个语义天然对齐了我们的同步单位。

### 3.6 原书按需同步

- 默认只同步 L1。用户在书库条目上点「同步此书到云端」或全局开关「包含原书」才上传 L2。
- 上传前检查 `size <= caps.maxObjectSize`（坚果云 500MB、GitHub 100MB），超限直接拒绝并提示「这本书超过后端单文件上限，只同步笔记」。
- 下载原书后**必须校验** `sha256(content).slice(0,16) === docId`，不匹配就丢弃并报错——这能挡住网盘上的半截文件、被改写的文件、以及「文件名对了但内容不对」的情况。
- 大文件分片：WebDAV 没有原生断点续传，用「分片 PUT 到 `tmp/{docId}.part.{n}`，全部完成后 `MOVE` 拼装」；S3 用原生 multipart。

### 3.7 端到端加密（可选开关）

用户的免费空间多半是「别人的服务器」，如果同步到 GitHub 私有库或第三方网盘，笔记内容和书名都是明文。加一层可选的端到端加密，成本不高、收益明确：

- 用户设置同步密码 → `PBKDF2-SHA256(密码, salt, 200k 次)` 派生 32 字节密钥；
- 文件内容 `AES-256-GCM` 加密（`node:crypto`，WebCrypto 亦可）；
- 远端路径里的 `docId` 换成 `HMAC-SHA256(密钥, docId).slice(0,16)`，避免「谁能算出 hash 就知道你有什么书」；
- 代价：密码丢失即数据不可恢复（必须显式提示），且服务端不再能做任何去重/校验——所以要额外存一份 `sha256(明文)` 在 manifest 里做完整性校验。

加了密之后，`manifest.json` 里只能放最小元信息（掩码 id、大小、rev），标题也要进加密体，否则书名泄露。

### 3.8 调度与断点

- 触发：启动后 10s 拉一次；本地写入后去抖 20s 推一次；窗口失焦/退出前 flush；设置页有「立即同步」。
- 队列持久化到 `{userData}/sync/queue.json`，崩溃重启后继续。
- 退避：429/503 → 指数退避（1s、2s、4s… 上限 5min）；401 → 停止并提示重新授权；507（配额超限）→ 停止并提示清理。

## 4. 设置同步（L0 层）

前置结论：**设置同步与书库同步共用同一套后端、队列、限流、加密和冲突 UI，但合并算法必须换一套**。书库是「记录集合」，两条记录求并集不会打架；设置是「键值表」，一个 key 只有一个真值。把两者硬塞进同一个合并函数，是这类功能最常见的翻车点。

好消息是设置层的数据量只有几十 KB，风险极低——所以它其实是**最适合第一个做**的同步能力：可以在真正动书库之前，把后端抽象、净化、冲突 UI、限流这一整套骨架跑通。

### 4.1 现状盘点：这个应用到底有哪些「设置」

翻代码得到的事实（不是猜的）：

| 文件 | 内容 | 谁在写 | 同步建议 |
|---|---|---|---|
| `settings.json` | 扁平 `Record<string, string>`：`ocrLang`、`agentMaxTurns`、`webSearch{Enabled,Backend,MaxResults}`、`skillsExecutionEnabled`、`ttsEngine`、`ttsVoice`、`ttsVoice:<engineId>`（按引擎分键）、`ttsRate`、`ttsModel`、`ttsLang`、`ttsVoices`、`ttsMaxChars`、`ttsCacheMb`、`ttsEndpoint`、`ttsSherpa*`、`theme`、遗留的 `baseUrl`/`model` | 界面 + 程序混写 | **净化后同步**（本节主角） |
| `custom-providers.json` | 手动添加的 OpenAI 兼容提供商 | 仅程序写 | **同步**（整文件） |
| `model-overrides.json` | 按 provider/model 的上下文覆盖 | 仅程序写 | **同步**（整文件） |
| `models.json` | JSONC，**带注释**，以用户手改为主 | 用户写 | **默认不同步**（§4.5） |
| `auth.json` | `safeStorage` 加密的各提供商 API Key | 程序写 | **永不同步**（可选 E2E 库，§4.6） |
| `models-cache.json`、`model-metadata.json` | 模型目录缓存 | 程序写 | 不同步（可重建） |
| `skills-trust.json`、权限的「always」 | 「已授权执行代码」的白名单 | 用户决策 | **永不同步** |
| `sync/config.json`（新增） | 同步后端自己的凭据：WebDAV 密码 / PAT / OAuth token | 程序写 | **永不同步**（递归问题，§4.6） |
| 窗口尺寸、侧栏宽度（`localStorage`） | 渲染进程状态 | 界面 | 不同步（机器相关） |

前两行（`settings.json` + 两个 provider 配置文件）就是「换台电脑不重新配一遍」的全部痛感来源，合计约 10~40KB。

### 4.2 三类归属：判断标准不是「重不重要」

真正该问的是三件事：**搬过去会不会出错（机器绑定）？会不会泄露（凭据）？会不会把别人的正确值覆盖掉（安全决策）？**

| 类别 | 判定 | 本应用里的例子 |
|---|---|---|
| 可同步 | 值是「用户偏好」，与机器无关 | `ocrLang`、`agentMaxTurns`、`webSearch*`、`ttsEngine`、`ttsVoice:*`、`ttsRate`、`theme`、两个 provider 配置文件 |
| 本机专属 | **值与机器绑定** | `ttsSherpaModelDir` / `ttsSherpaVocoder`（绝对路径）、模型是否已下载、窗口布局 |
| 本机专属 | **值是凭据** | `auth.json`、`sync/config.json`、`apiKey`、`ttsEndpoint` 里带 `?key=…` 的 URL、`webSearchApiKey` |
| 永不 | **值是安全决策** | `skills-trust.json`、权限「always」——一台机器上的授权不该自动成为另一台机器上的授权 |

最需要警惕的是第三、四行：**同步一个信任白名单，等于把「我在 A 机器上点过允许」放大成「所有机器都允许」**。这类数据连「可选同步」都不该给。

### 4.3 同步体的形状

远端只有一个文件 `settings/state.json`（书库同步的 `state/{docId}.json` 之外再多一个，不是每台机器一个文件——否则合并又变成 N 方）：

```jsonc
{
  "schema": 1,
  "updatedAt": 1764112345678,
  "kv": {                        // settings.json 净化后的键值，形状与原文件一致
    "ocrLang": "chi_sim+eng",
    "ttsEngine": "edge",
    "ttsRate": "1.2"
  },
  "kvMtimes": {                  // 每个 key 最后一次写入的 (时间戳, 设备)
    "ocrLang":  { "at": 1764112000000, "dev": "ab12cd34" },
    "ttsRate":  { "at": 1764112345678, "dev": "ab12cd34" }
  },
  "kvTombstones": {},            // 删除墓碑，只在一侧删、另一侧无基线可比时才起作用
  "files": {                     // 应用维护的整文件配置
    "custom-providers.json": { "text": "{\n  \"my-llm\": { … }\n}", "at": 1764110000000, "dev": "ab12cd34" },
    "model-overrides.json":  { "text": "{}", "at": 1764100000000, "dev": "ef567890" }
  }
}
```

两个刻意的选择：

- `kv` 的形状与 `settings.json` **完全一致**（扁平字符串表），写回本地时零转换，也就不存在「同步体格式演进把本地文件写坏」的第二类 bug。
- `files` 里存的是**原文件文本**而不是解析后的对象——`custom-providers.json` 是纯 JSON、由程序生成，原样搬运最安全。

### 4.4 合并：key 级三方 + 每键 Stamp

书库用「记录级」三方合并（§3.4），设置这里把粒度再降一层到**单个 key**。理由很直接：用户在 A 机器改 `ttsEngine`、在 B 机器改 `ocrLang`，这是两次完全不相干的修改，任何「整文件覆盖」都会吃掉一边——VSCode 第一代设置同步被骂多年，根因就是这个。

逐 key 判定（与 §3.4.1 同一张表，粒度换成 key）：

| 本机 vs 基线 | 远端 vs 基线 | 结果 |
|---|---|---|
| 未变 | 变了（含被删） | 取远端 |
| 变了 | 未变 | 取本机 |
| 都变了、值相同 | — | 取任一个 |
| 都变了、值不同 | — | 真冲突 → 按 `(at, dev)` 全序取大，并记下另一方的值 |
| 一侧删除、另一侧未动 | — | 删除 |
| 一侧删除、另一侧改过 | — | **保留改过的值** + 报冲突（不丢数据优先） |
| 无基线时一侧缺失 | — | **缺席不等于删除**，取有值的一方 |

最后两条是我在原型里刻意做得比 VSCode 更保守的地方：

- **删除 vs 修改**：VSCode 会按时间裁决，我们选择「内容永远胜出，同时弹一条冲突」。用户丢一个 key 的代价是「某项设置回到默认」，但丢内容的心理成本高得多。
- **无基线时的缺席**：新设备第一次同步，本地没有基线、绝大多数 key 都不存在。如果按「对方没有 = 删除」处理，就会拿一台空白机器把云端配置清空。原型 P7 专门守这条。

`at` 仍是 §3.4.2 那个**设备内严格递增的 HLC**（`nextTs = max(Date.now(), lastTs + 1)`），不是裸 `Date.now()`：同一毫秒内改两次设置（拖 TTS 语速就会）会产生两个戳完全相同的记录，全序键退化成非全序。`dev` 是首次启动生成的 `deviceId`，**存在每条记录里**而不是合并函数的入参。

冲突的呈现：设置页「同步」分区里一列冲突卡片（`ocrLang`：本机 `chi_sim+eng` / 远端 `jpn`），逐条选边，默认不动。追求「零打扰」也可以：冲突少于一屏时内联展示，多了再进独立面板。

### 4.5 净化：剔除，而不是掩码（这条最容易写错）

直觉做法是「把敏感值打个码再上传」。**这是错的**，而且错得很隐蔽：

```ts
// 反例：不要这么做
const masked = endpoint.replace(/([?&]key=)[^&]*/, "$1***");
// → 本机 ttsEndpoint = "https://tts.example.com/v1?key=REAL"
// → 上传 "https://tts.example.com/v1?key=***"
// → 另一台机器拉到后把真 key 覆盖成 ***，TTS 直接坏掉，且用户完全看不出原因
```

因为 LWW 合并会把「掩码后的值」当成一次合法写入，覆盖对方机器上的真值。所以规则必须是**整 key 不进同步体**（剔除），而不是「值打码」。原型里 `demoMaskingIsWrong()` 就是这个反例的可执行版本。

判定函数（三条规则 + 一张名单，全部纯函数、可单测）：

```ts
// 1) 显式本机 key 名单
const LOCAL_ONLY = new Set(["apiKey", "deviceId", "ttsSherpaModelDir", "ttsSherpaVocoder", "syncPassword"]);
// 2) key 名里含凭据词（先归一 `:.-`，再拆驼峰，避免误伤 ttsMaxChars / agentMaxTurns）
//    webSearchApiKey → web_search_api_key ✓   ttsMaxTokens → 命中 token，宁严勿松
const SECRET_WORD = /(^|_)(api_?key|apikey|secret|token|passw(or)?d|credential|bearer|auth)($|_)/;
// 3) 值本身就是路径
const ABS_PATH = /^(?:\/Users\/|\/home\/|\/Volumes\/|\/private\/|[A-Za-z]:\\)/;
// 4) 值里带凭据的 URL
const URL_CRED = /[?&](key|token|api[_-]?key|apikey|access_token|auth)=/i;
```

写回本地时有个必须注意的对称问题：**不能把净化后的结果整体落盘**，否则会把本机专属 key（`ttsSherpaModelDir`、`apiKey`）一起删掉。正确顺序是：读原始 `settings.json` → 把同步回来的 key 覆盖上去 → 本机专属 key 原样保留 → 再写盘。

`models.json` 是单独的坑：它是**唯一由用户手写、且带注释**的 JSONC，整份同步会丢注释，两台机器的注释还会互相打架（§2.4 提到 VSCode 用 `settingsMerge.ts` 逐 key 合并，是因为它的 settings.json 没有注释可丢；我们这里继承不了这个便利）。所以：

- 默认**不同步** `models.json`；
- 用户显式打开「接管 models.json」时，只做整文件 + 「会丢注释」提示 + 冲突不自动裁决；
- 无论哪种情况，都要先剥掉 `providers.*.apiKey`（文档里写着「不推荐但允许」内联密钥）；
- 长期解法是把用户可编辑的部分迁到 `models.local.json`，与带注释的默认配置分离——那是独立的重构，不塞进这次同步。

### 4.6 凭据到底能不能同步：`safeStorage` 不可跨机器

先摆事实：`safeStorage.encryptString()` 的密钥来自系统钥匙串（macOS Keychain / Windows DPAPI / Linux libsecret），**密文换台机器解不开**。`ai-auth.ts` 现在的 `decrypt()` 在失败时会静默返回原文——所以真把 `auth.json` 搬到另一台机器，表现是「API Key 变成一串 base64 乱码，然后所有请求 401」，而不是一个明确的报错。

三个选项：

| 选项 | 做法 | 评价 |
|---|---|---|
| **A 不同步（默认）** | 每台机器自己填一次 Key | 最省事、最安全；「换机要重填 Key」这个成本用户能接受 |
| **B 独立暗号库（可选）** | 用户设一个「同步口令」→ `scrypt/PBKDF2` 派生密钥 → `AES-256-GCM` 加密后写 `settings/creds.enc`；口令本身用 `safeStorage` 缓存，避免每次输 | 体验最好，但**忘口令 = 数据永久丢失**，必须在开关旁写明；与 §3.7 的 E2E 加密共用同一套实现 |
| C 明文随设置同步 | — | 禁止。用户的免费空间可能是 GitHub 私有 gist 或第三方网盘 |

还有一个递归问题要提前堵死：**同步后端自己的凭据（WebDAV 密码、PAT、OAuth token）不能放在 `settings.json` 里**，否则「同步设置」会把「同步用的凭据」也同步出去，形成自我指涉。做法是把它们放进 `sync/config.json`，增值的加密用 `safeStorage`——这个文件**从结构上就不在同步体内**，不需要靠过滤规则去排除。

### 4.7 请求预算与触发

设置卷进同一条同步流程，成本几乎可以忽略：

| 步骤 | WebDAV 请求数 | Gist 请求数 |
|---|---|---|
| `GET manifest.json` | 1 | 1 |
| `GET settings/state.json` | 1 | 0（同一个 gist 一起返回） |
| `PUT settings/state.json` | 1 | 1（与书库文件合并进同一次 `PATCH`） |
| `PUT manifest.json` | 1 | 0（同上） |
| 合计 | **4**（有变化时）/ 2（只拉不推） | **2** |

触发策略：`settings.json` 写入后**去抖 5 秒**（书库是 20 秒——用户改设置时通常正盯着界面，延迟太久会觉得没生效）；启动后 10 秒与书库共用第一次 pull；窗口失焦/退出前 flush；设置页提供「立即同步」。

### 4.8 接入点

| 文件 | 改动 |
|---|---|
| `packages/app/src/main/settings.ts` | 拆出 `readRawSettings()` / `writeRawSettings()`（不加密、不合并，纯 IO）；`updateSettings()` 落盘后 `markSettingsDirty()` 并给改动的 key 打 `stamp` |
| 新增 `packages/app/src/main/sync/settings-state.ts` | `sanitize()`（§4.5）、`mergeSettings()`（§4.4，纯函数）、`applyRemote()`（读原始 → 覆盖可同步 key → 保留本机专属 key → 写盘） |
| 新增 `packages/app/src/main/sync/config.ts` | 同步后端配置 + 凭据（`safeStorage`），**不在同步体内**；`deviceId` 首次生成 |
| `packages/app/src/main/ai-config.ts` | `custom-providers.json` / `model-overrides.json` 写盘后 `markSettingsDirty("files:…")`；`writeConfigText()`（models.json）默认不触发同步 |
| `packages/app/src/main/index.ts`、`preload/index.ts` | IPC：`sync:settings:status`、`sync:settings:conflicts`、`sync:settings:resolve`、`sync:settings:now` |
| `packages/app/src/renderer/components/Settings.tsx` | 新增「同步」分区：后端选择 → 凭据表单 → 测试连接 → 同步范围（笔记 / 原书 / 设置）→ 加密开关 → 立即同步 → 冲突入口 |
| `packages/app/src/renderer/components/shell/StatusBar.tsx` | 同步状态图标：同步中 / 有冲突 / 离线 / 已是最新（与书库共用同一个状态源） |

### 4.9 已验证：原型与性质测试

[`research/settings-sync-prototype.ts`](research/settings-sync-prototype.ts) 实现了本节的净化与合并，`node --experimental-strip-types` 直接可跑，实测输出：

```
ok P1 单侧变更自动合并，冲突 0 条
ok P2 收敛性：3000 轮随机用例，两个拉取方向结果一致
ok P3 幂等：2000 轮，merge(base, X, X) === X
ok P4/P5 删除语义：未动的一侧被删除，改过的一侧被保留并报冲突
ok P6 净化：剔除 5 个本机专属 key，同步体里不含任何凭据
ok P7 首装：无基线时不丢数据、不报冲突
ok 收敛：冲突裁决后第二轮不再重复报冲突
ok P8 文件型配置：单侧变更自动落地，双侧变更取更晚一份并报冲突
```

写测试时被自己抓住的两个真问题，值得记下来：

1. 第一版的凭据正则要求「分隔符 + api_key」，于是 `webSearchApiKey`（驼峰）漏网。改成「先把 `:.-` 归一成 `_`、再把驼峰拆开」之后才正确——**凭据判定必须对驼峰敏感**，而这个仓库的 key 命名恰好是驼峰为主。
2. P2 一开始比对的是整个冲突对象，包括 `winner: "local" | "remote"` 这种方向性字段，导致「交换两边后结果不同」的假阳性。真正的收敛性只要求**值集合 + 冲突集合（忽略方向）**一致。这个区分对实现冲突 UI 很重要：方向只影响展示文案，不该影响数据。

## 5. 与现有代码的接入点

| 文件 | 改动 |
|---|---|
| `packages/app/src/main/paths.ts` | 新增 `syncRoot()`、`syncIndexFile()` |
| `packages/app/src/main/library.ts` | `library:import` / `library:remove` 后标记 dirty；`library:list` 合并远端条目（未下载原书的书也显示出来，标「云端」） |
| `packages/app/src/main/doc-state.ts` | 标注保存时补 `updatedAt` + `deviceId`；位置保存补 `positionUpdatedAt` + `positionDevice`；写盘后 `markDirty(docId)` |
| `packages/app/src/main/conversations.ts`、`transcript.ts` | 追加/编辑后 `markDirty`（截断不用改，基线合并能处理） |
| 新增 `packages/app/src/main/sync/` | `backend.ts`（接口）、`engine.ts`（pull/merge/push/队列/限流/写后回读）、`merge3.ts`（书库记录级合并，纯函数）、`settings-state.ts`（设置净化 + key 级合并 + 回写，见 §4.8）、`config.ts`（同步后端凭据，不进同步体）、`base.ts`（基线快照）、`crypto.ts`、`backends/{local-folder,webdav,gist,s3,gdrive,onedrive}.ts` |
| `packages/app/src/main/index.ts`、`preload/index.ts` | IPC：`sync:status`、`sync:now`、`sync:configure`、`sync:test`、`sync:conflicts`、`sync:resolve` |
| `packages/app/src/renderer/components/Settings.tsx` | 同步分区：选后端 → 凭据表单 → 测试连接 → 加密开关 → 立即同步 |
| `packages/app/src/renderer/components/shell/StatusBar.tsx` | 同步状态图标（同步中 / 有冲突 / 离线 / 已是最新） |

测试策略：`merge3.ts` 做成纯函数，用 `node:test` 做两组性质测试——**收敛性**（随机 `base`，两侧各自演化后合并，断言结果与拉取顺序无关、且单侧变更必然被采纳）和**冲突识别**（断言「只有两边都改才报冲突」）。这比枚举用例可靠得多，也契合仓库现有的 `node --experimental-strip-types --test` 风格。现成的起点是 [`docs/research/sync-merge-prototype.ts`](research/sync-merge-prototype.ts)，它的随机化骨架可以直接改成三方版本。

## 6. 里程碑

| 里程碑 | 内容 | 交付判定 |
|---|---|---|
| **M0.5 设置同步** | 后端接口 + 本地文件夹后端 + `settings-state.ts`（净化 + key 级三方）+ 手动同步 + 设置页「同步」分区 | 两个目录模拟两台机器：A 改 `ocrLang`、B 改 `ttsEngine` 后互相同步都生效；`auth.json`/`ttsSherpaModelDir` 不出现在同步体里；新机器首同步不覆盖云端（§4.9 的 P1–P8 转成 `node:test`） |
| **M1 地基** | 本地文件夹后端补齐书库路径 + `merge3`（记录级三方）+ 兜底全序键 + 状态栏 | 两个本地目录模拟两台设备，交叉操作后能收敛；单侧变更自动合并、双侧变更被识别；单元测试覆盖合并规则 |
| **M2 WebDAV** | WebDAV 后端 + 令牌桶 + 写后回读 + 队列断点 + 坚果云实测 | 两台机器经坚果云同步笔记；50 本书一次同步请求数 < 20；限流下不报错；并发写入不互相覆盖 |
| **M3 原书** | 可选 L2 同步 + 大小上限 + 下载后 hash 校验 + 分片上传 | 新设备能从云端拉回整本书并正常阅读、标注位置恢复 |
| **M4 GitHub Gist / S3** | Gist 后端（PAT → Device Flow，一次 `PATCH` 批量更新）+ S3 兼容（R2/B2） | 一次同步 2 个请求；>1MB 的对话文件被分片或被明确拒绝；gist 重建（用户误删）能恢复 |
| **M5 加密 + 商业网盘** | E2E 加密、Google Drive（`drive.file`）、OneDrive（AppFolder） | 密文在云端可读性为零；Drive 后端仅需 loopback 授权即可用 |

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 坚果云 600 请求/30min 被写操作打爆 | 诚实说明成本；三个免费空间里它的服务条款也最敏感。默认关、文档里明确「这是可选功能，不承诺无限容量」 |
| git 历史膨胀（仅仓库路线） | 首选 Gist（不产生 git 历史压力）；确需仓库只用于原书，且一次同步一个 commit |
| 大文件同步中断 | 分片 + 断点；manifest 里记录已完成分片；下载后 hash 校验 |
| 换机后 `docId` 对不上 | 不会发生：`docId` 是内容 hash。但**必须同步原书**才能让新设备有这本书，所以 M3 不是可选项 |
| 用户误以为「有云同步 = 有备份」 | 提供「导出整个 library 为 zip」+ 远端保留最近 7 天状态快照；设置页写清「同步的是阅读进度与笔记，不是备份」 |
| 认证凭据泄露 | 一律走 `safeStorage`（已有先例：`ai-auth.ts` 的 API key）；OAuth 用 PKCE，不落 client secret |
| 设置同步把凭据/permission 决策扩散到所有机器 | 净化规则按「值」而非只按「key 名」判断（§4.5）；`skills-trust.json`、权限「always」、`auth.json`、`sync/config.json` 一律不进同步体 |
| 「掩码后再上传」覆盖对方真值 | 明确规则：敏感项**剔除**，绝不打码推送（原型 `demoMaskingIsWrong()` 是可执行反例） |
| `models.json` 注释丢失 | 默认不同步；显式打开时整文件搬运并在 UI 里警告；长期把可编辑部分迁到 `models.local.json` |
| 设置冲突太吵（每台机器都弹窗） | 只有「双方都改同一个 key」才弹；其余静默合并；冲突默认不动本机值，可「全部保留本机」一键消掉 |

## 8. 待实测清单

上线前必须逐项验证，不能假设：

1. 坚果云是否返回 `ETag`、`PROPFIND` 是否支持 `Depth: 1` 全量列举（决定 §3.3 的「一次拉清单」是否成立）。
2. 坚果云 `MOVE` 是否可用于分片拼装；`PUT` 的 500MB 限制在 WebDAV 下是否同样生效。
3. 坚果云免费版 600 请求/30min 的计数口径（是否含 `PROPFIND`、是否按 IP 还是账号）。
4. InfiniCLOUD 新认证体系下 WebDAV 的准确 endpoint 与 app password 生成路径。
5. Gist：`PATCH /gists/{id}` 单次能带多少文件、单文件内容上限是多少（1MB 是**读取**截断，写入上限未经文档确认）；同一 `PATCH` 内多文件是否原子生效。
6. Gist 的 `updated_at` 能否作为「远端变了」的比较依据；`/gists/{id}/commits` 是否能用来做「误删恢复」。
7. GitHub Git Trees API 单次 tree 的条目上限，以及 `update ref` 的 `force:false` 是否能作为乐观并发。
8. Google Drive `drive.file` 下 `files.list` 能否按 `appProperties` 过滤（决定要不要本地记 fileId 映射）。
9. macOS iCloud Drive 目录被「优化存储空间」驱逐后，Node 读到的是 `.icloud` 占位文件还是阻塞下载——直接影响「本地文件夹」后端的可靠性判断。
10. 坚果云写入后立刻 `GET` 回读，是否可能读到旧内容（缓存/一致性延迟），决定 §3.4.3 的回读校验要不要加短暂等待。
11. `safeStorage` 的密文在同机不同用户、同用户不同机器上的解密行为——用来确认 `ai-auth.ts` 的 `decrypt()` 静默回退会不会把 base64 当明文 key 送出去（这关系到是否要给 `auth.json` 加一个「本机」标记）。
12. Electron 主进程写 `settings.json` 时，渲染进程是否可能同时读旧值（`settings:get` 无缓存，风险低但要在真机上确认一次）。
13. Google OAuth 应用从 *Testing* 发布到 *Production* 后，`drive.file` 是否确实无需人工审核即可对任意 Google 账号授权（并确认 refresh token 不再 7 天过期）。
14. OneDrive `AppFolder` 在个人账号（consumers）下的可用性，以及 `If-Match` 用 `cTag` 还是 `eTag` 做条件写更稳。

## 附录 A：协议速查

### 坚果云 WebDAV

```bash
# 应用密码在：坚果云网页端 → 账户信息 → 安全选项 → 第三方应用管理 → 添加应用密码
curl -u 'you@example.com:应用密码' -X PROPFIND \
  -H 'Depth: 1' -H 'Content-Type: application/xml' \
  --data '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>
    <d:getcontentlength/><d:getlastmodified/><d:getetag/><d:resourcetype/>
  </d:prop></d:propfind>' \
  https://dav.jianguoyun.com/dav/AgentReader/
```

### GitHub Device Flow

```bash
# 1) 申请设备码（只需 client_id）
curl -X POST https://github.com/login/device/code \
  -H 'Accept: application/json' \
  -d 'client_id=CLIENT_ID&scope=repo'

# 2) 提示用户在 https://github.com/login/device 输入 user_code（8 位、带连字符）

# 3) 按 interval 轮询；成功返回 access_token，pending 则继续等
curl -X POST https://github.com/login/oauth/access_token \
  -H 'Accept: application/json' \
  -d 'client_id=CLIENT_ID&device_code=DEVICE_CODE&grant_type=urn:ietf:params:oauth:grant-type:device_code'
```

### 一次提交推多个文件（Git Data API）

```
POST /repos/{owner}/{repo}/git/blobs            × N   （每文件一次，base64）
POST /repos/{owner}/{repo}/git/trees           × 1   （base_tree = 当前 HEAD 的 tree，列出 N 个 path）
POST /repos/{owner}/{repo}/git/commits         × 1
PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}  × 1  （force: false 做乐观并发）
```

### Gist：一次请求更新多个文件

```bash
TOKEN=ghp_xxx                                     # 只需 gist 权限
GID=0123456789abcdef

# 读：拿文件清单与 updated_at（单文件 >1MB 时 content 被截断，用 raw_url 取全文）
curl -sS -H "Authorization: Bearer $TOKEN" https://api.github.com/gists/$GID

# 写：一次 PATCH 更新/新增多个文件；把某个文件的值置 null 即删掉它
curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  https://api.github.com/gists/$GID \
  -d '{"files":{
        "manifest.json":{"content":"{...}"},
        "state|ab12cd34ef567890.json":{"content":"{...}"},
        "chats|ab12cd34ef567890|conv1.jsonl":{"content":"..."},
        "chats|deleted-conv.jsonl":null
      }}'

# 历史：可用于「误删恢复」
curl -sS -H "Authorization: Bearer $TOKEN" https://api.github.com/gists/$GID/commits
```

> 注意：Gist 没有 `If-Match`。并发保护靠「写完回读校验 + 重试」（§3.4.3），而不是服务端条件写。

### 本地目录（iCloud / OneDrive / 坚果云 客户端目录）

```bash
# 严格来说不需要任何 API：把同步根指到网盘客户端的目录即可
# macOS iCloud Drive:
~/Library/Mobile Documents/com~apple~CloudDocs/AgentReader
```

注意「优化 Mac 储存空间」会把文件驱逐成 `.icloud` 占位符，第一次打开可能阻塞在下载上（§8 待实测第 9 条）。

## 附录 B：为什么不做「服务端 + 账号」

值得记录一下这个否定结论，免得以后反复讨论。做一个官方中转服务意味着：用户数据托管责任、存储与带宽账单、隐私政策与合规、账号体系与找回密码、以及「哪天服务关了数据就没了」的信任成本。而 AgentReader 目前是纯本地应用、Apache 2.0 开源、用户数据全在自己机器上——这个属性是优点，不该为了同步功能把它换掉。用用户自己的免费空间，正好把这个优点保留下来。

## 附录 C：Google Drive / OneDrive 授权与上传速查

两家都是「回环 + PKCE」，差别只在端点和 scope。下面这段是主进程里可以直接照抄的骨架（`node:http` 起一次性监听，拿到 code 就关）。

```ts
// sync/oauth.ts —— Google / OneDrive 共用
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function authorize(opts: {
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	clientSecret?: string; // Google 安装型应用会给一个「不算秘密」的 secret，可选
	scopes: string[];
}): Promise<{ refreshToken?: string; accessToken: string; expiresAt: number }> {
	const verifier = b64url(randomBytes(32));                             // PKCE
	const challenge = b64url(createHash("sha256").update(verifier).digest());
	const state = b64url(randomBytes(16));

	// 1) 起回环监听（端口 0 = 让系统挑空闲端口），拿到 code 就关
	let port = 0;
	const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (url.searchParams.get("state") !== state) return reject(new Error("state 不匹配"));
			const c = url.searchParams.get("code");
			if (!c) return reject(new Error(url.searchParams.get("error") ?? "授权被取消"));
			res.end("授权完成，可以关闭此页面回到 AgentReader。");
			server.close();
			resolve({ code: c, redirectUri: `http://127.0.0.1:${port}/callback` });
		});
		server.listen(0, "127.0.0.1", () => {
			port = (server.address() as { port: number }).port;
			const u = new URL(opts.authorizeUrl);
			u.searchParams.set("client_id", opts.clientId);
			u.searchParams.set("redirect_uri", `http://127.0.0.1:${port}/callback`);
			u.searchParams.set("response_type", "code");
			u.searchParams.set("scope", opts.scopes.join(" "));
			u.searchParams.set("code_challenge", challenge);
			u.searchParams.set("code_challenge_method", "S256");
			u.searchParams.set("state", state);
			u.searchParams.set("access_type", "offline");   // Google：要 refresh_token 必填
			u.searchParams.set("prompt", "consent");        // Google：确保每次都发 refresh_token
			void shell.openExternal(u.toString());
		});
	});

	// 2) 换 token
	const body = new URLSearchParams({
		client_id: opts.clientId,
		code,
		code_verifier: verifier,
		grant_type: "authorization_code",
		redirect_uri: redirectUri,
	});
	if (opts.clientSecret) body.set("client_secret", opts.clientSecret);
	const res = await fetch(opts.tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	const json = (await res.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
		error_description?: string;
	};
	if (!res.ok) throw new Error(json.error_description ?? `换 token 失败：${res.status}`);
	return {
		accessToken: json.access_token,
		refreshToken: json.refresh_token,
		expiresAt: Date.now() + json.expires_in * 1000 - 60_000,
	};
}
```

```bash
# ---------- Google Drive ----------
# 只需要 drive.file（非敏感；只要应用自己创建/打开过的文件）
SCOPE="https://www.googleapis.com/auth/drive.file"

# 上传：先在同步根建一个文件夹（一次），之后用 files?uploadType=multipart 传内容
curl -sS -X POST "https://www.googleapis.com/drive/v3/files?fields=id,name" \
  -H "Authorization: Bearer $ACCESS" -H "Content-Type: application/json" \
  -d '{"name":"AgentReader","mimeType":"application/vnd.google-apps.folder"}'

# 列目录（fields 必须显式限定，否则返回体很大）
curl -sS -G "https://www.googleapis.com/drive/v3/files" \
  -H "Authorization: Bearer $ACCESS" \
  --data-urlencode "q='$FOLDER_ID' in parents and trashed=false" \
  --data-urlencode "fields=files(id,name,size,modifiedTime,md5Checksum)"

# 更新内容（带条件写，避免互相覆盖）
curl -sS -X PATCH "https://www.googleapis.com/upload/drive/v3/files/$FILE_ID?uploadType=media" \
  -H "Authorization: Bearer $ACCESS" -H "If-Match: $ETAG" \
  -H "Content-Type: application/json" --data-binary @state.json

# ---------- OneDrive ----------
# 应用文件夹：/me/drive/special/approot，scope = Files.ReadWrite.AppFolder
curl -sS "https://graph.microsoft.com/v1.0/me/drive/special/approot/children?\$select=name,size,eTag,cTag,lastModifiedDateTime" \
  -H "Authorization: Bearer $ACCESS"

curl -sS -X PUT "https://graph.microsoft.com/v1.0/me/drive/special/approot:/settings/state.json:/content" \
  -H "Authorization: Bearer $ACCESS" -H "If-Match: $CTAG" \
  -H "Content-Type: application/json" --data-binary @state.json

# 超过 4MB 走上传会话（大文件才需要，设置同步用不到）
curl -sS -X POST "https://graph.microsoft.com/v1.0/me/drive/special/approot:/books/$DOCID.pdf:/createUploadSession" \
  -H "Authorization: Bearer $ACCESS" -d '{"item":{"@microsoft.graph.conflictBehavior":"replace"}}'
```

两家的条件写都能用，但**不要因此省掉「写后回读」**：`If-Match` 只能防「基于过期版本的写」，防不住「服务端接受后又被别的客户端覆盖」这种时序问题；而回读还能顺带验证服务端没有改写内容（§3.4.3）。
