# 变更日志

所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

---

## [v0.2.88] - 2026-07-24

### 新增
- **自动更新检查模块** — 版本对比引擎、后台静默检查、IPC 桥接、更新通知弹窗、preload API 暴露、单元测试 (`src/main/updater/updateChecker.ts`, `src/main/updater/compareVersions.ts`, `src/main/updater/constants.ts`, `src/renderer/stores/updaterStore.ts`, `src/renderer/components/dialogs/UpdateNoticeDialog.tsx`, `src/shared/types/updater.ts`, `tests/main/updater/compareVersions.test.ts`, `tests/main/updater/updateChecker.test.ts`)

### 重构
- **AboutDialog 增加更新交互** — 检查更新按钮 + 5 种状态文案 + GitHub/网盘下载按钮 (`src/renderer/components/dialogs/AboutDialog.tsx`)

### 变更
- **启动流程集成静默更新** — 启动时 fire-and-forget 检查更新并推送状态到渲染进程 (`src/main/index.ts`)
- **IPC 注册更新接口** — 注册 updater:get-status 和 updater:check-for-update (`src/main/window.ts`)
- **MenuBar 更新提示** — 关于菜单按钮有新版本时显示红色小圆点 (`src/renderer/components/MenuBar.tsx`)

---

## [v0.2.87] - 2026-07-25

### 修复
- **CombinedCardPopup 思考块内容实时更新** — 弹窗打开后从实时消息流（messagesMap）订阅最新 thinkBlock，替代打开时的快照；预构建 Map 查找表避免渲染循环中 O(n×m) 查找 (`src/renderer/components/message-list/compact-popup/CombinedCardPopup.tsx`)

### 变更
- **弹窗数据类型扩展** — `combinedPopupData` 新增 `convId`、`messageId` 字段，ToolCallRenderer 获取并透传 convId，InterleavedContent 透传 messageId (`src/renderer/stores/agentStore/types.ts`, `src/renderer/components/message-list/ToolCallRenderer.tsx`, `src/renderer/components/message-list/InterleavedContent.tsx`)

## [v0.2.86] - 2026-07-25

### 重构
- **工具名别名系统** — 将 Claude Code / Codex 的工具名（Read/Write/Edit）映射到 HClaw 实际工具名，兼容 everything-claude-code 等插件的 Agent 定义 (`src/main/agent/tools/filter.ts`)
- **toolCallsStore 默认状态 pending→running** — 消除首次渲染延迟，提交 commit 时直接以 running 状态注册 (`src/renderer/stores/toolCallsStore.ts`)
- **ToolCallRenderer 透传真实进度 props** — 将硬编码假值改为透传有效进度/状态/ETA 到 Header (`src/renderer/components/message-list/ToolCallRenderer.tsx`)

### 修复
- **agent 崩溃恢复标记 cancelled** — 死亡 agent 的 toolCalls 标记为 `cancelled` 并同步消息级别状态，替代此前错误的"恢复中"文案 (`src/renderer/stores/agentStore/index.ts`)
- **streamTools 事件处理增强** — 工具开始事件丢失时自动注册 running 状态，进度事件缺失时同步注册，详情事件补充 status:running (`src/renderer/stores/agentStore/handlers/streamTools.ts`)

### 新增
- **子 Agent contentBlocks 同步** — 模式切换后子 Agent toolCall 能正确显示 (`src/renderer/stores/agentStore/handlers/streamSubAgents.ts`)
- **紧凑弹窗动态刷新文本** — 运行中 Agent 和子 Agent 的工具显示实时进度文本 (`src/renderer/components/message-list/compact-popup/CombinedCardPopup.tsx`, `index.tsx`)
- **ToolCallHeader 进度透传** — 非折叠状态的 progressBar/progressText 显示 (`src/renderer/components/message-list/ToolCallHeader.tsx`)
- **cancelled 状态类型** — ToolCall 类型新增 `cancelled` 状态常量 (`src/shared/types/message.ts`)

## [v0.2.85] - 2026-07-22

### 新增
- **askUserTool 选项空字符串校验** — 检查 options 中是否包含空白字符串，所有选项为空时提前返回明确错误提示，部分选项为空时打印警告日志 (`src/main/agent/tools/builtin/askUserTool.ts`)

## [v0.2.84] - 2026-07-16

### 新增
- **第三方 API 检测函数** — 新增 `isThirdPartyAnthropicAPI()` 判断当前模型是否指向非官方端点（DeepSeek/MiMo 等兼容 API），自动适配 thinking 块格式 (`src/main/agent/model/utils.ts`)
- **第三方 API thinking 块兼容** — 处理跨供应商环境下 thinking/signature 格式差异，自动注入空 thinking 块以满足 DeepSeek/MiMo 的格式校验 (`src/main/agent/model/anthropicAdapter.ts`)

### 修复
- **第三方 API signature 检查跳过** — DeepSeek 等兼容 API 不要求 signature，跳过不必要的 thinking 块完整性检查，避免因缺失 signature 导致的降级 (`src/main/agent/loop/execute.ts`)

## [v0.2.83] - 2026-07-12

### 修复
- **缓存命中率计算公式修正** — 从 `read/(read+write)` 改为 `read/(input+read)`，此前分母使用了错误的 write 字段导致比率失真 (`src/renderer/components/CacheRateTooltip.tsx`)

### 重构
- **tooltip 从 CSS hover 改为 Portal 渲染到 body** — 使用 `createPortal` 将 tooltip 挂载到 `document.body`，突破祖先容器 `overflow:hidden` 裁剪，同时增加 hover 进入/离开延迟防抖 (`src/renderer/components/CacheRateTooltip.tsx`)

### 新增
- **tooltip 底部公式展示** — 增加命中率公式与上下文窗口计算明细 (`src/renderer/components/CacheRateTooltip.tsx`)

### 变更
- **移除 cacheWriteTokens 统计** — 命中率公式不再依赖 write 值，表格移除"写入"行，"读取"标签改为"缓存命中"，"输出"行移入表格 (`src/renderer/components/CacheRateTooltip.tsx`)

## [v0.2.82] - 2026-07-12

### 重构
- **彻底移除压缩系统，全面采用结构感知截断** — 删除 `/compact` 命令和 LLM 摘要自动压缩（`executeCompactCommand`、`autoCompressIfNeeded`、`compressConversation` 等），新增 `structuredTruncation.ts`（保留首条 user + 最近 N 轮 + 中间按 turn 配对剥离失败 toolCall）与 `truncateBeforeLlm.ts`（每次 LLM 调用前的截断编排）。`Controller` 中 `compactLevel`、`lastActualInputTokens`、`messagesAtLLMCall` 状态字段全部移除，`isContextLengthError` 兼容导出清理 (`src/main/agent/compact/*`, `src/main/agent/loop/compress.ts`, `src/main/agent/loop/controller.ts`, `src/main/agent/loop/execute.ts`)
- **压缩相关默认值与导出清理** — `context.ts` 中仅保留 `estimateMessagesTokens`/`estimateTokens` 等纯 token 估算函数；`compress.ts` 退化为只含 `emitLlmCallDone`、`handleNoToolCalls`、`getLastUserMessage` 等公共 helper；`detectCommandContext` 中 `commandName === 'compact'` 判断恒为 `false` (`src/main/agent/context.ts`, `src/main/agent/loop/compress.ts`, `src/main/agent/loop/setup.ts`)

### 新增
- **`resolveMaxContextTokens()` 集中解析模型上下文窗口** — ModelScheme > adapter > 默认 128000 三级 fallback，新增 provider 只需改这一个文件 (`src/main/agent/loop/modelMaxContext.ts`)
- **`truncateForLlmCall()` 接入主循环** — 在 `executeLlmCallWithRetry` 中、ContextRetrieval 之后、image 过滤之前调用，超出预算时自动触发结构截断并记录日志 (`src/main/agent/loop/execute.ts`)
- **结构截断单测覆盖** — `structuredTruncation.test.ts` 覆盖「纯文本轮丢弃 / 混合轮配对剥离 / 全失败 turn 当文本处理 / 保留首条 user + 最近 10 轮」；`truncateBeforeLlm.test.ts` 覆盖「budget 内 passthrough / 超 budget 触发截断」 (`src/main/agent/loop/structuredTruncation.test.ts`, `src/main/agent/loop/truncateBeforeLlm.test.ts`)
- **本地 vitest 配置** — `vitest.config.local.ts` 声明 `@` 路径别名与测试文件 include 范围 (`vitest.config.local.ts`)

### 变更
- **`compactThreshold` 配置项彻底移除** — 不再出现在 `AgentSettings`/`SystemSettings` 默认值、设置对话框、`systemManageTool` schema、`manager.impl.ts` 与 `worker.ts` 初始化逻辑中 (`src/shared/types/settings.ts`, `src/renderer/stores/settingsStore.ts`, `src/renderer/components/dialogs/SettingsDialog.tsx`, `src/main/agent/tools/builtin/systemManageTool.ts`, `src/main/agent/manager.impl.ts`, `src/main/agent/worker.ts`)

## [v0.2.81] - 2026-07-11

### 修复
- **CDN 地址不再随 API baseUrl 覆盖** — 移除 `this.cdnBase = this.apiBase` 赋值，确保 CDN 地址独立于 API 地址 (`src/main/channel/adapters/wechatAdapter.ts`)

### 变更
- **CDN 默认地址更新** — `DEFAULT_BASE_URL` 从 `https://ilinkai.weixin.qq.com` 更新为 `https://novac2c.cdn.weixin.qq.com/c2c` (`src/main/channel/constants.ts`)

## [v0.2.80] - 2026-07-07

### 重构
- **提取 `compileGlobPattern()` 私有方法** — 将 `addRule` 和 `setRules` 中重复的 glob pattern 编译逻辑提取为私有方法，减少代码重复 (`src/main/agent/tools/permission.ts`)
- **清理未使用常量** — 删除 `_RULES_FILE`、`_CONFIG_FILE` 两个已不再使用的常量 (`src/main/agent/tools/permission.ts`)

### 新增
- **Auto 模式命令放行逻辑** — `checkPlannedCommands()` 新增 Auto 模式处理：非危险命令自动放行，危险命令仍被安全拦截返回提示信息 (`src/main/agent/tools/permission.ts`)

## [v0.2.79] - 2026-07-01

### 重构
- **Channel Worker 从 ESM 切换为 CJS（`channelWorker.cjs`）** — 使用 `.cjs` 扩展名确保 Node.js 始终以 CommonJS 模式加载 Worker，解决 Node.js 24 ESM 模式下动态 `require` 不兼容的问题。移除 `type: 'module'` 配置，`format` 改为 `cjs`，external 列表从飞书 SDK 依赖简化为 electron/native addon 等 Worker 不需要的模块 (`ChannelManager.ts`, `vite.main.config.mjs`)
- **Worker 错误/退出事件接入 logger** — `on('error')` 和 `on('exit')` 回调通过 logger 记录日志，替代之前的静默吞错，便于排查 Worker 崩溃原因 (`ChannelManager.ts`)

### 新增
- **缓存写入（cacheWriteTokens）统计展示** — CacheRateTooltip 新增「写入」行，展示累计写入和当前写入的 token 数量，与缓存读取并列显示 (`CacheRateTooltip.tsx`)
- **缓存命中率算法优化** — 分母从 `inputTokens + cacheReadTokens` 改为 `cacheReadTokens + cacheWriteTokens`，命中率 = 读取/(读取+写入)，更准确反映缓存效果 (`CacheRateTooltip.tsx`)

### 变更
- **依赖更新** — `@anthropic-ai/sdk` ^0.100.1 → ^0.107.0，`openai` ^6.37.0 → ^6.45.0，新增 devDependency `weixin-agent-sdk@^0.5.0` (`package.json`)

### 修复
- **`CHANNEL_VERSION` 与 weixin-agent-sdk 版本对齐** — 版本号从 `2.4.3` 改为 `0.5.0`，与 devDependency `weixin-agent-sdk` 保持一致，新增注释说明版本对齐规则 (`constants.ts`)

## [v0.2.78] - 2026-06-27

### 重构
- **agent 工具简化为单任务架构，移除内置并行编排** — 移除 tasks 数组、parallel 模式、complexity 字段、agentType 自动匹配、worktree 隔离等 ~230 行代码。并行交由 LLM 原生 parallel function call 实现，槽位满时直接拒绝并告知上限、由父 Agent 自行决定重试策略。新增 `capabilities` 参数支持从 skillRegistry/agentRegistry 查找指定能力，注入子 Agent 上下文 (`agentTool.ts`)
- **提取 `gracefulRestart()` 统一重启入口** — 新增 `src/main/utils/restart.ts`，封装 relaunch 标记 → MCP Worker 关闭 → app.exit 的标准化优雅重启流程，替换 `manager.impl.ts`、`config.ts`、`tray.ts` 三处重复的 `app.relaunch()`/`app.exit()` 调用，确保重启前 MCP 连接正确关闭

### Bug 修复
- **bashTool TypeScript 严格空值检查** — `proc.stdout`/`proc.stderr`/`proc.stdin` 添加非空断言 `!`，使用显式 `SpawnOptions` 类型替代 `as const` 断言，消除 strict 模式下的类型错误 (`bashTool.ts`)
- **MCP Client pid 空值安全** — `state.sdkTransport.pid` 添加 `?? undefined` 空值合并，防止 pid 为 null 时类型校验失败 (`client.ts`)

## [v0.2.77] - 2026-07-01

### Bug 修复
- **MCP 断开时通过 `killProcessTree` 兜底清理僵尸子进程** — MCP Server 连接失败时，先捕获 `StdioClientTransport.pid`，关闭 transport 后再调用 `killProcessTree(pid)` + `waitForProcessExit(pid)` 强制清理子进程树，防止 stdio 子进程残留占用资源（`client.ts:386-399`）

---

## [v0.2.76] - 2026-06-25

### 重构
- **MCP Transport 子进程环境变量从完整 `process.env` 继承** — 将 `enrichEnvPath()` 重命名为 `buildChildEnv()`，策略改为从完整 `process.env` 构建子进程环境变量（而非仅继承 SDK 的 12 个白名单变量），确保 `UV_CACHE_DIR`、`HTTP_PROXY`、`NODE_EXTRA_CA_CERTS` 等用户全局环境变量正常传递到 MCP 子进程。macOS/Linux 额外注入 nvm/Homebrew 等版本管理器路径，`mcp.json` 显式配置的 `env` 拥有最高优先级覆盖 (`stdio.ts:60-195`)
- **`getAllCandidateDirs()` 简化去重逻辑** — 三组 PATH 目录已知不重叠，移除 `Set` 去重，直接展平合并 (`stdio.ts:65-68`)

---

## [v0.2.75] - 2026-06-27

### 重构
- **Zod schema 并发硬上限 `SCHEMA_MAX_PARALLEL_TASKS` 改为动态读取** — 从硬编码 `10` 改为 `Math.max(10, subAgentScheduler.maxConcurrency)`，使 schema 校验上限与实际系统配置保持一致，避免配置了更大并发时被 schema 层误拦截 (`agentTool.ts:118`)

---

## [v0.2.74] - 2026-06-23

### Bug 修复
- **修复并行子 Agent 重复 subagent_start 导致前端重复注册 toolCall** — 移除 `agentTool.ts` 中并行模式下手动发送的 `subagent_start` 事件（`executeSingleTask` 内部的 `subAgentScheduler.executeTask()` 已通过 for-await 事件循环自动发送），在 `streamSubAgents.ts` 的 `handleSubagentStart` 中添加防御性去重检查 (`agentTool.ts:479-489`, `streamSubAgents.ts:110-135`)
- **修复 Agent/Skill 加载错误提示中可选属性 `.split()` 崩溃** — `AgentsDialog.tsx` 和 `SkillsDialog.tsx` 中 `LoadErrorBanner` 的 `name` 提取逻辑增加空值守卫，防止 `e.agentName` / `e.filePath` / `e.skillDir` 为 `undefined` 时掉用 `.split()` 导致页面白屏 (`AgentsDialog.tsx:439`, `SkillsDialog.tsx:159`)

### 重构
- **子 Agent 并发上限从硬编码改为动态读取** — `agentTool.ts` 中所有硬编码的 `3` 个并发上限替换为 `subAgentScheduler.maxConcurrency` 动态值，提取 Zod schema 硬上限常量 `SCHEMA_MAX_PARALLEL_TASKS = 10` 和缓存 TTL 常量 `AGENT_CACHE_TTL_MS`，错误提示同步改为动态显示当前上限 (`agentTool.ts:116-121, 161-162, 455-463, 558`)

---

## [v0.2.73] - 2026-06-23

### 重构
- **提取 MCP Client `createTransport()` 方法** — 将 `testConnection()` 和 `doConnect()` 中两份重复的 transport 创建 switch 合并为私有方法 `createTransport()`，新增 `http` 作为 `streamable-http` 的传输别名。净减少 ~40 行重复代码（`client.ts:628-662`）

---

## [v0.2.72] - 2026-06-16

### Bug 修复
- **MCP JSON 解析传输协议未从 URL 推断** — 在 MCP 管理页面粘贴 HTTP 类型 JSON 配置（只有 `url` 无显式 `transport`）时，解析按钮未从 URL 推断传输协议，导致表单保持默认 `'stdio'`。添加三段式推断逻辑：`transport → type → url`，与后端 `mcpConfig.ts` 行为一致（`MCPEditCard.tsx:137-139`）

---

## [v0.2.71] - 2026-06-16

### 重构
- **PowerShell 命令执行方式重构** — 将 PowerShell 命令通过 `-Command` 参数传递（`CreateProcessW` UTF-16LE），替代原先 stdin 写入方式，彻底解决 GB2312/936 默认编码导致的中文乱码问题
  - 同时注入 `InputEncoding=UTF8`，补齐原先仅设置 `OutputEncoding` 的缺口
  - `bashTool.ts`：spawn 分支逻辑改为 Windows PowerShell 走 `-NoProfile -Command <init>\n<command>\nexit`，其他 shell 保持 stdin 方式不变（约 30 行重构，净减少 1 行）

---

## [v0.2.70] - 2026-06-15

### 杂项
- **版本号更新** — v0.2.69 → v0.2.70

---

## [v0.2.69] - 2026-06-13

### 重构
- **MCP 工具命名重构** — 将 MCP 工具名从不可读的 `mcp_<hash>_<tool>` 统一改为可读的 `m_<serverName>_<tool>` / `mp_<serverName>_<tool>` 格式，LLM 看到的 function name 直接用可读服务名，消除去前缀行为
  - 新增 `src/shared/utils/mcpShortId.ts` 共享工具函数（~150 行），包含 isMcpToolName/parseMcpToolName/resolveMcpDisplayName 等全套解析函数
  - 服务端：discovery.ts/worker.ts/bootstrap.ts/mcpWorker.ts/systemPrompt.ts 全面使用新命名逻辑
  - 前端：ToolCallHeader/ToolCallBody/ToolCallRenderer/PopupToolCard/messageUtils 支持可读显示名 + 颜色分层的 MCP 工具展示（前缀用品牌色/70，服务名用品牌色，工具名用主色）
  - 兼容旧 mcp_ 格式，历史消息仍可正确识别和渲染

---

## [v0.2.64] - 2026-06-08

### Bug 修复
- **消息列表滚动定位算法重写**
- **macOS/Linux MCP Transport PATH 自动修复**

### UI 改进
- **内置浏览器标题**
- **新增"关于"界面**
- **托盘菜单新增"重启"按钮**

---

### [v0.2.56] - 2026-06-07

#### 改进
- Bash工具增强
- UI性能优化
- MCP服务管理优化
- 工具调用详情优化
- 可用能力搜索优化

---

### [v0.2.38] - 2026-06-05

#### 改进
- 统一管理不同主题下的Switch样式
- 定时任务交互优化
- 启动速度优化


#### Fix BUG
- agent\skill 更新问题


---

## [v0.2.32] - 2026-06-05

### 新增功能
- **名称复制按钮** — 在 Agents、Skills、Commands 管理页面、MCP 服务器卡片（插件/用户）、Plugin 列表、Tools 列表和 CommandList 中，为每条记录的名称添加始终可见的复制按钮。点击后图标切换为绿色对勾反馈（2 秒恢复），方便用户快速复制名称到剪贴板

### 杂项
- 新增 `.gitignore` 中 `temp_*` 模式，避免临时文件被误提交
- 清理意外提交的临时文件

---

## [v0.2.31] - 2026-06-05

### UI 改进
- **空状态 Logo 替换** — 将空聊天页面的 SVG 图标替换为 HClaw 应用 Logo，视觉更统一
- **欢迎页 Logo 放大** — 欢迎页 Logo 尺寸从 `w-32` 放大至 `w-56`，首屏视觉更突出
- **新增素材** — 新增透明版 Logo 和 Logo 素材，为后续界面优化做准备


