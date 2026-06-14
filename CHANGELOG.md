# 变更日志

所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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


