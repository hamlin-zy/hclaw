# Hook 系统

## 概述

Hook（钩子）在 Agent 的关键生命周期事件触发时自动执行，用于扩展行为、注入上下文或拦截操作。

HClaw 的 Hook 系统支持 **5 种类型**：
- **command** — 执行 Shell/PowerShell 命令（exit code 语义：0=allow, 1=warn, 2=block）
- **prompt** — 修改模型提示词
- **http** — 发送 HTTP 请求
- **agent** — 执行子 Agent
- **function** — 主进程内 JavaScript 函数（内置 handler 专用）

## 配置方式

通过 `~/.hclaw/hooks.json` 配置。插件通过 `PluginRegistry` 首次安装时自动写入。

### 示例

```json
{
  "hooks": {
    "pre-tool-check": {
      "type": "command",
      "events": ["PreToolUse"],
      "command": "node check-tool.js ${HOOK_JSON_INPUT}",
      "enabled": true,
      "source": "user",
      "matcher": "Bash|Write"
    }
  }
}
```

### 可用变量

| 变量 | 说明 |
|------|------|
| `${HOOK_JSON_INPUT}` | 完整的 hook 上下文 JSON（替换为临时文件路径） |
| `${HCLAW_LAST_LOOP_FILE}` | 上次 loop 的消息历史文件路径 |

## HookResult 规范

所有 hook 必须返回符合以下接口的结果：

```typescript
interface HookResult {
  /** 主语义：'allow' | 'block' | 'continue' */
  decision: 'allow' | 'block' | 'continue'
  /** @deprecated 向后兼容，allowed === (decision !== 'block') */
  allowed?: boolean
  modified?: { prompt?: string; context?: Record<string, unknown> }
  output?: string
  additionalContext?: string
  error?: string
  warning?: string
}
```

### Exit Code 语义（command 类型）

| Exit Code | 语义 | 产生的 HookResult |
|-----------|------|------------------|
| 0 | 允许继续 | `{ decision: 'allow' }` |
| 1 | 允许但有警告 | `{ decision: 'allow', warning }` |
| 2 | 阻止操作 | `{ decision: 'block', allowed: false }` |

Command hook 可以通过 stdout 输出 JSON 来控制决策：
```json
{"decision": "block", "reason": "不允许修改此文件"}
```

## 事件一览

### 已触发的事件（24 个）

| 事件 | 触发时机 | 支持类型 | 支持 Matcher |
|------|---------|---------|-------------|
| SessionStart | 会话启动 | command/prompt/http/agent | - |
| SessionEnd | 会话清理/结束 | command/http | - |
| UserPromptSubmit | 用户消息提交后 | command/prompt/agent | - |
| ThinkStart | LLM 思考开始 | command/function/http | - |
| ThinkEnd | LLM 思考结束 | command/function/http | - |
| PreToolUse | 工具执行前 | command/prompt/agent | ✓ |
| PostToolUse | 工具执行成功 | command/http/prompt | ✓ |
| PostToolUseFailure | 工具执行失败 | command/http | ✓ |
| PermissionRequest | 权限请求对话框显示 | command/prompt | ✓ |
| PermissionDenied | 权限被拒绝 | command/prompt | ✓ |
| ContextRetrieval | 上下文检索（注入知识） | command | - |
| PreCompact | 上下文压缩前 | command/prompt | - |
| PostCompact | 上下文压缩后 | command/http | - |
| FileChanged | 文件变更（Write/Edit 等） | command/http | ✓ |
| Stop | 响应完成 | command/http/agent | - |
| StopFailure | 响应失败 | command/http | - |
| SubagentStart | 子 Agent 启动 | command/http | - |
| SubagentStop | 子 Agent 完成 | command/http | - |
| TaskCreated | 任务创建 | command/http | - |
| TaskCompleted | 任务标记完成 | command/http | - |
| ConfigChange | 配置变更 | command/http | ✓ |

### 声明但未实现的事件（6 个）

以下事件在定义表中声明，但对应功能尚未实现：
- Elicitation / ElicitationResult — MCP 请求用户输入（计划中）
- TeammateIdle — Agent team 空闲（计划中）
- WorktreeCreate / WorktreeRemove — Git worktree 管理（计划中）
- Notification — 通知系统（计划中）

另外以下事件声明但尚未找到合适的触发入口：
- UserPromptExpansion — 命令展开前
- InstructionsLoaded — 规则文件加载
- CwdChanged — 工作目录变更

## 兼容层

旧系统的 JavaScript 脚本（`hooks/` 目录下的 `.js` 文件）通过兼容层自动注册到新系统。旧事件名会自动映射：

| 旧事件名 | 新事件名 |
|---------|---------|
| beforeThink | ThinkStart |
| afterThink | ThinkEnd |
| beforeToolCall | PreToolUse |
| afterToolCall | PostToolUse |
| beforeResponse | Stop |
| afterResponse | Stop |
| onError | PostToolUseFailure |
| onInterrupt | Stop |

建议逐步将脚本迁移到新系统的配置化方式。

## 架构

```
hooks.json (持久化)
    ↓
readHookConfig()
    ↓
HookExecutor.execute(event, context)
    ↓ 过滤: enabled + events[] + matcher
runAllHooks() → 逐个 executeHook()
    ↓ 决策: decision='block' → 立即返回阻断
CombinedResult → AgentLoop 消费
```

5 种 hook 类型的执行器：
- `executeCommand()` — child_process.exec/spawn + exit code 语义
- `executeFunction()` — 主进程 JavaScript 函数调用
- `executePrompt()` — 返回 modified.prompt
- `executeHttp()` — HTTP fetch + 变量替换
- `executeAgent()` — 子 Agent 调度（带深度限制防递归）

## 安全

- Agent hook 深度限制：最多 3 层，防止子 Agent 循环触发 hook
- 60s 硬超时：所有 hook 单次执行不超过 60 秒
- 会话级排队：同一会话的 hook 串行执行，防止竞态
- 内置 command-guard：阻止危险命令（rm -rf /, curl | sh 等）
- 内置 file-guard：阻止修改敏感文件（.env, .key, .pem 等）
