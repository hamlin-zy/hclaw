---
title: 关于页面检查更新按钮
date: 2026-07-24
status: approved
author: hclaw-agent (brainstorming)
---

# 关于页面检查更新按钮

## 目标

在 HClaw 关于页面添加「检查更新」按钮，通过 GitHub Release API 检查是否有新版本，
并提供两个下载源（GitHub Release + 百度网盘）。启动时静默检查一次，新版本在
MenuBar「关于」菜单项上显示红点提示。

## 范围

### 包含

- 主进程新增 `updateChecker` service，封装 GitHub API 调用 + 内存缓存 + semver 比较
- 3 个 IPC handler：`updater:get-status` / `updater:check-for-update` / `updater:status-changed`
- 关于页面新增「检查更新」按钮，5 种状态内联切换（idle/loading/up-to-date/update-available/error）
- MenuBar「关于」菜单项上根据 `update-available` 状态显示红点
- 两个下载按钮：GitHub 下载（tag 详情页）+ 网盘下载（百度网盘）
- 启动时静默检查一次，不阻塞主窗口显示

### 不包含

- 自动下载安装（electron-updater / autoUpdater）
- 预发布版本检测（GitHub `/releases/latest` 默认跳过 prerelease 已满足）
- 本地缓存 release notes 历史（只缓存最新一次结果）
- 红点自动打开关于页面
- 多语言支持（按钮文字用中文，硬编码即可）

## 架构

### 文件改动清单

```
新增:
  src/main/updater/
    └── updateChecker.ts              service，封装 GitHub API + 缓存 + semver
  tests/main/updater/
    └── updateChecker.test.ts         vitest 单测

修改:
  src/main/index.ts                   启动时调用 updateChecker.init() 静默检查
  src/main/window.ts                  initWindowIPC 中新增 3 个 IPC handler
  src/preload/index.ts                contextBridge 暴露 updaterGetStatus / updaterCheckForUpdate / onUpdaterStatusChanged
  src/renderer/env.d.ts               新增 IPC API 类型声明
  src/renderer/components/dialogs/AboutDialog.tsx     新增「检查更新」按钮 + 2 个下载按钮
  src/renderer/components/MenuBar.tsx                 「关于」菜单项加红点
  src/renderer/stores/updaterStore.ts                 新增 zustand store 管理全局状态
```

### 数据流

1. App 启动 → `updateChecker.init()` 在主进程异步触发一次静默检查
2. 静默检查完成 → `webContents.send('updater:status-changed', result)` 推送到渲染层
3. 渲染层 `updaterStore` 收到推送 → 更新 `hasUpdate` 状态 → MenuBar 根据状态显示红点
4. 用户打开关于页面 → 立即读 `updaterStore.currentResult` → 按钮显示对应状态文字
5. 用户点「检查更新」按钮 → IPC `updater:check-for-update` → 绕过缓存打 API → 返回新结果
6. 用户点「GitHub 下载」或「网盘下载」 → IPC `open-system` 系统浏览器打开链接

### 模块边界

- `updateChecker` 是纯单例 service，无 React 依赖，无 IPC 依赖
- IPC handler 在 `src/main/window.ts` 注册，薄包装一层即可
- 渲染层用 zustand store（`updaterStore`）订阅推送，避免每个组件都 `addEventListener`

## 类型定义

```ts
// src/shared/types/updater.ts（新增文件）
export type UpdateStatus = 'up-to-date' | 'update-available' | 'error'

export interface UpdateResult {
  status: UpdateStatus
  currentVersion: string
  latestVersion?: string
  releaseNotes?: string
  publishedAt?: string
  downloads: {
    github: string
    baiduPan: string
  }
  error?: { code: 'network' | 'rate-limit' | 'parse' | 'unknown'; message: string }
  checkedAt: number
}
```

常量：

```ts
// src/main/updater/constants.ts（新增文件）
export const GITHUB_REPO = 'hamlin-zy/hclaw'
export const GITHUB_API_BASE = 'https://api.github.com'
export const BAIDU_PAN_URL = 'https://pan.baidu.com/s/1EIlDiU-EiEEiF-oXrHhFdQ?pwd=nmhb'
export const CACHE_TTL_MS = 10 * 60 * 1000      // 10 分钟
export const REQUEST_TIMEOUT_MS = 5000           // 5 秒
```

## IPC 接口

| Channel | 方向 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| `updater:get-status` | renderer → main | - | `UpdateResult` | 读缓存（内存），不打网络 |
| `updater:check-for-update` | renderer → main | - | `UpdateResult` | 强制重检查，绕过缓存 |
| `updater:status-changed` | main → renderer | `UpdateResult` | - | 静默检查完成时推送 |

`window.electronAPI` 新增 3 个方法：

```ts
updaterGetStatus(): Promise<UpdateResult>
updaterCheckForUpdate(): Promise<UpdateResult>
onUpdaterStatusChanged(callback: (result: UpdateResult) => void): () => void
```

## GitHub API 调用

- 端点：`GET https://api.github.com/repos/hamlin-zy/hclaw/releases/latest`
- Header：`Accept: application/vnd.github+json`、`User-Agent: HClaw-Updater/<version>`
- 超时：`REQUEST_TIMEOUT_MS` (5s)
- 解析字段：`tag_name`（strip `v` 前缀）、`body`、`published_at`、`html_url`

`/releases/latest` 端点语义：当存在多个 release 时，GitHub 会自动跳过 prerelease 取最新稳定版，
无需额外过滤逻辑。已实测返回 `tag_name: "v0.2.87"`，`prerelease: false`。

## semver 比较

使用 Node 内置 `node:sea` 不可，用 npm 上已有的包 —— 实际选择：

- 优先尝试 `require('node:module').builtinModules` 检查，发现无内置 semver
- 引入轻量依赖 `semver`（npm 包）作为新增依赖 —— 不行，需避免新依赖
- **最终方案**：手写一个 50 行的 semver 比较函数 `compareVersions(a, b): number`
  - 拆 `major.minor.patch`，忽略 pre-release 标签（因为 prerelease 已被过滤）
  - 数值比较，整段对比
  - 处理 `v` 前缀、忽略 build metadata

## 缓存策略

- 内存缓存：`{ result: UpdateResult, cachedAt: number }`，key = `'latest'`
- TTL = 10 分钟
- `getStatus()`：缓存命中且未过期 → 直接返回缓存；否则 → 异步打 API 并更新缓存
- `checkForUpdate()`：强制重检查，更新缓存
- 并发保护：检查进行中时记录 Promise，第二次调用复用同一 Promise

## 红点状态机

| UpdateResult.status | MenuBar 关于菜单红点 |
|---|---|
| `up-to-date` | 不显示 |
| `update-available` | 显示（红色圆点，绝对定位在图标右上角） |
| `error` | 不显示（避免误导） |
| 启动 1 秒内未完成首次检查 | 不显示 |

红点是纯展示元素，不响应点击（用户需要手动点关于菜单打开关于页面）。

## UI 呈现

### 关于页面

按钮顺序（在 4 个社交链接下方，divider 上方）：

```
[ 检查更新按钮 ]
[ GitHub 下载 ]  [ 网盘下载 ]    ← 仅在 update-available 时显示
```

按钮 4 种状态内联文字：

| 状态 | 按钮文字 | 次级元素 |
|---|---|---|
| 初始 / 未知 | 「检查更新」 | - |
| 检查中 | 「检查中...」 | - |
| 已是最新 | 「已是最新 v0.2.87」 | - |
| 有新版本 | 「有新版本 v0.2.88」 | 「GitHub 下载」「网盘下载」两个按钮 |
| 检查失败 | 「检查失败：网络异常」 | 「重试」按钮 |
| 限流 | 「检查失败：请求频繁，X 分钟后重试」 | - |

按钮颜色：
- 初始 / 已是最新：secondary（与社交链接相同）
- 检查中：disabled 状态
- 有新版本：primary 强调色
- 失败：warning 颜色

### MenuBar 关于菜单项

图标右上角叠加 6×6px 红色圆点，绝对定位 `top-1 right-1`，无文字、无动画。

## 错误处理

| 错误源 | code | UX |
|---|---|---|
| 网络断开/超时 | `network` | 「检查失败：网络异常」 |
| HTTP 403 + X-RateLimit-Reset | `rate-limit` | 「检查失败：请求频繁，X 分钟后重试」 |
| HTTP 404 / 仓库错 | `parse` | 「检查失败：版本信息异常」 |
| JSON 解析失败 | `parse` | 同上 |
| semver 解析失败 | - | 降级为 `up-to-date`，主进程 warn log |
| 其他 | `unknown` | 「检查失败」 |

通用规则：
- 错误状态不显示 MenuBar 红点
- 错误信息只在按钮内联文字呈现
- 错误时不写本地日志文件（主进程 logger 已记录）

## 边界情况

1. **首次启动无网络**：静默检查失败 → `error` → 用户主动点按钮重试
2. **GitHub 仓库改私有**：`parse` 错误 → 提示「版本信息异常」
3. **并发请求防护**：`check-for-update` 进行中时复用 Promise
4. **本地版本非 semver**：字符串对比，主进程 warn
5. **跨平台下载 URL**：两个 URL 都不区分平台，用户进页面自选系统包

## 测试策略

### 单测（`tests/main/updater/updateChecker.test.ts`）

mock `axios.get` 覆盖以下用例：

| 用例 | 期望 status |
|---|---|
| mock 返回 v0.2.88，本地 v0.2.87 | `update-available` |
| mock 返回 v0.2.86，本地 v0.2.87 | `up-to-date` |
| mock 返回 v0.3.0-alpha | `up-to-date`（/latest 已过滤 prerelease） |
| mock throw ECONNREFUSED | `error`, code: `network` |
| mock 403 + X-RateLimit-Reset | `error`, code: `rate-limit` |
| mock 返回 tag `garbage` | `up-to-date`（graceful） |
| TTL 9 分钟内连续 2 次 | 第 2 次不调 axios |
| TTL 11 分钟后第 2 次 | 调 axios |
| 并发 2 次 `checkForUpdate` | 只 1 次 axios 调用 |

覆盖率目标：`updateChecker.ts` ≥ 90%。

### 手测脚本

1. 本地降版本 `package.json` → 启动 → 看 MenuBar 红点 + 关于页面按钮结果
2. 本地升版本 + 临时断网 → 点按钮 → 看错误文案
3. DevTools 拦截 `/releases/latest` 返回 403 → 看限流文案

## 验收标准

- [ ] `src/main/updater/updateChecker.ts` 存在且通过单测
- [ ] `window.electronAPI.updaterGetStatus / updaterCheckForUpdate / onUpdaterStatusChanged` 在 `env.d.ts` 中有类型
- [ ] 关于页面渲染「检查更新」按钮，5 种状态切换正确
- [ ] MenuBar「关于」菜单项在 `update-available` 时显示红点
- [ ] 「GitHub 下载」「网盘下载」两个按钮在 `update-available` 时显示
- [ ] 启动 10 秒内完成静默检查（网络异常不影响主窗口显示）
- [ ] 单测覆盖率 ≥ 90%（updateChecker.ts）
- [ ] 没有引入新的 npm 依赖（用现有 axios + 手写 semver 比较）

## 设计权衡

### 为什么选 A 方案（主进程直连 GitHub API）

- 复用现有 IPC 模式：项目里所有外部 HTTP 都在主进程做（`googleAuth.ts` 是先例）
- 渲染层只问「有/没有」，不暴露 API URL
- 缓存逻辑清晰，单元测试好写
- 未来要演进到自动更新时，只需在 service 里加 `downloadAndInstall` 方法，IPC 接口不动

### 为什么不用 electron-updater

- 用户选了 A 方案（只检查 + 提示）
- electron-updater 是 B 方案的依赖，引入它等于做了一半的 B
- 配置复杂，要改 `electron-builder.yml` 和 CI 流程
- 违反 YAGNI

### 为什么不用新依赖（semver 包）

- 项目当前依赖已经 35 个（`package.json` 已很长）
- semver 比较只需 50 行代码，避免引入 1 个新依赖 + 100KB 安装体积
- 函数可单测覆盖

## 后续演进

- 如需自动下载安装：在 `updateChecker.ts` 加 `downloadAndInstall()` 方法，
  调用 `electron-updater` 的 `autoUpdater.checkForUpdates()`，IPC 接口不变
- 如需预发布版本检测：service 加 `includePrerelease` 配置项，调用
  `/releases` 列表自行过滤
- 如需多语言：提取按钮文案到 i18n 表（当前不引入，等真的需要再做）