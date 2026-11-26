# 云同步实施计划 v1.0

> 生成时间：2026-11-25 | 状态：待评审 → 可开工 | 上游文档：[`sync-research.md`](sync-research.md)（调研）、[`sync-webdav-plan.md`](sync-webdav-plan.md)（WebDAV 与一条龙接入）
>
> 本计划回答：**这周开始写代码，第一行写在哪、按什么顺序、每步怎么算做完。**

---

## 0. 范围

### 0.1 本期做

| 能力 | 说明 |
|---|---|
| **WebDAV 后端** | 坚果云 / Koofr / InfiniCLOUD / Nextcloud / 群晖 / 任意 WebDAV，一套代码 |
| **本地文件夹后端** | 不做「产品功能」，而是**测试替身**：用两个本地目录模拟两台机器，让全部合并逻辑在没有网络的情况下可测 |
| **L0 设置同步** | `settings.json`（净化后）+ `custom-providers.json` + `model-overrides.json` |
| **L1 笔记同步** | 阅读位置、EPUB 章节、标注、对话（含标题与正文） |
| **L2 原书同步** | 默认关闭，按需开启；带大小预检、分片、下载后 hash 校验 |
| **连接向导** | 五步向导 + 服务预设 + 内嵌登录窗 + 剪贴板 + 错误映射 |
| **冲突与状态** | 冲突列表（逐条选边）、状态栏指示灯、请求余额 |

### 0.2 本期不做（留给 v2，但接口留位）

- GitHub Gist / S3 / Google Drive / OneDrive 后端（`SyncBackend` 注册表留空位即可加）
- 端到端加密（`crypto.ts` 留空实现 + UI 里明确写「当前未加密」）
- 服务端 / 账号体系（永远不做，见调研文档附录 B）
- 协作、共享、按书分享（不属同步）

### 0.3 硬约束（违反即返工）

1. **不改现有 IPC 语义**：只新增 channel，不改已有参数与返回值。
2. **不破坏旧数据**：`doc.json` / `annotations.json` 只加字段不删字段；缺字段按 `0`/空串处理。
3. **同步永不删除本地数据，也不会因本地删除而删云端**：冲突默认保留；删除只由「基线证明对方删了且本方没改」触发；`library:remove` 只清本地索引（§4.0-D）。
4. **凭据不进同步体**：`auth.json`、`sync/config.json`、`skills-trust.json`、权限决策一律不同步（净化规则见调研 §4.5）。
5. **仓库风格**：Biome（tab、行宽 100）、`node --experimental-strip-types --test`、主进程代码 `.ts` 扩展名导入。

---

## 1. 交付物与「做完」的定义

### 1.1 新增文件树

```
packages/app/src/main/sync/
  backend.ts            接口 + 注册表 + caps 类型
  types.ts              RemoteEntry / PutOptions / SyncError / SyncStatus
  paths.ts              {userData}/sync/ 下的所有路径
  clock.ts              deviceId + HLC（严格递增）
  config.ts             后端配置读写（凭据走 safeStorage）
  presets.ts            §服务预设表（从 research/webdav-presets.ts 搬）
  connect.ts            端点归一化 / InfiniCLOUD 反查 / 错误分类 / 向导 reducer
  sanitize.ts           设置净化（键名 + 值三重判定）
  merge-settings.ts     设置 key 级三方合并（纯函数）
  merge-records.ts      书库记录级三方合并 merge3（纯函数，从 research/sync-merge-prototype.ts 搬）
  state-io.ts           docId ↔ state 文件的序列化/反序列化 + 版本迁移
  engine.ts             pull → merge → push、队列、限流、写后回读（后端无关）
  index.ts              registerSyncIpc() + 启动调度
  backends/
    interface-guard.ts  后端一致性自检（启动时用一个假后端跑一遍契约测试）
    local-folder.ts     本地目录后端（测试替身）
    webdav.ts           WebDAV 后端
    webdav-xml.ts       PROPFIND 响应解析（手写，不引依赖）

packages/app/src/renderer/components/sync/
  SyncSection.tsx       设置页里的同步分区（三态：未连接 / 已连接 / 有冲突）
  ConnectWizard.tsx     五步向导（useReducer + connect.ts 的 reducer）
  ProviderPicker.tsx    服务卡片网格
  SyncStatusPill.tsx    状态栏指示灯 + 下拉面板
  ConflictList.tsx      冲突逐条选边
  useSyncStatus.ts      订阅 sync:status 推送的 hook
```

### 1.2 测试文件（要加进 `package.json` 的 test 脚本）

```
sync/merge-settings.test.ts     ← 现成断言从 research/settings-sync-prototype.ts 迁移
sync/merge-records.test.ts      ← 现成断言从 research/sync-merge-prototype.ts 迁移
sync/connect.test.ts            ← 现成断言从 research/webdav-presets.ts 迁移
sync/sanitize.test.ts
sync/engine.test.ts             ← 用 local-folder 后端跑双实例场景
sync/webdav-xml.test.ts
```

### 1.3 每个任务「做完」的判定（Definition of Done）

一个任务只有同时满足以下五条才算完成：

1. 代码 + 单测通过（`node --experimental-strip-types --test …`）；
2. `npm run check`（Biome + typecheck）无 error、无 warning；
3. 新增 IPC 在 `preload/index.ts` 有对应方法，且 `renderer/main.tsx` 的类型声明同步更新；
4. 相关文档（本文件对应任务行 / 上游设计文档）同步更新，不留「待补」；
5. 手动验证路径写进 PR 描述（截图或命令）。

---

## 2. 架构定稿

### 2.1 数据流

```
渲染进程改动
   │ IPC（settings:save / doc:annotations:save / reading:save / chat:append …）
   ▼
主进程写盘 ──→ markDirty("settings") / markDirty(docId)   ← 新增的唯一钩子
                    │
                    ▼  去抖（settings 5s / 书库 20s）
              engine.flush()
                    │
        ① pull：GET manifest → 比对 rev → GET 需要的文件
        ② merge：settings → mergeSettings；书库 → merge3
        ③ 落盘：写本地（先备份到 sync/history/）
        ④ base 推进：只有 pull 成功才推进
        ⑤ push：PUT + 写后回读 GET（校验后被改则重试，上限 3 次）
        ⑥ manifest 最后写
```

**唯一入口原则**：所有「会改变同步数据」的写盘动作都必须经过 `markDirty`。全量审计结果见 **§4.0**（13 处需要接钩子：设置层 3 + 书库层 10；另有 7 处明确不接），在 P1 / P3 分别接线。

### 2.2 后端接口（最终签名）

```ts
// sync/backend.ts
export type RemoteEntry = { path: string; size: number; mtime?: number; etag?: string; isDir?: boolean };

export type PutOptions = { ifMatch?: string; ifNoneMatch?: boolean };

export type BackendCaps = {
  conditionalWrite: boolean;   // 支持 If-Match
  maxObjectSize: number;       // 单文件上限（决定原书能不能传）
  requestBudgetPerMinute: number;
  paginatedListLimit: number;  // 列目录一次最多返回多少项（坚果云 750）
};

export interface SyncBackend {
  readonly id: string;
  readonly label: string;
  readonly caps: BackendCaps;
  /** 连通性自检；向导的「连接」按钮就是调它。返回配额用于界面展示。 */
  test(): Promise<{ ok: true; freeBytes?: number } | { ok: false; error: SyncError }>;
  /** 列目录；实现负责分页，把父集合展开到同一层（我们只需要两层：根 + 已知子目录）。 */
  list(prefix: string): Promise<RemoteEntry[]>;
  get(path: string): Promise<Buffer | null>;
  put(path: string, data: Buffer, opts?: PutOptions): Promise<{ etag?: string }>;
  del(path: string): Promise<void>;
  /** 建目录（幂等：已存在不报错）。 */
  mkdir(path: string): Promise<void>;
  /** 可选：分片拼装；不支持时上层退化为「整传」。 */
  move?(from: string, to: string): Promise<void>;
}

export class SyncError extends Error {
  constructor(
    readonly code: FailureCode,      // connect.ts 的那套码
    readonly status: number | "network" | "tls",
    readonly retryable: boolean,
    message: string,
  ) { super(message); }
}
```

**抽象层的验收标准**：`engine.ts` 里出现 `id === "webdav"` 即视为失败（CI 里加一句 grep 检查）。

### 2.3 磁盘布局

```
{userData}/sync/
  config.json          ← { backendId, endpoint, account, scope:{settings,notes,books}, rootName, deviceId }
  secrets.json         ← safeStorage 加密的密码/PAT/OAuth token（从不进同步体）
  index.json           ← { settingsRev, docs: { [docId]: { rev, remoteSize } } }
  base/
    settings.json      ← 设置基线快照
    {docId}.json       ← 书库状态基线
  queue.json           ← 待推送项（崩溃可续）
  history/
    settings/{ts}.json
    {docId}/{ts}.json  ← 每次落盘前的本地旧值，保留最近 10 份，用于「回滚」
```

### 2.4 远端布局（v1 定稿）

```
AgentReader/
  manifest.json              ← 全库索引 + 设置 rev（最后写）
  settings/state.json        ← L0 设置（净化后）
  state/{docId}.json         ← L1 一本书的全部状态（含对话正文）
  books/{docId}.{ext}        ← L2 原书（可选）
```

**关键决定：对话正文内联进 `state/{docId}.json`，不再拆 `chats/*.jsonl`。**

- 理由：每本书一次 `GET`/`PUT` 就把「位置 + 标注 + 对话」全拿到，请求数从「1 + N」降到「1」；坚果云 600/30min 的余量更大。
- 代价：单文件变大。设 **1MB 软上限**：超过时该书的对话仍内联，但压缩策略退化为「只同步最近 200 条消息 + 对话索引」，并在 UI 里标注；>8MB 直接拒绝同步该书（提示过大）。这条与 Gist 的 1MB 读取截断也天然兼容，将来加 Gist 后端不用改布局。
- 逃生舱：`state/{docId}.json` 带 `schema` 字段，v2 若要拆文件，按 schema 迁移即可。

`state/{docId}.json` 形状：

```jsonc
{
  "schema": 1,
  "docId": "ab12cd34ef567890",
  "rev": 17,
  "meta": { "title": "…", "ext": "pdf", "lastPage": 42, "lastLocation": null,
            "positionUpdatedAt": 1764112345678, "positionDevice": "ab12cd34" },
  "chapter": 12,
  "annotations": [ { "id": "…", "type": "highlight", "page": 42, "text": "…",
                     "updatedAt": 1764112345678, "deviceId": "ab12cd34" } ],
  "conversations": [ { "id": "…", "title": "默认对话", "createdAt": 0, "updatedAt": 0 } ],
  "chats": { "<convId>": [ /* 消息行，含 id + timestamp */ ] }
}
```

### 2.5 引擎状态机

```
idle ──flush()──→ pulling ──→ merging ──→ pushing ──→ verifying ──→ idle
                    │            │            │            │
                    └────────────┴────────────┴────────────┴──→ error(retryable?)
                                                                    │
                                              conflict? ──→ needs-attention
```

对外暴露（`sync:status` 推送 + 拉取）：

```ts
type SyncStatus = {
  state: "idle" | "pulling" | "merging" | "pushing" | "verifying" | "error" | "needs-attention" | "offline";
  backend?: { id: string; label: string; endpoint: string };
  lastSyncAt?: number;
  lastError?: { code: FailureCode; title: string; detail: string; retryable: boolean };
  requestCount30m: number;     // 坚果云 600 的口径提示
  pending: { settings: boolean; docs: string[] };
  conflicts: Array<{ kind: "settings" | "doc" | "file"; key: string; docId?: string }>;
};
```

---

## 3. 任务分解

> 估时按「一个人、熟悉此仓库」计。依赖用 `→` 表示。每个任务都能单独发一个 PR。

### P0 地基（S-01 ~ S-05，约 1.5 天）

| ID | 任务 | 文件 | 要点 | 验收 |
|---|---|---|---|---|
| **S-01** | 路径与配置存储 | `sync/paths.ts`、`sync/config.ts` | `syncRoot()` 惰性求值（照 `paths.ts` 的注释：`app.getPath` 必须在 `setupAppIdentity` 之后取）；`config.json` 明文存非敏感字段，密码/PAT 走 `safeStorage` 存 `secrets.json` | 单测：写入后读回、`secrets.json` 落盘内容不含明文密码 |
| **S-02** | 后端接口 + 注册表 | `sync/backend.ts`、`sync/types.ts` | `SyncBackend`、`SyncError`、`caps`；注册表 `registerBackend/ getBackend`；**接口一致性自检**：用一个内存假后端跑一遍契约断言，保证任何新后端实现都满足「get 不存在返回 null、put 幂等、list 返回的 path 不含前导 `/`」 | 契约测试对 `local-folder` 与 `webdav` 都跑通 |
| **S-03** | 本地文件夹后端 | `sync/backends/local-folder.ts` | 把远端根映射到一个目录；`put` 用「写临时文件 + rename」保证原子；`list` 用 `readdir` 递归 2 层；`etag` 用文件 `mtime+size` 拼 | 双实例场景测试的基础（S-07 用） |
| **S-04** | 时钟与设备标识 | `sync/clock.ts` | `deviceId`（首次启动生成 UUID，存 `config.json`）；`nextTs()` 严格递增 HLC；**跨进程重启后不能倒退**（启动时 `lastTs = max(persisted, Date.now())`） | 单测：1000 次调用严格递增；模拟「时钟回拨」后仍递增 |
| **S-05** | 测试脚手架 | `package.json` 的 test 脚本 | 把四个纯函数测试文件加进脚本；保证 `npm test --workspace=@agentreader/app` 全绿 | CI 命令本地跑通 |

**P0 的产出物是「没有 UI、但可测」的一层。**

### P1 设置同步闭环（S-06 ~ S-10，约 2 天）

| ID | 任务 | 文件 | 要点 | 验收 |
|---|---|---|---|---|
| **S-06** | 净化 + 设置合并 | `sync/sanitize.ts`、`sync/merge-settings.ts` | 直接搬 `research/settings-sync-prototype.ts`（P1–P8 断言变成 `node:test`）；`applyRemote()` 的**关键顺序**：读原始 settings → 覆盖可同步 key → 保留本机专属 key → 写盘 | 单测：`ttsSherpaModelDir`、`apiKey`、`webSearchApiKey` 不出现在同步体；`applyRemote` 后本机专属 key 仍在 |
| **S-07** | 引擎骨架（后端无关） | `sync/engine.ts` | `pull/merge/push/verify` + 队列持久化 `queue.json` + 令牌桶 + 去抖；先只处理 settings，书库留 `TODO` 分支但接口先定 | 双本地目录：A 改设置 → B 拉到；B 改另一 key → A 拉到且互不覆盖 |
| **S-08** | 设置写盘打点 | `main/settings.ts`、`main/ai-config.ts` | 新增 `readRawSettings()` / `writeRawSettings()`；按 **§4.0-A** 的 3 处接线；确认没有绕过 `updateSettings` 的直接写 | 手改 UI 任意设置项 → `sync:status.pending.settings === true`；5s 后变 false；改自定义提供商 / 模型上下文也触发 |
| **S-09** | IPC + preload | `sync/index.ts`、`preload/index.ts`、`renderer/main.tsx` | `sync:presets` / `sync:configure` / `sync:test` / `sync:now` / `sync:status` / `onSyncStatus`；preload 用 `onTtsModelProgress` 的同款写法（返回取消函数） | 渲染进程能拿到推送；`window.api` 类型声明无 `any` |
| **S-10** | 设置页「同步」分区（未连接态） | `components/sync/SyncSection.tsx`、`Settings.tsx` | 在 `SECTION_GROUPS` 的「使用」组后新增 `{ id: "sync", label: "同步" }`；未连接时只显示一张卡 + 「开始配置」按钮 | 打开设置 → 看到「同步」；点按钮进入占位向导 |

**P1 结束时：两个本地文件夹能同步设置。这是整个功能的最小可用闭环。**

### P2 WebDAV 真机（S-11 ~ S-15，约 3 天）

| ID | 任务 | 文件 | 要点 | 验收 |
|---|---|---|---|---|
| **S-11** | WebDAV 基础动作 | `sync/backends/webdav.ts`、`webdav-xml.ts` | preemptive Basic（带 `Authorization` 首包，不等 401 挑战）；`PROPFIND Depth:1` 只请求四个属性；`MKCOL` 逐级；路径按段 `encodeURIComponent`；超时 15s / 上传 60s | 对坚果云与 Koofr 各跑一遍「连上去 → 建目录 → 传一个小文件 → 读回一致 → 删掉」 |
| **S-12** | 错误语义 + 限流 | `webdav.ts`、`connect.ts` | 状态码 → `SyncError`，**`retryable` 必须驱动引擎**（Koofr 429 锁号时立即停，不重试）；令牌桶 20/min（坚果云）；429 读 `Retry-After` | 单测：Koofr 预设下 429 让引擎进入 `error` 且不再发起请求 |
| **S-13** | 写后回读 + 412 重试 | `engine.ts` | `PUT` → `GET` 校验；不一致或 412 → 重新 `pull` → 重合并 → 重试（≤3 次）→ 仍失败进 `needs-attention` | 双目录模拟「两台同时写同一文件」：最终双方内容一致且无静默丢失 |
| **S-14** | 连接向导 | `ConnectWizard.tsx`、`ProviderPicker.tsx`、`connect.ts` | 五步 + `reduceWizard`（搬原型）；内嵌登录窗（独立 partition、关闭即 `clearStorageData`、导航白名单）；剪贴板只在点击时读一次 | 用一个没配过 WebDAV 的人做可用性测试：坚果云 3 分钟内连上 |
| **S-15** | InfiniCLOUD 端点反查 | `connect.ts`、`SyncSection.tsx` | 申请 API KEY 并内置；`GET /v2/api/ba/user` 反查 `webdav_url`；**key 拿不到时自动回退成手填 URL**（`endpointProbe` 缺失即回退路径） | 只填账号 + 应用密码能连上；把 key 清空后仍能用 |

### P3 书库同步（S-16 ~ S-19，约 3 天）

| ID | 任务 | 文件 | 要点 | 验收 |
|---|---|---|---|---|
| **S-16** | 书库写盘打点 + 状态序列化 | `doc-state.ts`、`conversations.ts`、`chat.ts`、`library.ts`、`sync/state-io.ts` | 按 **§4.0-B** 的 10 处接线（含 `chat.ts:306` 那条直接 append 的助手回复）；标注补 `updatedAt`/`deviceId`（旧数据缺省 `0`）；位置补 `positionUpdatedAt`/`positionDevice`（**不复用 `importedAt`**）；`library:remove` 按 §4.0-D 只移除本地索引 | 改标注/翻页/发消息/编辑消息后 20s 内 `pending.docs` 含该 docId；`doc.json` 里新增字段不破坏 `reading:get`；删书后云端 `state/` 仍在 |
| **S-17** | 记录级三方合并 | `sync/merge-records.ts` | 搬 `research/sync-merge-prototype.ts`（收敛/幂等/删除守卫/冲突识别）；标注按 `id`；对话按 `id` 求并集；位置与章节走单值 + 全序键 | 单测全绿；两机交叉改标注 → 零冲突合并；同一条标注两边改 → 报冲突且结果与顺序无关 |
| **S-18** | 冲突 UI | `ConflictList.tsx` | 逐条：键名（人类可读，如「OCR 语言」「《xxx》第 42 页高亮」）+ 两侧值 + 「保留本机 / 采用远端」；支持「全部保留本机」 | 手工制造冲突后能从 UI 消掉，且之后不再重复报同一条 |
| **S-19** | 状态栏 | `SyncStatusPill.tsx`、`StatusBar.tsx` | 在 `StatusBar` 右侧加一颗灯：`idle` 灰 / `syncing` 转 / `error` 红 / `needs-attention` 橙；点击展开面板（最后同步时间、错误详情、立即同步、请求余额） | 拔网线重连后灯色正确变化；面板数字与实际请求数一致 |

### P4 原书（S-20 ~ S-21，约 2 天）

| ID | 任务 | 文件 | 要点 | 验收 |
|---|---|---|---|---|
| **S-20** | 原书上传/下载 | `engine.ts`、`webdav.ts` | 上传前查 `caps.maxObjectSize`；超过则**只同步笔记**并提示；>32MB 走分片（`tmp/{docId}.part.{n}` + `MOVE` 拼装，不支持 `MOVE` 则整传并给进度）；下载后 `sha256(content).slice(0,16) === docId` 校验，不匹配即丢弃 | 新设备拉回整本书并恢复到上次阅读位置；篡改远端文件后下载被拒绝 |
| **S-21** | 云端书条目 | `library.ts`、`SideBar.tsx` | `library:list` 合并远端 manifest 条目：本地没有原书的书也显示，标「云端」徽标，点击时先下载再打开 | 列表里能看到未下载的书，点击有进度并可打开 |

### P5 打磨与发布（S-22 ~ S-24，约 2 天）

| ID | 任务 | 要点 |
|---|---|---|
| **S-22** | 回滚与导出 | `sync/history/` 保留最近 10 份快照，「设置 → 同步 → 高级」提供「回滚到上一个版本」；`导出整个 library 为 zip` |
| **S-23** | 全链路文案与降级 | 空态、离线、限流、锁号、配额满、证书错误各有专属文案；**明确写「同步不是备份」**；首次开启时弹一次范围说明 |
| **S-24** | 打包与文档 | macOS `package:dir` 冒烟 + Windows 构建；README / `docs/` 更新；特性开关 `syncEnabled` 默认 `false`（beta） |

---

## 4. 关键实现细节（按翻车概率排序）

### 4.0 写盘审计（实施前已核对，照此接线）

> 用 `grep -rn "writeFileSync\|appendFileSync\|rmSync\|unlinkSync" packages/app/src/main` 逐处核对得出。**这张表就是 S-08 / S-16 的验收清单**，漏一处就是「某个字段改了但永不触发同步」。

**A. 设置层（L0）—— P1，需接钩子（3 处）**

| 位置 | 写的是什么 | 钩子 |
|---|---|---|
| `settings.ts:49` `updateSettings()` | `settings.json` | `markSettingsDirty()` |
| `ai-config.ts:134` `writeCustomProviders()` | `custom-providers.json` | `markSettingsDirty("files")` |
| `ai-config.ts:185` `setModelOverride()/clearModelOverride()` | `model-overrides.json` | `markSettingsDirty("files")` |

**B. 书库层（L1）—— P3，需接钩子（10 处）**

| 位置 | 写的是什么 | 钩子 |
|---|---|---|
| `library.ts:52` `library:import` | `doc.json`（新建书） | `markDirty(docId)` + 通知 manifest 新增条目 |
| `doc-state.ts:21` `doc:annotations:save` | `annotations.json` | `markDirty(docId)`；**同时补 `updatedAt` / `deviceId`** |
| `doc-state.ts:58` `doc:chapter:set` | `reader-chapter.json` | `markDirty(docId)` |
| `doc-state.ts:84` `reading:save` | `doc.json` 的 `lastPage`/`lastLocation` | `markDirty(docId)`；**同时补 `positionUpdatedAt`/`positionDevice`** |
| `conversations.ts:31/32/43/50` `ensureConversations` / `saveConversations` | `conversations.json` | `markDirty(docId)` |
| `conversations.ts:62` `chat:append` | `chats/{convId}.jsonl` 追加 | `markDirty(docId)` |
| `conversations.ts:84` `conversations:create` | 新建空对话文件 + 索引 | `markDirty(docId)` |
| `conversations.ts:92` `conversations:delete` | 删对话文件 + 索引 | `markDirty(docId)` |
| `conversations.ts:139` `chat:edit` → `transcript.ts:19` | 重写 JSONL（编辑/截断） | `markDirty(docId)`（在 `chat:edit` 的 handler 里接） |
| `chat.ts:306` `persistAssistant()` | **直接 `appendFileSync` 写助手回复** | `markDirty(docId)` ← 最容易漏的一处：它绕过了 `conversations.ts` |

**C. 明确不接（7 处，附理由）**

| 位置 | 为何不同步 |
|---|---|
| `ai-auth.ts:23` `auth.json` | 凭据，且 `safeStorage` 密文不可跨机器（调研 §4.6） |
| `ai-config.ts:35/43` `models.json` | JSONC 带注释、用户手写，整份同步会丢注释（调研 §4.5） |
| `ai-config.ts:86` `models-cache.json` | 缓存，可重建 |
| `ai-config.ts:258` `model-metadata.json` | 缓存，14 天自动刷新 |
| `skills.ts:239` `skills-trust.json` | 安全决策，绝不能跨机器放大授权 |
| `doc-text.ts:213` OCR 结果 | L3 缓存，体积大且可重建 |
| `skills.ts:110/117/150/181` 技能安装目录 | 技能本体是「安装的应用」，不是「用户数据」，本期不纳入 |

**D. 两份待定（本期不钩，记录决策）**

| 位置 | 决策 |
|---|---|
| `skills.ts:213` `docDir/skills.json`（每本书启用了哪些技能） | 语义上属于 L1，但技能名在另一台机器可能不存在。**本期不钩**；v2 若同步，冲突时按「双方并集 ∩ 本机已安装技能」处理 |
| `library.ts:63` `library:remove`（删书） | **删除本地书不删云端数据**。只从本地 `sync/index.json` 移除条目，云端 `state/{docId}.json` 保留——这样误删后重新导入同一文件（`docId` 是内容 hash，必然一致）能直接把笔记续上。这条同时满足 §0.3 的「同步永不删除本地数据」的反向版本：**同步也永不删除云端数据** |

### 4.0.1 实施中定下来的三个语义（写代码时才暴露，已用测试固定）

**① 「应用到本机」以「完整状态」为准，不依赖墓碑。**

第一版 `applyMergedSettings` 只按墓碑删 key，结果：远端删掉某项设置、而删除方没有留下墓碑时，本机永远删不掉——用户看到「另一台删了，这台还在」。`engine.test.ts` 的「a deletion propagates」用例把它抓住了。

修正：`merged` 是一份完整状态，**同步 key 只要不在 `merged.values` 里就等于应删除**；墓碑只服务远端那一侧（用于判断「另一侧是不是删过」）。本机专属 key 永远不参与这个判断。

**② 首次同步（无基线）默认采用远端，向导提供一次性的「以本机为准」。**

场景：用户在 B 机器上已经配过设置，之后才启用同步，而云端已经有 A 推上去的配置。此时「谁的戳更新」是错的判据——两台机器的时钟无从比较，结果会随拉取方向变化（调研 §3.4.2 警告的同一类问题）。

定死为 **acceptRemote**：无基线且两侧都有值且不同 → 取远端，本机值原样留在冲突记录里（可回退）。理由与 VSCode 一致：云端是**共享物**，本机是**单点**；静默覆盖共享物会影响所有设备，而本机的偏好用户在设置页一眼能改回来。

向导在检测到「云端已有设置 + 本机也有非默认设置」时多问一句：**以云端为准 / 以本机为准**。选后者就是一次性把本机值覆盖上去，然后把这次结果作为基线——不是一种合并模式，避免引擎里多一条分支。

**③ 冲突的收敛发生在下一轮，不是「同时」。**

双方同时改同一个 key 时，两边的第一次 `sync()` 各自裁决（全序键取大），胜者被推上云端；输的一方要等**下一次** pull 才会接受胜者的值。所以界面上不能写「已解决」就完事，要写「将在下次同步生效」，否则用户会看到两台机器短暂不一致而以为有 bug。`engine.test.ts` 的 S3 用例断言的就是「第二轮收敛」。

### 4.1 `applyRemote()` 绝不能整体落盘

```ts
// 错误写法：把合并结果直接写回 settings.json → 会删掉 ttsSherpaModelDir / apiKey
writeFileSync(settingsPath(), JSON.stringify(merged.values));

// 正确写法：读原始 → 覆盖可同步 key → 本机专属 key 原样保留
const raw = readRawSettings();                  // 含本机专属 key
const next = { ...raw };
for (const [k, v] of Object.entries(merged.values)) next[k] = v;   // 只覆盖净化白名单内的
writeRawSettings(next);
```

同理，`doc.json` 的同步只覆盖同步字段（`lastPage` / `lastLocation` / `title`），**不要整份替换**——本地还有 `importedAt`、`originalPath` 这些机器相关字段。

### 4.1.1 与计划的一处偏离：用「目录清单」替代 `manifest.json`

计划 §3.2 里远端有一份 `manifest.json` 充当索引。实施时改成了**直接 `list("state")`**：

- 一次 `PROPFIND` / `readdir` 就能拿到所有 `state/{docId}.json` 的 `etag` 与大小，请求数和读 manifest 一样是 1；
- 少一个「可能落后」的状态源：manifest 与真实文件不一致时的那套自愈逻辑（计划 §4.3）直接不需要了；
- 代价是拿不到「标题/体积」这类聚合信息——但那些字段每本书的 state 文件里都有，界面按需读取即可。

`index.json` 只保留「每本书上次看到的 `rev` 与 `etag`」，用于跳过没变化的书（省 GET）。

### 4.1.2 原书的云端文件名

远端原书是 `books/{书名} [{docId}].{ext}`，而不是 `books/{docId}.{ext}`。

- **为什么带 docId**：它是内容 hash，是「两台设备不靠服务端也能对上同一本书」的唯一依据；纯书名无法保证唯一，改名/重导入也会失配。
- **为什么带书名**：云端是用户自己的网盘，`ab12cd34ef567890.pdf` 这种名字在网页端完全没法认。
- **书名从哪来**：`getDocTitle()`（`doc-text.ts`）只读元数据 —— EPUB 解 `container.xml → OPF` 的 `dc:title`，PDF 读 Info 字典的 `Title`（不用 Producer/Creator，那记的是排版软件），拿不到才退回本地文件名。**不**复用 `getDocText()`，因为它会把整本正文抽出来。
- **兼容与迁移**：`docIdFromBookName()` 同时解析 `书名 [hash].ext` 与旧版的 `hash.ext`；再次上传同名书时，若云端还是旧名字会自动写成新名字并删掉旧文件。
- **清理规则**：去掉控制字符、路径分隔符与 Windows 非法字符（`\ / : * ? " < > |`）、折叠空白、去掉首尾的点与空格、限长 80 字；清理后为空则退回 `docId`。

### 4.1.3 删除的语义（一次真事故的修正）

这一版之前，「删除」实际上只是「删本地目录」：云端原书与笔记原封不动，于是书架把云端那份当成合法的「云端书」又画出来，用户看到的是「删了又回来」，去网盘客户端一看文件还在。同一轮里还有两个附带缺陷：下载回来的书用 `docId` 当标题（设置页显示成一串 hash）、以及云端同一本书存在两份文件时（旧 hash 名 + 新书名）书架会画成两本。

现在的规则：

| 用户意图 | 行为 |
|---|---|
| **删除本地与云端**（默认主按钮） | 云端原书 + 云端笔记状态 + 本地目录 + 本地基线 + 索引条目 |
| **仅移除此设备上的文件** | 只删本地目录与基线；云端保留，书在书架里变成「云端」条目（这是它本来就还在，不是复活） |

配套的三条硬规则：
1. **基线必须跟着删** —— 留着它，下次重新导入同一本书时三方合并会拿过期基线比对；
2. **云端按 docId 去重** —— 同一本书的多份文件只对外暴露一份（优先带书名的那个），上传时顺手清理旧文件；
3. **下载时标题取云端书名** —— 优先读 `state/{docId}.json` 的标题，其次用文件名里的书名，绝不用 `docId` 当标题。

删除逻辑放在 `sync/delete.ts`（纯函数 + 注入依赖），用本地目录后端做了 3 个用例；书名补偿与去重有 2 个用例。

### 4.1.4 删除的失败语义与跨设备传播

**云端删除失败时会发生什么**（实测，`deleteBook` 的顺序是「先云后本地」）：

| 场景 | 结果 |
|---|---|
| 列云端清单就失败（网络不通） | 什么都不动，报错退出 |
| 原书删成功、删笔记状态超时 | **本地不删**、基线与索引保留、抛错；云端半删（原书没了、笔记还在）；重试可收敛（幂等） |
| 服务端已删但客户端超时 | 重试时 `del` 对不存在返回成功，照样收敛 |
| 未配置同步却选「删除本地与云端」 | 直接抛错，不产生半删 |

失败时**绝不会先删本地**：宁可留下本地副本让用户重试，也不留下「本地没了、云端还在」的幽灵。

**跨设备传播（墓碑）**：光删云端不够 —— 另一台设备本地还有这本书，它下次同步会把笔记推回云端，删除被复活。所以「删除本地与云端」成功后会在云端写 `deleted/{docId}.json`（`{at, dev}`）：

- 其他设备同步时先列 `deleted/`；墓碑比本机最后一次改动（位置/章节/标注/对话的最大时间戳）更新 → 跟着删本地；
- 若用户删完之后又在某台设备上读过、标注过 → **保留本地并主动撤掉云端墓碑**，避免被反复删除；
- 墓碑最后写：只有云端三项（原书、笔记、以及墓碑自身）都成功才宣告删除，半途失败不写，其他设备不会误删。

代价：每轮同步多一次 `list("deleted")` 请求（预算测试已从 2 → 3）。

### 4.2 基线只在 pull 成功后推进

`base/{docId}.json` 是三方合并的地基。推进时机错了，整套合并就退化成「覆盖式同步」。

```
pull 成功 → merge → 写本地 → **成功写盘之后**才 base = merged
push 成功 → base = pushed   （push 前必然先 pull，此时 base 已是最新）
任何一步失败 → base 不动，下次重来
```

### 4.3 manifest 最后写

中途崩溃最多导致「manifest 落后于远端实际内容」。恢复策略：`pull` 时若 discover 到 `state/{docId}.json` 的 `rev` 大于 manifest 里记录的值，就把 manifest 修正过来。这条兜底必须有，否则一次崩溃会让某本书永远不同步。

### 4.4 队列持久化

`queue.json` 存 `{ settings: bool, docs: string[], retry: { [key]: { attempts, nextAt } } }`。崩溃重启后继续；`attempts > 6` 进 `needs-attention` 并停止自动重试（避免把 429 打成封号）。

### 4.5 令牌桶按后端 caps 配置

坚果云 20/min（600/30min 的 1/30）、其他 60/min。**桶在「发请求的地方」而不是「业务逻辑里」**——把它做进 `webdav.ts` 的 `fetch` 包装，这样任何新增调用都自动受限。

### 4.6 单实例与并发写

应用本身是单实例（`index.ts` 已有 `second-instance` 处理），所以同机不会有两个实例同时推。**跨机器没锁**，靠 §4.3 的回读 + 412 重试兜住，这一点不改（服务端条件写不保证，见调研 §3.4.3）。

### 4.7 本地文件夹后端的 iCloud 陷阱

若用户把同步根指到 iCloud Drive，被「优化存储空间」驱逐的文件是 `.icloud` 占位符。`list` 里遇到 `.icloud` 后缀要当「不存在」处理，读取时提示用户先下载。这是 S-03 的一个必测分支。

---

## 5. 测试计划

### 5.1 单元测试（纯函数，快、可 fuzz）

| 文件 | 覆盖 |
|---|---|
| `merge-settings.test.ts` | 单侧变更、收敛性（≥3000 轮随机）、幂等、删除语义、首装不覆盖、净化不泄露 |
| `merge-records.test.ts` | 标注/对话并集、位置单值裁决、删除守卫、冲突识别 |
| `connect.test.ts` | 端点归一化（含 Koofr 大小写）、预设必填字段、InfiniCLOUD 反查解析、错误分类 + `retryable`、向导状态机 |
| `sanitize.test.ts` | 驼峰凭据词、绝对路径、URL 带 key、剔除而非掩码 |
| `webdav-xml.test.ts` | 正常 `multistatus`、带命名空间前缀、空目录、坏 XML、750 项截断 |
| `clock.test.ts` | 严格递增、时钟回拨、重启后不倒退 |

### 5.2 集成测试（local-folder 双实例，无网络）

写一个 `engine.test.ts`，用两个临时目录当两台机器：

| 场景 | 断言 |
|---|---|
| S1 单向 | A 改设置 → B pull → B 得到 |
| S2 双向不同 key | A 改「OCR 语言」、B 改「TTS 引擎」→ 双方都得到两项改动 |
| S3 同 key 竞争 | 双方改同一 key → 报冲突、双方最终值一致、无静默丢失 |
| S4 删除 vs 修改 | A 删、B 改 → 保留 B 的修改并报冲突 |
| S5 首装 | B 全新、云端有数据 → B 全量接受，不上传空状态覆盖 |
| S6 崩溃恢复 | push 前杀掉进程 → 重启后队列继续，不重复不丢 |
| S7 manifest 落后 | 手动破坏 manifest → pull 能自愈 |
| S8 书库全链路 | 标注 + 对话 + 位置三项同时交叉修改 → 收敛 |

### 5.3 真机自测脚本

`npm run selftest:webdav --workspace=@agentreader/app` —— 用真实账号把后端语义跑一遍（连接、契约自检、中文路径写入回读、`list` 的 ETag、`If-Match` 是否返回 412、删除幂等），并把计划 §8 的观察项打印成人能看的一行。不联网的冒烟：`--local /tmp/x`。

它刻意**不**去触发 429（那会把账号锁掉）。限流口径仍需人工确认，脚本末尾会提示。

### 5.4 真机清单（WebDAV）

坚果云 / Koofr / InfiniCLOUD 各跑一遍：连接、建目录、传文件、读回、并发双机、429、密码错、配额满、断网恢复、大文件分片。**坚果云必须测「600 次/30 分钟」的真实口径**（`PROPFIND` 是否计数）。

### 5.4 回归门槛

```
npm run check                 # Biome + typecheck（error-on-warnings）
npm test --workspace=@agentreader/app
npm run package:dir --workspace=@agentreader/app   # macOS 冒烟
grep -rn 'id === "webdav"' packages/app/src/main/sync/engine.ts  # 必须为空
```

---

## 6. 排期

| 里程碑 | 任务 | 估时 | 可演示的东西 |
|---|---|---|---|
| **M1** | P0 + P1 | 3.5 天 | 两个本地目录同步设置；单测与集成测试全绿 |
| **M2** | P2 | 3 天 | 面对坚果云/InfiniCLOUD/Koofr 的真机能连上并同步设置 |
| **M3** | P3 | 3 天 | 两台机器同步阅读进度、标注、对话；冲突能选边 |
| **M4** | P4 | 2 天 | 新设备拉回整本书并续读 |
| **M5** | P5 | 2 天 | beta 包 + 文档 + 回滚 |
| **合计** | | **约 13.5 个工作日** | |

P0 与 P1 内部的 S-06/S-07 可以并行（两个人分别做纯函数与引擎），P2 的 S-14（向导 UI）与 S-11~S-13（后端）可以并行。

---

## 7. 发布策略与回滚

| 项 | 做法 |
|---|---|
| 特性开关 | `settings.json` 的 `syncEnabled`，默认 `false`；首次进入设置页时显示 beta 提示 |
| 灰度顺序 | 本地文件夹后端 → 坚果云（最可控）→ Koofr → InfiniCLOUD → 通用 WebDAV |
| 出问题怎么退 | 关 `syncEnabled` 即停止所有网络请求；**本地数据从不被同步逻辑删除**；`sync/history/` 可逐份回滚 |
| 数据安全底线 | 远端目录只写 `AgentReader/`；不触碰用户网盘其他文件；`drive.file`/AppFolder 级别的隔离在 v2 里由 OAuth 后端保证 |

---

## 8. 风险登记册

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 坚果云配额被测试打爆（免费额度小） | 中 | 测试卡住 | 测试用 `local-folder` 为主；真机测试手工控制频率；令牌桶 20/min |
| `PROPFIND` 行为与文档不符（分页、ETag） | 高 | 后端要改 | S-11 第一天就先做「探测脚本」，先摸清再写实现 |
| 用户用登录密码连 WebDAV | 高 | 体验挫败 | 401 文案点名 + 一键跳生成页（已在 presets 里） |
| 免费空间服务方改版导致深链失效 | 中 | 引导断 | 深链 + 帮助页双入口，失败自动回落 |
| 设置同步把本机专属 key 抹掉 | 中 | 数据丢失 | §4.1 的「覆盖而非替换」+ 单测守住 |
| 两台机器长时间离线后同时上线 | 中 | 冲突多 | 冲突默认保留、`base` 三方合并把自动合并率拉高；冲突 UI 支持批量处理 |
| 原书体积打满免费额度 | 中 | 用户投诉 | 默认关 + 副标题写清代价 + 超限只同步笔记 |

---

## 9. 需要你拍板的 5 个决定

| # | 决定 | 我的建议 | 影响 |
|---|---|---|---|
| 1 | 设置同步默认开吗 | **默认开**（设置量小、价值立竿见影） | 关的话用户要手动打开才有「换机不用重配」 |
| 2 | 原书同步默认关吗 | **默认关** | 开的话新用户容易被 1GB 月配额劝退 |
| 3 | 冲突默认策略 | **保留本机 + 显式提示** | 影响冲突 UI 的默认按钮 |
| 4 | 第一版就做 InfiniCLOUD 反查吗 | **做**，成本只有一个 API KEY 申请 | 不做则 InfiniCLOUD 用户要手填 node URL |
| 5 | 第一版接受「无端到端加密」吗 | **接受**，但 UI 与文档明确写「云端为明文」 | 不接受则要先做 `crypto.ts`，工期 +2 天 |

---

## 10. 本周可立即开工的三个 PR

| PR | 内容 | 依赖 | 产出 |
|---|---|---|---|
| **PR-1** | S-01 + S-02 + S-04：`paths.ts` / `config.ts` / `backend.ts` / `clock.ts` + 三个单测 | 无 | 可复用的地基，CI 变绿 |
| **PR-2** | S-03 + S-05：`local-folder.ts` + 测试脚本接线 | PR-1 | 「无网络的远端」可用 |
| **PR-3** | S-06：`sanitize.ts` + `merge-settings.ts`，把 `research/settings-sync-prototype.ts` 的断言转成 `node:test` | 无（纯函数，可并行） | 设置合并的正确性从原型升级为产品代码 |

三个 PR 都不碰 UI、不碰网络，风险最低，且合起来就能支撑 PR-4（引擎骨架 S-07）——那时第一次能在两个目录之间看到「设置自己同步过去了」。

---

## 11. 实施进度

| 任务 | 状态 | 产出 |
|---|---|---|
| S-01 路径与配置存储 | ✅ 完成 | `sync/paths.ts`、`sync/config.ts`（注入式 `SecretCodec`，单测覆盖「密文不含明文」「解不开当没有」） |
| S-02 后端接口 + 注册表 | ✅ 完成 | `sync/types.ts`、`sync/backend.ts`（含 `checkBackendContract` 契约自检） |
| S-03 本地文件夹后端 | ✅ 完成 | `sync/backends/local-folder.ts`（原子写、条件写、路径越界防护、iCloud 占位符识别） |
| S-04 时钟与设备标识 | ✅ 完成 | `sync/clock.ts`（HLC 严格递增 + 全序比较） |
| S-05 测试接线 | ✅ 完成 | `package.json` test 脚本新增 6 个文件；`npm run check` + `npm test` 全绿 |
| S-06 净化 + 设置合并 | ✅ 完成 | `sync/sanitize.ts`、`sync/merge-settings.ts`（含 `applyMergedSettings`） |
| S-07 引擎骨架 | 🟡 设置部分完成 | `sync/engine.ts`（pull → merge → 落盘 → 推进基线 → push → 写后回读；书库分支待 P3） |
| S-08 设置写盘打点 | ✅ 完成 | `settings.ts` 拆出 `readRawSettings`/`writeRawSettings`；按 §4.0-A 接了 3 处钩子（`updateSettings`、`writeCustomProviders`、`writeModelOverrides`），脏标记中枢 `sync/dirty.ts` 零依赖、可单测 |
| S-09 IPC + 装配 | ✅ 完成 | `sync/index.ts`（6 个 IPC + `sync:status` 推送 + 5s 去抖 + 失败不重试不可重试错误）；`preload` 与 `main.tsx` 类型同步；`src/shared/sync-types.ts` 让两端共用同一份线上类型 |
| S-10 设置页分区 | ✅ 完成 | `components/sync/SyncSection.tsx` + `SECTION_GROUPS` 新增「同步」组；未连接态可选择目录并连接，已连接态显示状态/上次同步/待推送/本次请求数/错误详情 |
| S-11 WebDAV 后端 | ✅ 完成 | `backends/webdav.ts`（preemptive Basic、令牌桶、逐级 MKCOL、按段编码、条件写、MOVE）+ `webdav-xml.ts`（multistatus 解析，容忍前缀/默认命名空间/绝对 href/百分号编码）；用**内存版 DAV 服务器**离线跑通 `checkBackendContract` |
| S-12 错误语义与限流 | ✅ 完成 | `connect.ts` 的 `classifyFailure` + `presets.ts` 的服务级覆盖；Koofr 429 → `locked-out` 且 `retryable:false`，坚果云 429 → 限流退避，有双服务对比测试 |
| S-13 写后回读 + 重试 | ✅ 完成 | 引擎侧补了两个用例：回读读到旧内容会被识别并重推（请求数 ≥5），持续不一致则在 3 次后报错而不是宣布成功 |
| S-16 书库写盘打点 + 状态映射 | ✅ 完成 | `sync/doc-port.ts`（`library/{docId}/` 五个文件 ↔ `DocState`，写回保留 `hash`/`importedAt`/`originalPath`）；7 个函数接钩子，覆盖 §4.0-B 的 10 个写盘点（`saveConversations` 一个钩子覆盖 create/delete/rename/edit 四处）；标注只在**内容真变**时才发新戳 |
| S-17 记录级三方合并 | ✅ 完成 | `sync/merge-records.ts`：标注/对话/消息行按 `id` 三方合并，删除由基线推导（无墓碑）；位置与章节单值 + 全序键兜底；400 轮随机 fuzz 断言方向无关 |
| S-18 冲突呈现与选边 | ✅ 完成 | `sync/conflicts.ts`（冲突仓库：落盘、人类可读标签、稳定 id）+ `sync/resolve.ts`（纯函数：设置改值/删除、标注/对话/消息行/位置/章节换值，**重发时间戳**以防下一轮再判冲突）+ `sync:resolve` IPC；设置页冲突列表逐条「用本机 / 用远端」 |
| S-19 状态栏指示灯 | ✅ 完成 | `StatusBar` 新增同步指示（同步中 / 待同步 / 已同步 / N 条冲突 / 出错），点击直接落到「设置 → 云同步」分区（`Settings` 支持 `initialSection`） |
| S-20 原书上传/下载 | ✅ 完成 | `sync/books.ts`：上传前查 `caps.maxObjectSize`、上传后 `list` 核对体积、下载后校验 `sha256(content).slice(0,16) === docId`；不匹配即丢弃。**放弃分片**——纯 WebDAV 没有追加写，分片最后仍要客户端拼起来整传，见下方说明 |
| S-21 云端书条目 | ✅ 完成 | 书库侧栏里，只在云端的书带「云端」徽标（禁用删除按钮），点开时先下载再打开；设置页也保留上传/下载列表 |
| S-14 预设表与连接界面 | 🟡 部分完成（向导待拆屏） | `presets.ts`（6 家）+ `sync:presets`/`sync:probe`/`sync:open-external`/`sync:read-clipboard` 四个 IPC；设置页改为「选云盘 → 填账号与应用密码 → 连接」，含「从剪贴板读取」「去生成…」「浏览器打开」「识别地址」；「去生成…」走**内嵌登录窗**（独立不持久分区、关闭即清 storage、导航白名单）。**仅剩**：五步向导拆成多屏（`reduceWizard` 已有测试，纯 UI 工作） |

**当前测试规模**：`src/main/sync/` 下共 **121 个用例**（3000 轮以内的 fuzz 收敛/幂等、7 个双机集成场景、脏标记代际语义、发戳记录、基线存储），全部通过；仓库整体 219 passed / 1 skipped / 0 failed。`npm run check` 与 `npm run build` 均绿，渲染进程产物已包含新分区。

其中 WebDAV 后端是**完全离线验证**的：`webdav.test.ts` 里有一个 100 行的内存版 DAV 服务器（支持 MKCOL / PROPFIND / GET / PUT / DELETE / MOVE、ETag 与条件写、可注入状态码），`checkBackendContract` 直接跑在它上面。真机测试留给「服务方特有的怪癖」（分页截断、ETag 格式、429 口径），而不是用来验证我们自己的语义。

**引擎的可测性来自三个注入端口**（计划里原先只写了「后端无关」，实施时定形）：

```ts
createEngine({ backend, settings, storage })
//   backend  ← SyncBackend（local-folder / webdav）
//   settings ← SettingsPort（真实实现包装 settings.ts）
//   storage  ← EngineStorage（基线与索引，真实实现落 {userData}/sync/）
```

于是「两台机器 + 一个云端」可以在单进程里用三个临时目录完整模拟（`engine.test.ts` 就是这么做的），P2 接 WebDAV 时只换 `backend` 一个参数。

### P3 已完成（S-16 ~ S-19）

冲突选边与状态栏都已接上。剩余的是**真机验证**：两台机器（或两个应用实例）经坚果云同步阅读进度、标注与对话，确认限流与 429 的实际表现。

对「冲突」的一条设计约定：合并只负责选出赢家，**输掉的值必须持久化**（`sync/conflicts.json`），否则下一轮一收敛就永久消失。用户选边后会以新时间戳写回，再由一次同步推上去 —— 少了重新发戳这一步，下一轮会立刻再报同一个冲突。

### P4 的一处计划调整：放弃「分片上传」

计划 §3.6 原本要求「>32MB 走分片 `PUT` + `MOVE` 拼装」。实现时确认这条路走不通：**纯 WebDAV 没有追加写语义**，分片只能各自落盘，最后仍要客户端把所有分片读回来、拼成完整 Buffer 再整传一次 —— 既没省流量，还多绕两趟、多一次内存峰值。

所以这一版是「一次 `PUT` + 上传后核对远端体积」。真正的断点续传要按服务方能力实现（OneDrive 的 `createUploadSession`、S3 的 multipart），属于未来后端的事，不该塞进 WebDAV 后端里假装做到了。

### P2 收尾（剩余，仅剩两项外部依赖）

1. **五步向导拆屏**：`reduceWizard` 已有测试，界面仍是单页表单。拆屏是纯 UI 工作，不影响功能；
2. **InfiniCLOUD API KEY**：需向官方申请后填进 `presets.ts` 的 `endpointProbe.apiKey`；未填时「识别地址」会如实提示并退回手填。

**已完成**：内嵌登录窗（独立不持久分区、关闭即 `clearStorageData`、导航白名单、`window.open` 外抛）、从剪贴板读取、书库侧栏「云端」条目。

**当前可用后端：本地文件夹 + 任意 WebDAV**。笔记与原书同步仍未接（P3 / P4），设置页据实标注。
