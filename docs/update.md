# 自动更新设计与发布流程

> 实现位置：`packages/app/src/main/update/`（主进程）、`packages/app/src/shared/update.ts`（IPC 类型）、
> `packages/app/src/renderer/components/UpdateSection.tsx`（设置页面板）。
> 检查/下载/安装全部在主进程完成，渲染层只渲染 `update:state`。

## 1. 为什么不用 electron-updater

`electron-updater` 在 macOS 上依赖 Squirrel.Mac：要求应用**已签名且已公证**，并要求同时发布
`zip` 与 `latest-mac.yml`。当前 `electron-builder.json` 里 `identity: null`（ad-hoc 签名）、
产物只有 `dmg`，所以 Squirrel 路线会直接失败。

这里选择的路线是「GitHub Releases API + 自己下载 + 平台脚本覆盖」：

| 能力 | 本实现 | electron-updater |
| --- | --- | --- |
| 未签名 macOS 应用 | 可用（dmg 挂载后原位覆盖） | 不可用（要求签名/公证） |
| 差量更新 | 不支持（整包下载） | 支持（blockmap） |
| 安装后自动重启 | 支持 | 支持 |
| 额外依赖 | 无 | `electron-updater` + `latest*.yml` |

整包 160 MB 左右，对桌面阅读器可以接受；以后要差量更新，可以保留现有 UI/状态机，只替换下载与安装层。

## 2. 一次更新的完整链路

```
启动 10s ──────────────┐
设置页「检查更新」─────┤
帮助 → 检查更新… ──────┘
                       ▼
        GET api.github.com/repos/{owner}/{repo}/releases
                       ▼
      pickLatestRelease()：过滤 draft / 预发布，按平台+架构选资产
                       ▼
         isNewer(最新, app.getVersion()) ?
                 │ 否 → up-to-date
                 ▼ 是
              available ──（开了自动下载）──▶ downloading
                 │                              │
                 │  用户点「下载并安装」         ▼
                 └──────────────────────────▶ ready
                                                │ 用户点「安装并重启」
                                                ▼
                                             installing
                                                │
                             ┌──────────────────┴──────────────────┐
                             ▼                                     ▼
                 macOS: hdiutil + 替换脚本               Windows: NSIS /S --force-run
                 Linux: AppImage 原子替换                （失败/无权限 → 打开文件手动处理）
                             └──────────────┬──────────────────────┘
                                            ▼
                                   应用退出 / 重启
```

### 2.1 检查

- 接口：`GET https://api.github.com/repos/{owner}/{repo}/releases?per_page=30`
- 请求头：`Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28`、`User-Agent: AgentReader/<version>`
- 未认证限流 **60 次/小时/IP**，所以自动检查间隔定为 6 小时；手动检查不额外限制，但会消耗同一额度。
  403 且 `x-ratelimit-remaining: 0` 会明确提示「额度用尽」，而不是笼统的「检查失败」。
- 版本来自 `tag_name`，支持 `v0.4.0`、`0.4.0-beta.1`、`1.2`；无法解析的 tag 会被跳过，不会造成
  「永远有新版本」的提示循环。
- 草稿（draft）永远忽略；预发布（prerelease）由「包含预发布版本」开关决定。
- **优先选择当前平台有产物的版本**：最新版漏传了 macOS 包时，回退到上一个能装的版本，而不是弹一个只能看网页的更新。

### 2.2 资产选择

文件名匹配规则（大小写不敏感）：

| 平台 | 接受类型（优先级从高到低） | 架构标记 |
| --- | --- | --- |
| macOS | `dmg` > `zip` | `arm64`/`aarch64`、`x64`/`x86_64`/`amd64`、`universal` |
| Windows | `exe`（NSIS）> `msi` | 同上 |
| Linux | `AppImage` > `deb` > `rpm` | 同上 |

- `.blockmap`、`latest*.yml`、`*.sha256`、`checksums.txt` 等会先被排除；
- 标了**别的架构**的文件直接排除（arm64 机器不会下到 x64 包）；
- 没写架构的文件视为通用包（例如 `AgentReader-Setup-0.4.0.exe`）；
- 同类型下精确架构 > universal > 未标架构；类型优先于架构（NSIS 能静默安装并自动重启）。

### 2.3 下载与校验

- 流式写 `<文件名>.part`，完成并通过校验后才 `rename` 成正式文件；
- 同时计算 SHA-256：优先用 GitHub API 的 `digest` 字段（`sha256:<hex>`，2025 年后上传的资产都有）；
  没有 digest 时尝试同 Release 里的 `SHA256SUMS`/`checksums.txt`；
- 字节数必须等于 Release 声明的 `size`；
- 校验失败或取消会**删除半截文件**，不会留下可被误安装的残包；
- 目标已存在且大小/摘要一致时直接复用，不重复下载；
- 安装包落在系统下载目录；资产名只取 basename，防止路径穿越。

校验强度会在界面上直接标出：`SHA-256` / `仅字节数` / `未提供`。只校验字节数时会显示黄字提醒。

### 2.4 覆盖安装

**macOS**

1. `hdiutil attach -nobrowse -readonly -noautoopen -mountpoint <tmp>`；
2. `ditto` 把 `.app` 复制到 `{userData}/updates/install/staged/`；
3. 生成 `replace.sh`（`chmod 755`），以 detached 方式启动后应用退出；
4. 脚本等待旧 pid 消失 → `rm -rf` 旧 `.app` → `ditto` 新包 → `xattr -dr com.apple.quarantine` → `open`。

必须用脚本等进程退出，不能在进程内直接 `rm -rf` 正在运行的 bundle。脚本日志在
`~/Library/Logs/AgentReader/update.log`。

以下情况退回「打开安装镜像，请手动拖拽」：`/Applications` 不可写（例如 root 安装）、
应用正从 `/Volumes/...` 运行、下载的是 zip。

**Windows**

- `AgentReader-Setup-*.exe`：`spawn(/S --force-run)`，NSIS 安装完成后自动启动应用；
- `.msi`：`msiexec /i ... /qn /norestart`，装完需手动打开；
- 当前配置是 `perMachine: false`（按用户安装），不需要 UAC。

**Linux**

- 只有 AppImage 支持自动覆盖：写 `<AppImage>.new` → `chmod 755` → 原子 `rename` 覆盖
  `$APPIMAGE` → 重启；运行中的二进制可以这样替换（不会触发 ETXTBSY）；
- `deb` / `rpm` 打开文件，交给系统包管理器。

## 3. 幂等性、并发与失败恢复

- 同一时间只允许一个检查或下载（`controller` 单例）；
- 自动检查与手动检查共享状态机，不会出现两个下载；
- 自动下载在检查结束后以 `setTimeout(0)` 触发，避免被「检查中」的并发保护挡掉；
- 下载失败/取消后回到 `available`，信息仍在，用户可直接重试；
- 安装失败停留在 `error`，界面提供重试、重新下载、打开发布页、打开所在文件夹；
- 本机检查时间与「跳过此版本」写在 `{userData}/updates/state.json`，不参与云同步
  （它们与设备/平台相关）；自动检查/预发布/自动下载三个偏好写在 `settings.json`，参与同步。

## 4. 配置

`settings.json`：

| key | 默认 | 含义 |
| --- | --- | --- |
| `updateAutoCheck` | `"1"` | 启动后自动检查，此后每 6 小时一次 |
| `updateIncludePrerelease` | `"0"` | 是否包含 prerelease |
| `updateAutoDownload` | `"0"` | 自动检查发现新版本时自动下载（安装仍需确认） |
| `updateRepo` | 空 | 覆盖仓库（fork 用），格式 `owner/repo` |

环境变量（不写盘，便于临时联调）：

| 变量 | 用途 |
| --- | --- |
| `AGENTREADER_UPDATE=1` | 开发态也启动自动检查（默认只在打包版启用） |
| `AGENTREADER_UPDATE_REPO=owner/repo` | 指向 fork / 测试仓库 |
| `AGENTREADER_UPDATE_API=https://...` | 覆盖 API 根地址（GitHub Enterprise / 镜像） |
| `AGENTREADER_UPDATE_TOKEN=...` | 私有仓库或提高限流额度；不会同步到云端 |

## 5. 发布新版本

版本号来自 `packages/app/package.json` 的 `version`，产物名由 `electron-builder.json` 的
`artifactName` 决定，必须保持「产品名 + 版本 + 架构」的可识别性：

```
AgentReader-<version>-arm64.dmg
AgentReader-Setup-<version>.exe
AgentReader-<version>-<arch>.AppImage   # 若发布 Linux 包
```

流程：

```bash
# 1. 改版本号（packages/app/package.json），提交
# 2. 打包（产物落在仓库根目录 out/）
npm run package --workspace=@agentreader/app
# 3. 在仓库根目录创建 Release 并上传资产（tag 建议带 v）
gh release create v0.4.0 \
  out/AgentReader-0.4.0-arm64.dmg \
  out/AgentReader-Setup-0.4.0.exe \
  --title "AgentReader 0.4.0" --notes-file CHANGELOG.md
```

注意：

- **tag 必须是可解析的版本号**（`v0.4.0`、`0.4.0-beta.1`）；
- `draft` 的 Release 不会被检查到；预发布版请勾选 prerelease，用户打开「包含预发布」才会收到；
- GitHub 会自动为资产生成 `digest`，这正是客户端校验用的 SHA-256；如果自己上传到别的镜像，
  请同时上传 `SHA256SUMS`（格式：`<64位hex>  <文件名>`）；
- macOS 是 unsigned/ad-hoc 签名，首次打开可能仍需右键「打开」。要做到完全无提示，
  需要 Apple Developer 证书 + 公证（`identity`、`notarize`），这与更新功能本身无关；
- 更新只覆盖当前架构。发布 arm64 包不会推送给 Intel Mac（Intel 机器会因为没有 arm64 资产而
  显示「当前平台没有安装包」），需要时为 Intel 增加 `x64`/`universal` 产物。

## 6. 测试与联调

```bash
cd packages/app
node --experimental-strip-types --test src/main/update/*.test.ts   # 单测
npm run typecheck

# 用真实 GitHub 数据跑一遍选择逻辑（不启动 Electron）
node --experimental-strip-types -e '
import { fetchReleaseList, parseRepo } from "./src/main/update/github.ts";
import { pickLatestRelease } from "./src/main/update/release.ts";
const releases = await fetchReleaseList({ repo: parseRepo("whitestarlau/AgentReader"), appVersion: "0.3.0" });
console.log(pickLatestRelease(releases, { includePrerelease: false, platform: "mac", arch: "arm64" }));
'

# 开发态联调自动检查
AGENTREADER_UPDATE=1 AGENTREADER_UPDATE_REPO=owner/test-repo npm run dev
```

本地验证覆盖安装时，建议先把 `.app` 复制到 `/tmp` 再手工改 `execPath`，不要拿
`/Applications/AgentReader.app` 直接试；替换脚本只会在应用退出后才执行。

## 7. 已知限制 / 后续可做

- 不支持断点续传与差量更新（整包下载、失败重下）；
- macOS 的原位覆盖依赖当前用户对安装目录有写权限；企业环境可能全部走手动；
- Windows 只有 NSIS 能自动重启；MSI 需要手动打开；
- Linux 只覆盖 AppImage；
- 未签名/未公证的 macOS 包在 Gatekeeper 下仍可能被拦一次（与应用更新无关，属于分发签名问题）；
- 检查结果不做磁盘缓存，离线/限流时只能重试或手动下载；
- 若将来接入 CI 自动发布，建议同时产出 `SHA256SUMS`，并为 macOS 增加 `zip` 产物以便切换 electron-updater。

## 8. 安全考量

- 只接受 `https://` 的资产与发布页 URL；
- 安装包必须有 GitHub `digest`（或 `SHA256SUMS`）才标记为完整校验，且校验失败绝不安装；
- Release 正文经 `rehype-sanitize` 清洗后渲染，禁止脚本与内联事件；
- 资产文件名只取 basename 后再拼接本地路径；
- 安装脚本对路径做单引号转义，避免文件名注入 shell；
- token 只从环境变量读取，不写入 `settings.json`，也就不会随云同步上传；
- 应用不向任何服务器上报设备信息或使用情况，检查请求只包含固定的 User-Agent。
