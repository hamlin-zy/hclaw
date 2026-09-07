# AGENTS.md — Agent / 编码约定

## builtin 工具线程环境约定

`src/main/agent/tools/builtin/` 下的工具运行于 **worker 线程**（MCP Worker 上下文），
**禁止直接依赖 electron 主进程 API**（如 `BrowserWindow`、`getMainWindow` 等 ——
运行时不可用或把 electron 拉进 worker bundle 导致加载失败）。

- 跨进程通知渲染端：走 `parentPort.postMessage`（worker）→ 主进程 AgentManager 转发；
  主进程路径直接 IPC。双路径统一模式参考 `src/main/memo/broadcast.ts`（环境感知 + try/catch 兜底）。
- 需要在主进程上下文执行 `require('../../../window')` 类延迟导入时，必须包 try/catch，
  失败时 `logger.warn` 留痕（参考 agentTool.ts / sessionHandoffTool.ts 的 sendToRenderer）。
