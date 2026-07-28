---
name: hclaw-sdd-tools
description: HClaw平台SDD工具映射——将Superpowers subagent-driven-development工作流的抽象动作映射到HClaw的具体工具和Agent类型。当执行SDD实现计划时自动加载。
whenToUse: Subagent-driven development、SDD工作流、任务派发、代码审查
---

# HClaw SDD 工具映射

此技能为 Superpowers 的 `subagent-driven-development` 工作流提供 HClaw 平台的具体工具映射。

## 子Agent派发

### 派发 Implementer（实现者）

使用 `agent` 工具派发 Implementer Agent：

```
agent(
  agent="Implementer Agent",
  task="实现 Task N: [任务名称]。
  任务简报路径: [BRIEF_FILE]
  报告写入: [REPORT_FILE]
  工作目录: <项目根目录>
  [任务上下文...]",
  tools=["file_read", "file_write", "file_edit", "bash", "grep", "glob"]
)
```

### 派发 Code Reviewer（审查者）

使用 `agent` 工具派发 Code Reviewer Agent：

```
agent(
  agent="Code Reviewer Agent",
  task="审查 Task N 的实现。
  任务简报: [BRIEF_FILE]
  实现者报告: [REPORT_FILE]
  Diff范围: BASE=<sha> HEAD=<sha>
  运行: git diff --stat <BASE>..<HEAD>
  [全局约束...]",
  tools=["file_read", "grep", "glob", "bash"]
)
```

## 通用工具映射

| Superpowers 抽象动作 | HClaw 具体工具 |
|---|---|
| 派发子Agent | `agent(agent="Agent Name", task="...", tools=[...])` |
| 创建/标记待办 | `task_create(title="...")` / `task_update(taskId="...")` |
| 读取文件 | `file_read(filePath="...")` |
| 运行命令 | `bash(command="...")` |
| 搜索代码 | `grep(pattern="...", directory="...")` |
| 搜索文件 | `glob(pattern="...", directory="...")` |
| 写入文件 | `file_write(filePath="...", content="...")` |
| 编辑文件 | `file_edit(filePath="...", oldString="...", newString="...")` |

## 注意事项

1. **HClaw 的 `agent` 工具不支持"恢复Agent"** — 每轮fix需派发全新 Implementer（携带之前上下文）
2. **HClaw 的 `agent` 工具不支持 model 参数** — 模型选择由运行时配置决定
3. **SDD workspace 目录**: `<repo-root>/.superpowers/sdd/<plan-basename>/`
4. **不要并行派发多个 Implementer** — 会产生 git 冲突
5. **派发 Implementer 前记录 BASE SHA**: `git rev-parse HEAD`
