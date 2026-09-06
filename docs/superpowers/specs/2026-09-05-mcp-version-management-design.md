# MCP Service Version Management Design

**Date**: 2026-09-05
**Status**: Draft
**Classification**: Architectural

## Context

HClaw 当前的 MCP 服务管理是"装上就忘"的黑箱——`mcp.json` 中没有版本号，`McpServer` 类型无 version 字段，无版本检测代码。用户不知道：

1. 当前运行的 MCP 服务是什么版本
2. 远端有没有新版本
3. npx 缓存是否导致跑的是旧版
4. 服务是否在用户不知情的情况下自动升级了

已有的插件升级机制（`plugin/versionManager.ts`）和 repo 升级机制（`repo/versionManager.ts`）提供了成熟的架构模式参考，但 MCP 服务的来源类型多样（npx/npm 包、插件内置、本地二进制），版本检测逻辑与 git tag 完全不同，需要独立的检测策略。

## Goal

为 MCP 服务提供版本可见性（显示当前版本 + 远端最新版本 + 红点提醒有新版），升级执行为辅（用户确认后重启/更新）。交互模式复用插件模式：启动时自动检测、红点无打扰提示、手动确认升级。

## Scope

覆盖三类 MCP 服务来源：

| 来源类型 | 检测方式 | 升级执行 |
|----------|----------|----------|
| npx/npm 包 | `npm view <pkg> version` + `spawn(cmd, [...args, '--version'])` 探测 | 清理 npm 缓存 + 重启子进程 |
| 插件内置 | 复用 `pluginVersionManager` 缓存 | 委托 `pluginInstaller.update()` |
| 本地二进制 | `<command> --version` + 可选 `checkUrl` | 提示手动更新或通过 checkUrl 下载 |

检测频率：仅启动时检测一次（与插件一致）。用户可手动触发"同步版本"刷新。

## Architecture

```
应用启动 (src/main/index.ts)
  |
  +-- plugin/versionManager.startupCheck()       [已有] 必须先于 MCP 检测
  |
  +-- mcpService.initialize()                    [已有]
  |     加载 mcp.json + 启动 MCP 子进程
  |
  +-- mcpVersionManager.startupCheck()            [新增]
        |
        +-- 获取所有已启用的 MCP 服务
        +-- inferSourceType(server)
        |     server.id 以 'plugin:' 开头 -> 'plugin'
        |     command basename 是 npx/npm (处理全路径) -> 'npx'
        |     有 url 且 command 为空 -> 'url'
        |     command 非空且非 npx/npm -> 'binary'
        |     其他 -> 'unknown'
        |
        +-- Promise.allSettled(servers.map(detect))
        |     [npx]     npm view <pkg> version + spawn(cmd, [...args, '--version'])
        |     [plugin]  读 pluginVersionManager 缓存 (可能为空 -> null)
        |     [binary]  spawn(cmd, ['--version']) + checkUrl fetch
        |     [url]     { current: null, latest: null, hasUpdate: null }
        |     [unknown] { current: null, latest: null, hasUpdate: null }
        |
        +-- 汇总 -> versionMap (内存缓存)
        +-- broadcastToOtherWindows('mcp:status-update', versionMeta)
```

核心设计决策：

1. **MCP 版本管理器独立于插件/repo 版本管理器**，遵循相同架构模式（startupCheck -> versionMap -> broadcast -> red dot），但检测逻辑完全独立。
2. **插件类 MCP 零额外检测**：直接读 `pluginVersionManager.getMeta(pluginName)` 缓存，不触发网络请求。**启动顺序**：插件 `startupCheck()` 在 `index.ts` 中是 fire-and-forget（`.then()` 不 await），可能在 MCP `startupCheck()` 时尚未完成。这不是硬性前置条件——`detectPluginVersion` 在缓存为空时返回 null meta（不会报错，版本信息暂缺，用户手动同步可补全）。**不需要**改变现有 plugin startupCheck 为 await。
3. **版本比较策略**：与插件一致，v 前缀归一化 + 字符串比较，不引入 semver。
4. **检测只读不写**：检测阶段不修改系统状态（不清理 npx 缓存、不重启子进程、不写回 mcp.json）。缓存清理和子进程重启在用户确认升级时才执行。

## Components

### Type Extension: Two MCP Types

代码中存在两个 MCP 类型，均需扩展：

**1. `McpServer` (`src/shared/types/mcp.ts`) — 后端配置类型（mcp.json 读写）**

只新增 `checkUrl` 字段。版本运行时数据不写入配置类型，避免混淆配置与运行时状态。

```typescript
interface McpServer {
  // ... 已有字段不变 ...
  checkUrl?: string;  // 用户可选填，用于本地二进制远端版本检查
  // 支持 GitHub releases API URL / 自定义 JSON endpoint
}
```

**2. `MCPServer` (`src/shared/types/infra.ts`) — 前端运行时类型（UI 显示）**

新增版本显示字段，从 `VersionMeta` 映射而来，不持久化。

```typescript
interface MCPServer {
  // ... 已有字段不变 ...
  sourceType?: 'npx' | 'plugin' | 'binary' | 'url' | 'unknown';
  version?: string | null;           // 当前运行版本 (best-effort 探测)
  latestVersion?: string | null;     // 远端最新版本
  hasUpdate?: boolean | null;        // true/false/null (null = 无法判断)
}
```

`sourceType` 从 `command` + `args` 自动推断，不要求用户填写。`checkUrl` 是 `mcp.json` 中的可选字段，在 `McpServerInput` 接口和 `parseMcpServers` 中需同步新增解析。

### Config Extension: mcp.json

```jsonc
// ~/.hclaw/mcp.json — 向后兼容，新字段全部可选
{
  "mcpServers": {
    "my-local-binary": {
      "command": "/path/to/binary",
      "args": ["serve"],
      "checkUrl": "https://api.github.com/repos/owner/repo/releases/latest"
    }
  },
  "pluginMcpServers": {}
}
```

npx 类和插件类不需要任何配置改动。

### Version Meta Model

```typescript
// 三态版本状态模型 — 后端运行时缓存，不持久化
interface VersionMeta {
  current: string | null;      // null = 探测失败
  latest: string | null;       // null = 远端查询失败
  hasUpdate: boolean | null;   // null = 无法判断 (current 或 latest 为 null)
  sourceType: 'npx' | 'plugin' | 'binary' | 'url' | 'unknown';
  lastChecked: number;         // 上次检测时间戳，UI 可显示"上次检测: X分钟前"
}
```

**类型关系说明**：`VersionMeta` 是后端 `mcpVersionManager` 的内存缓存模型；`MCPServer` 的版本字段由 `VersionMeta` 映射而来供前端显示；`McpServer`（配置类型）只含 `checkUrl`，不携带运行时版本数据。三条数据路径：mcp.json → McpServer(含 checkUrl) → 检测 → VersionMeta(缓存) → MCPServer(UI 显示)。

**sourceType 合并**：`npm` 和 `npx` 统一为 `'npx'` 类型（`npm exec`/`npm run` 等场景极少用于 MCP，且检测逻辑与 npx 相同）。

### Backend: McpVersionManager

```
src/main/agent/mcp/versionManager.ts  (新增)

class McpVersionManager {
  - versionMap: Map<string, VersionMeta>  // serverId -> meta
  - isChecking: boolean                   // 去重锁

  + startupCheck()
    1. 检查 isChecking，为 true 则返回上次结果
    2. 获取 mcpService.getAllEnabled()
    3. 每个 server 调用 inferSourceType()
    4. Promise.allSettled(servers.map(detect))
    5. 汇总到 versionMap
    6. broadcastToOtherWindows('mcp:status-update', versionMeta)
    7. 整体 try-catch，失败只 log 不 throw

  + inferSourceType(server): SourceType
    从 command + args + server.id 推断（按优先级顺序）：
    - server.id 以 'plugin:' 开头 -> 'plugin'
    - command 的 basename 是 'npx' 或 'npm'（处理全路径如 /usr/local/bin/npx）-> 'npx'
    - server 有 url 字段且 command 为空 -> 'url'
    - command 非空且非 npx/npm（绝对/相对路径、可执行文件名）-> 'binary'
    - 以上都不匹配（如 command 为空且无 url）-> 'unknown'

  + detect(server): VersionMeta  // 按 sourceType 分流
    - 'npx'     -> detectNpxVersion(server)
    - 'plugin'  -> detectPluginVersion(server)
    - 'binary'  -> detectBinaryVersion(server)
    - 'url'     -> { current: null, latest: null, hasUpdate: null,
                     sourceType: 'url', lastChecked: Date.now() }
    - 'unknown' -> { current: null, latest: null, hasUpdate: null,
                     sourceType: 'unknown', lastChecked: Date.now() }

  + detectNpxVersion(server): VersionMeta
    1. parseNpmPackage(command, args) -> 包名
       处理格式：
       - @scope/pkg@1.2.0 / @scope/pkg@latest / @scope/pkg
       - pkg@1.2.0 / pkg@latest / pkg
       - args 中跳过 -y / -p / --yes 等 npx 自身标志
       - 如果无法提取包名 -> 返回 { current: null, latest: null,
         hasUpdate: null, sourceType: 'npx', lastChecked: Date.now() }
    2. getCurrentVersion:
       spawn(command, [...originalArgs, '--version'], 5s timeout)
       注意：不能只 spawn(command, ['--version'])，因为 command 是 'npx'，
       'npx --version' 返回的是 npx 自身版本而非包版本。
       正确做法是把 '--version' 追加到原始 args 末尾，
       让 npx 执行 'npx -y <pkg> --version'。
       解析 stdout：正则提取第一个 \d+\.\d+\.\d+ 模式，
       失败则取第一行 trim，再失败则 null。
    3. getLatestVersion: exec('npm view <pkg> version', 10s timeout)
       失败则 null

  + detectPluginVersion(server): VersionMeta
    1. 从 server.id 解析 pluginName
       格式: 'plugin:<pluginName>:<serverName>'
       解析: split(':')，取 [1]（即第二段）。
       注意: pluginName 理论上不含 ':'，因为来自 git 仓库名。
       若解析失败 -> { current: null, latest: null, hasUpdate: null, ... }
    2. pluginVersionManager.getMeta(pluginName)
       直接返回缓存的 { current, latest, hasUpdate }
       若插件 versionManager 尚未完成 startupCheck（缓存为空）->
       返回 { current: null, latest: null, hasUpdate: null, sourceType: 'plugin', ... }
       依赖时序：插件 startupCheck 必须在 MCP startupCheck 之前执行（见 Architecture）

  + detectBinaryVersion(server): VersionMeta
    1. getCurrentVersion: spawn(command, ['--version'], 3s timeout)
       解析 stdout：正则提取第一个 \d+\.\d+\.\d+ 模式，
       失败则取第一行 trim，再失败则 null
    2. if checkUrl:
         fetch(checkUrl, { timeout: 10s }) -> 解析 latestVersion
         解析优先级：
         1. JSON.tag_name 字段 (GitHub releases API，需 stripV 归一化)
         2. JSON.version 字段 (自定义 JSON endpoint)
         3. 正则匹配响应体中的 \d+\.\d+\.\d+ 模式
         全部失败则 null
       else:
         latestVersion = null (远端版本未知)
    3. 失败全部降级为 null

  + getVersionMeta(serverId): VersionMeta | null
    供 IPC 查询，从缓存即时返回

  + getAllVersionMeta(): Record<string, VersionMeta>
    出口单点：返回前验证每个 key 是否仍在当前 mcpServer 列表中
    不存在的移除（防御缓存残留脏数据）
    通过 mcpService.list() 获取当前服务列表做校验

  + compareVersions(current, latest): boolean | null
    stripV 归一化 + trim + 字符串比较
    current 或 latest 为 null 时返回 null

  + isChecking 标志：重入时返回上次结果，防止并发检测
}

export const mcpVersionManager = new McpVersionManager()
```

### IPC Extension

```
src/main/agent/mcp/ipc.ts — 新增 3 个 handler:

'mcp:get-version-meta'   -> mcpVersionManager.getAllVersionMeta()
                           从缓存即时返回，不触发网络请求

'mcp:check-versions'     -> mcpVersionManager.startupCheck()
                           手动触发完整检测（同步按钮）
                           完成后 broadcast 'mcp:status-update'

'mcp:upgrade-server'     -> 按 sourceType 分流执行升级
                           (see Data Flow section 4: User Confirms Upgrade)
```

### Frontend: createUpdateStore Factory

```
src/renderer/stores/createUpdateStore.ts  (新增)

提取 pluginUpdateStore 和 repoUpdateStore 的公共模式。

关键设计：
1. factory 泛型化 VersionMeta 类型，兼容现有二态 (non-null) 和 MCP 三态 (nullable)
2. factory 只提供 store 状态和方法，不自动注册 IPC 监听器
   （现有模式是组件层通过 window.electronAPI 注册 IPC listener，回调调用 store 方法）
3. 保留域特定方法名兼容：factory 接受 options.methodNames 配置，
   为 setVersionMeta / setXxxUpdates 等方法生成别名

createUpdateStore<T extends { hasUpdate: boolean | null }>({
  getAllVersionMeta,  // IPC API 函数 (window.electronAPI.xxx.getAllVersionMeta)
  setMethodName,      // 域特定方法名，如 'setPluginUpdates' / 'setRepoUpdates' / 'setMcpUpdates'
  })
  -> {
       versionMeta: Record<string, T>,
       updateMap: Record<string, boolean | null>,
       hasUpdate: boolean,  // 聚合：任意 hasUpdate=true 则 true
       resolveVersionMeta(meta),
       setVersionMeta: (meta) => void,         // 通用方法名
       [setMethodName]: (updateMap) => void,   // 域特定别名（兼容现有调用方）
       refreshFromCache(),   // 从 IPC 拉缓存，不触发网络
       clear(),
     }

现有 store 迁移策略：
  pluginUpdateStore = createUpdateStore({
    getAllVersionMeta: window.electronAPI.plugin.getAllVersionMeta,
    setMethodName: 'setPluginUpdates',  // PluginDialog.tsx 调用此名
  })
  repoUpdateStore = createUpdateStore({
    getAllVersionMeta: window.electronAPI.repo.getAllVersionMeta,
    setMethodName: 'setRepoUpdates',  // SkillsDialog/AgentsDialog 调用此名
  })
  mcpUpdateStore = createUpdateStore({
    getAllVersionMeta: window.electronAPI.mcp.getAllVersionMeta,
    setMethodName: 'setMcpUpdates',
  })

IPC 监听器注册模式（不变）：
  组件层 (App.tsx / McpDialog.tsx) 通过 useEffect 注册：
    window.electronAPI.mcp.onMcpStatusUpdate?.((data) => {
      useMcpUpdateStore.getState().setVersionMeta(data)
    })
  factory 不负责 IPC 注册，只提供 setVersionMeta 方法供回调调用

重构现有 store 时的行为保持约束：
  - 现有 store 的 versionMeta 类型是 { current: string; latest: string; hasUpdate: boolean }
  - 重构后 factory 接受 { hasUpdate: boolean | null }，现有 store 的 boolean 自然兼容
  - updateMap 从 Record<string, boolean> 变为 Record<string, boolean | null>
  - resolveVersionMeta 中 hasUpdate 赋值时 null 被 Object.values().some(Boolean) 视为 false
  - 域特定方法名通过 setMethodName 保留，调用方无需改动
  - 需要回归测试确保插件/repo 红点行为不变
```

### Frontend: UI Extension

```
src/renderer/components/dialogs/McpDialog.tsx — 扩展现有界面:

服务列表加版本列：
  current / latest / 红点 (hasUpdate=true)
  null 值显示 "未知" 或 "—"
  url/unknown 类型不显示升级按钮

升级按钮 -> confirm() 弹窗:
  "确认升级 <serverName>？该操作将重启 MCP 服务，
   可能中断当前正在使用的工具调用。"
  -> 'mcp:upgrade-server' IPC

同步按钮 -> 'mcp:check-versions' IPC:
  完成后 toast "版本检测完成" (5s 自动消失)

IPC 监听器注册 (App.tsx 或 McpDialog.tsx useEffect):
  window.electronAPI.mcp.onMcpStatusUpdate?.((data) => {
    useMcpUpdateStore.getState().setVersionMeta(data)
  })
```

### Preload & Type Declaration

```
src/preload/index.ts — 新增:
  onMcpStatusUpdate: (callback: (data: any) => void) => () => void
  (镜像现有 onPluginStatusUpdate / onRepoStatusUpdate 模式)

src/renderer/env.d.ts — 新增:
  onMcpStatusUpdate 类型声明
  mcp.getAllVersionMeta / mcp.checkVersions / mcp.upgradeServer 方法声明
```

## Data Flow

### 1. Startup Version Detection

```
应用启动
  |
  +-- plugin/versionManager.startupCheck()   [已有] 先于 MCP 检测
  |
  +-- mcpService.initialize()          [已有] 加载配置 + 启动 MCP 子进程
  |
  +-- mcpVersionManager.startupCheck() [新增] 在 MCP 服务启动后执行
        |
        |  前置条件：MCP 子进程已启动，可执行 --version 探测
        |  注意：plugin startupCheck 是 fire-and-forget，可能尚未完成。
        |        detectPluginVersion 在缓存为空时返回 null meta（优雅降级）。
        |
        +-- mcpService.getAllEnabled()
        +-- inferSourceType(server) per server
        |     (basename of command 用于判断 npx/npm，处理全路径)
        +-- Promise.allSettled(servers.map(detect))
        |     每个服务独立超时，单个失败不阻断
        |     [npx]     npm view + spawn(cmd, [...args, '--version'])
        |     [plugin]  读 pluginVersionManager 缓存 (可能为空 -> null)
        |     [binary]  spawn(cmd, ['--version']) + checkUrl fetch
        |     [url]     返回 null meta (不适用版本检测)
        |     [unknown] 返回 null meta
        +-- versionMap 汇总
        +-- broadcastToOtherWindows('mcp:status-update')
```

### 2. User Views Version Info

```
用户打开 MCP 设置界面
  |
  +-- McpDialog mount -> mcpUpdateStore.refreshFromCache()
  |     -> api.mcp.getAllVersionMeta() -> 'mcp:get-version-meta' IPC
  |     -> mcpVersionManager.getAllVersionMeta()
  |     -> 从 versionMap 缓存即时返回 (不触发网络)
  |
  +-- 渲染版本列: current / latest / 红点
```

### 3. User Manually Refreshes

```
用户点击"同步版本"按钮
  |
  +-- api.mcp.checkVersions() -> 'mcp:check-versions' IPC
  |     -> mcpVersionManager.startupCheck() (重新完整检测)
  |
  +-- broadcast 'mcp:status-update' -> 红点更新
  +-- toast "版本检测完成" (5s 自动消失)
```

### 4. User Confirms Upgrade

```
用户点击某服务的"升级"按钮
  |
  +-- confirm() 弹窗 (warning 样式)
  |   "确认升级 <serverName>？该操作将重启 MCP 服务，
  |    可能中断当前正在使用的工具调用。"
  |
  +-- 用户确认 -> api.mcp.upgradeServer(serverId)
  |     -> 'mcp:upgrade-server' IPC
  |
  |   [npx 类型]
  |   +-- 清理 npx 缓存
  |   |   方式: npm cache clean --force (清 npm 缓存，npx 依赖之)
  |   |   或: 删除 npx 缓存目录 (%LocalAppData%/npm-cache/_npx on Windows)
  |   |   失败则忽略 (非必须)
  |   +-- mcpService.restartServer(serverId)
  |   |   -> 停止旧子进程 -> 重新 spawn (npx 拉新版)
  |   +-- 升级后重新探测 --version -> 更新 versionMap
  |
  |   [plugin 类型]
  |   +-- 委托 pluginInstaller.update(pluginName)
  |   +-- powerManager.refresh() -> 插件类 MCP 重新加载
  |   +-- mcpVersionManager 刷新对应缓存
  |
  |   [binary 类型]
  |   +-- if checkUrl: 下载新版本到临时文件 -> 验证 -> 替换二进制 -> 重启
  |   |   验证步骤：
  |   |   1. 文件大小 > 0
  |   |   2. 若 checkUrl 响应含 hash 字段 -> 校验文件哈希
  |   |   3. 若是可执行文件 -> 检查文件权限/签名 (平台相关)
  |   |   验证失败则中断，保留旧版本，toast 报错
  |   |   (danger 样式二次确认)
  |   +-- else: 提示用户手动更新，提供 checkUrl 链接
  |
  |   [url / unknown 类型]
  |   +-- 不显示升级按钮（UI 层面隐藏）
  |   +-- 若用户通过 API 调用则返回 { error: 'unsupported_source_type' }
  |
  +-- restart 失败 -> 回滚 versionMap 旧值 -> 不清除红点 -> toast 报错
  +-- broadcast 'mcp:status-update' -> 红点更新
  +-- toast 显示升级结果 (5s 自动消失)
```

### 5. Runtime State Change Sync

```
MCP 服务运行中状态变更 (用户在界面启停/编辑)
  |
  +-- mcpService 启停/编辑 -> emit 状态变更事件
  |     -> mcpVersionManager 监听
  |     -> 对新增/重启的服务延迟 2s 后探测 --version (等子进程就绪)
  |     -> 更新 versionMap -> broadcast

插件升级/切换版本 -> powerManager.refresh()
  +-- 插件类 MCP 重新加载
  +-- mcpVersionManager 刷新对应缓存
  +-- broadcast 'mcp:status-update'
```

## Error Handling

**原则**：版本检测是"锦上添花"功能，任何环节失败都不能阻断 MCP 服务正常启动或运行。

| 场景 | 处理方式 | 用户感知 |
|------|----------|----------|
| `npm view` 超时/失败 | `latest = null`，标记"远端版本未知" | 版本列显示"未知"，无红点 |
| `--version` 探测失败 | `current = null`，标记"当前版本未知" | 同上 |
| `checkUrl` fetch 失败 | `latest = null` | 同上 |
| `checkUrl` 返回格式不匹配 | 尝试 `tag_name` 字段 -> `$.version` -> 正则匹配 semver，全部失败则 `null` | 同上 |
| 某个服务检测全部失败 | `hasUpdate = null` (三态)，不显示红点 | 版本列显示 "—" |
| startupCheck 整体异常 | catch + log，不影响应用启动 | 无红点，无报错 |
| npx 缓存清理失败 | 忽略 (非必须)，继续重启子进程 | 无感知 |
| 子进程重启失败 | 回滚 versionMap 状态，toast 报错 | 红点不清除 |
| 二进制下载失败 | 中断升级，保留旧版本，toast 报错 | 旧版本继续运行 |
| 升级中途网络中断 | 二进制类：先下载到临时文件，验证通过才替换 | 旧版本不受影响 |

## Historical Bug Prevention

Based on bugs encountered during plugin/skills/agents upgrade detection development:

### 1. Tag Prefix Pollution (mono-repo) -> Package Name Parsing

**Historical bug**: impeccable 仓库同时发 `skill-v4.0.3 / ext-v1.3.0 / cli-v3.4.0`，插件下拉框混入其他组件的 tag。

**MCP prevention**: `parseNpmPackage()` 必须正确处理 `@scope/pkg@1.2.0`、`pkg@latest`、`pkg -y` 等格式。测试覆盖 scoped/non-scoped/带版本/不带版本。

### 2. Red Dot Cross-Contamination

**Historical bug**: repo tab 红点亮起但列表中无任何项有红点，用户无法定位。插件仓库常驻 main 分支被 repo versionManager 收集后 hasUpdate=true 恒亮。

**MCP prevention**:
- MCP 用独立事件名 `mcp:status-update`，不共用 `plugin:status-update`
- `createUpdateStore` 各实例隔离
- `getAllVersionMeta()` 出口处防御性过滤：只返回 MCP 服务，不含非 MCP 数据

### 3. v Prefix Inconsistency

**Historical bug**: tag 是 `v1.0.0` 而 current 是 `1.0.0`。

**MCP prevention**: `compareVersions()` 先 `stripV` 归一化 + trim 再字符串比较。npx `--version` 输出和 `npm view` 返回格式可能不一致，需统一处理。

### 4. String Comparison (Not Semver)

**Historical decision**: 插件版本格式五花八门，字符串比较最可靠，不引入 semver。

**MCP note**: npm view 返回 semver 格式，但 `--version` 输出可能是任意格式。比较前需统一 stripV + trim。不使用 `src/main/updater/compareVersions.ts` 的 semver 比较。

### 5. Network Failure Cascade Isolation

**Historical pattern**: startupCheck 用 Promise.all + 每项 try/catch，单插件 fetchTags 失败只 warn 不缓存；syncVersions 失败返回 null 且不写缓存。

**MCP prevention**: `Promise.allSettled` + 每项独立超时。失败时不写入错误的版本号数据，但写入 null 状态标记"已检测但未获取到"：`{ current: null, latest: null, hasUpdate: null, lastChecked: <now> }`。区别于"未检测"（versionMap 中无此 key）。

### 6. Checkout Failure -> Restart Failure

**Historical pattern**: switchVersion 在 checkout 失败时直接返回，不触发 powerManager.refresh()。

**MCP prevention**: restart 失败 -> 回滚 versionMap 到旧值 -> 不清除红点 -> toast 报错。

### 7. Red Dot Push vs Cache Separation

**Historical pattern**: startupCheck 结果经 webContents.send 推送；渲染层 store 提供 refreshFromCache() 从 IPC 拉主进程缓存。

**MCP prevention**: 同模式。startupCheck 后 broadcast 推送；界面打开时 refreshFromCache 从 IPC 拉缓存，不触发网络。

### 8. Double Manager Boundary Mutual Exclusion

**Historical pattern**: repo manager 拒绝 plugin rootType (4 处守卫)；plugin manager 通过 registry.getByPath 委托 checkout。

**MCP prevention**: MCP versionManager 只管理 mcp.json 中的服务；插件类 MCP 只读不写 plugin versionManager 缓存；绝不向 plugin/repo versionMap 写数据。

### 9. Red Dot Meta Exit Single-Point

**Historical pattern**: 所有红点只从 getAllVersionMeta 出，即使缓存脏也能兜底过滤。

**MCP prevention**: `getAllVersionMeta()` 返回前验证每个 key 是否仍存在于当前 mcpServer 列表，不存在则移除。

### 10. Failure Always Degrades

**Historical pattern**: warmCache/syncVersions/startupCheck 全部 catch，主流程永不因检测失败崩溃。

**MCP prevention**: `startupCheck()` 整体 try-catch，失败只 log 不 throw。

### 11. StartupCheck Dedup Lock (New)

**Historical gap**: plugin/repo versionManager 无去重锁，理论可重入。

**MCP prevention**: `startupCheck` 加 `isChecking` 标志，重入时返回上次结果。

### 12. Multi-Window Sync (New)

**Historical gap**: 多窗口同步依赖 IPC 推送 + 打开时 refreshFromCache，无主动多窗口广播机制。

**MCP prevention**: 复用 `broadcastToOtherWindows`，确保所有窗口收到 `mcp:status-update`。

### 13. npx Cache Stale Version (MCP-specific)

**Risk**: `--version` 探测可能拿到 npx 缓存的旧版本。

**MCP prevention**: `--version` 探测通过 `spawn(command, [...originalArgs, '--version'])` 执行，即在原始命令和参数后追加 `--version`（不是单独执行 `npx --version`，那会返回 npx 自身版本）。在 MCP 子进程启动后执行（确保二进制已就绪）。`current` 始终来自 `--version` 探测结果，`latest` 始终来自 `npm view`，两者独立不互相覆盖。

### 14. --version Output Format Diversity (MCP-specific)

**Risk**: 有的输出 `1.2.3`，有的 `pkg-name v1.2.3`，有的多行。

**MCP prevention**: 正则提取第一个 semver-like 模式 `\d+\.\d+\.\d+`；提取失败则取 stdout 第一行 trim。

### 15. checkUrl Response Format Diversity (MCP-specific)

**Risk**: GitHub releases API vs 自定义 JSON 格式不同。

**MCP prevention**: 优先 `tag_name` 字段 (GitHub 标准，需 `stripV` 归一化)，其次 `version` 字段，最后正则匹配 semver。所有提取的版本号在比较前都需 `stripV + trim`。

### 16. Upgrade Interrupts Active Tool Calls (MCP-specific)

**Risk**: 升级重启中断正在执行的工具调用。

**MCP prevention**: confirm 弹窗明确警告。可选检测当前是否有活跃 tool call，有则额外提示。

## Testing Strategy

| Layer | Coverage | Method |
|-------|----------|--------|
| Unit | `compareVersions()` — v prefix normalization + string comparison | Same pattern as plugin versionManager tests |
| Unit | `inferSourceType()` — command/args -> sourceType inference | Various command formats: npx, npm, paths, URLs, plugin: prefix, empty command |
| Unit | `parseNpmPackage()` — extract package name from npx command | scoped/non-scoped/with @version/with @latest/-y flag/-p flag/multi-arg |
| Unit | `VersionMeta` tri-state logic — null current/latest -> hasUpdate | Edge cases: both null, one null, both non-null equal/unequal |
| Unit | `--version` output parsing — semver regex + fallback | Formats: `1.2.3`, `pkg v1.2.3`, `1.2.3-beta+build`, multi-line, empty |
| Unit | `checkUrl` response parsing — tag_name / version / regex | GitHub releases API, custom JSON, plain text, stripV on tag_name |
| Unit | `detect()` for 'url' and 'unknown' sourceTypes | Verify returns null meta with correct sourceType and lastChecked |
| Unit | `detect()` dispatch correctness | Verify correct detection method called per sourceType (mock each detect* method) |
| Unit | `parseNpmPackage()` returning null | Verify returns null VersionMeta when package name cannot be extracted |
| Unit | `inferSourceType()` with full-path npx | Verify `/usr/local/bin/npx` correctly detected as 'npx' not 'binary' |
| Integration | `startupCheck()` — mock npm view / --version response | mock child_process + exec, verify allSettled error tolerance |
| Integration | npx `--version` probe — verify args appended correctly | Confirm `npx -y pkg --version` is called, NOT `npx --version` |
| Integration | Upgrade flow — mock restart / cache clear | Verify state transitions + broadcast trigger |
| Integration | `createUpdateStore` factory — three stores share | Verify event listener + cache refresh + red dot derivation |
| Integration | `createUpdateStore` regression — plugin/repo stores | Verify existing plugin/repo red dot behavior unchanged after refactor |
| Integration | Dedup lock — concurrent startupCheck calls | Verify isChecking flag returns last result |
| Integration | getAllVersionMeta cache cleanup — stale server removal | Add stale entries, verify filtered; empty server list returns {} |
| Integration | Concurrent upgrade requests on same server | Verify second request rejected or queued, no double restart |
| Integration | Plugin MCP when pluginVersionManager cache is empty | Verify returns null meta gracefully (startupCheck order edge case) |
| Integration | MCP service disabled after startupCheck | Verify stale entry removed on next getAllVersionMeta call |
| Integration | startupCheck failure -> manual check succeeds | Verify error recovery path, no stale error state |
| Integration | Windows path separators in command | Verify binary detection works with backslash paths |
| Integration | Upgrade on url/unknown sourceType | Verify returns 'unsupported_source_type' error, no crash |
| Integration | createUpdateStore method name aliasing | Verify setPluginUpdates/setRepoUpdates still callable after refactor |
| Manual | Real MCP service version detection | At least 3 real MCP services (npx + binary) |
| Manual | Upgrade clears red dot | npx-based real upgrade |
| Manual | No network environment | All degrade to null, no errors, no crash |

**Test file structure** (following existing plugin test pattern):

```
tests/main/agent/mcp/
  versionManager.test.ts                 — unit tests
  versionManager.integration.test.ts     — integration tests

tests/renderer/stores/
  createUpdateStore.test.ts              — store factory tests
```

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `src/shared/types/mcp.ts` | Modify | Add `checkUrl` field to McpServer type |
| `src/shared/types/infra.ts` | Modify | Add version fields (sourceType/version/latestVersion/hasUpdate) to MCPServer type |
| `src/main/agent/mcp/versionManager.ts` | Create | McpVersionManager class |
| `src/main/agent/mcp/ipc.ts` | Modify | Add 3 new IPC handlers (get-version-meta, check-versions, upgrade-server); add broadcast for mcp:status-update |
| `src/main/agent/mcp/bootstrap.ts` | Modify | Export mcpVersionManager; ensure accessible from index.ts |
| `src/main/index.ts` | Modify | Add `mcpVersionManager.startupCheck()` call after `mcpWorkerManager.init()` (line ~398), fire-and-forget pattern matching existing plugin/repo version checks |
| `src/main/config/mcpConfig.ts` | Modify | Add `checkUrl` to `McpServerInput` interface and `parseMcpServers` function; add `checkUrl` to `serializeMcpServers` output |
| `src/preload/index.ts` | Modify | Add `onMcpStatusUpdate` IPC event listener (mirrors onPluginStatusUpdate) |
| `src/renderer/env.d.ts` | Modify | Add type declarations for onMcpStatusUpdate, mcp.getAllVersionMeta, mcp.checkVersions, mcp.upgradeServer |
| `src/renderer/stores/createUpdateStore.ts` | Create | Extract shared store factory (generic, supports nullable hasUpdate, domain-specific method name aliasing) |
| `src/renderer/stores/pluginUpdateStore.ts` | Refactor | Use createUpdateStore factory with setMethodName='setPluginUpdates'; behavior-preserving, requires regression tests |
| `src/renderer/stores/repoUpdateStore.ts` | Refactor | Use createUpdateStore factory with setMethodName='setRepoUpdates'; behavior-preserving, requires regression tests |
| `src/renderer/stores/mcpUpdateStore.ts` | Create | MCP update state store via createUpdateStore with setMethodName='setMcpUpdates' |
| `src/renderer/components/dialogs/McpDialog.tsx` | Modify | Add version column, red dot, upgrade button, sync button, IPC listener registration; hide upgrade button for url/unknown types |
| `src/renderer/App.tsx` | Modify | Add mcp:status-update IPC listener registration (mirrors existing plugin/repo listener pattern) |
| `src/renderer/api/mcp.ts` | Modify | Add getAllVersionMeta, checkVersions, upgradeServer API methods |
| `tests/main/agent/mcp/versionManager.test.ts` | Create | Unit tests |
| `tests/main/agent/mcp/versionManager.integration.test.ts` | Create | Integration tests |
| `tests/renderer/stores/createUpdateStore.test.ts` | Create | Store factory tests (including regression for plugin/repo) |

## Not In Scope

- MCP service auto-upgrade (upgrade is always manual confirmation)
- Periodic version polling (startup-only, same as plugins)
- Semver comparison (string comparison, same as plugins)
- MCP service health monitoring (separate concern)
- MCP service changelog / release notes display
