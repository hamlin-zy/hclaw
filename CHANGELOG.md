# 变更日志

所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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


