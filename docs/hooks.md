# Hook 管理

## 概述

Hooks（钩子）是在特定事件触发时自动执行的脚本，用于扩展 Agent 的行为和自动化工作流。

## 配置路径

进入 **设置 → Hooks** 即可管理钩子列表。

## 内置钩子

| 钩子 | 触发时机 |
|-----|---------|
| `session-start` | 会话开始时 |
| `session-end` | 会话结束时 |
| `pre-tool-use` | 工具执行前 |
| `post-tool-use` | 工具执行后 |
| `pre-compact` | 上下文精简前 |

## 创建 Hook

1. 点击「新建 Hook」
2. 选择触发事件
3. 编写 Hook 脚本（支持 JavaScript）
4. 保存并启用

## 示例

```javascript
// 会话结束时自动保存上下文
export function sessionEnd(context) {
  saveToMemory(context.conversationId, context.summary);
}
```

## 注意事项

- Hook 脚本错误可能导致 Agent 行为异常
- 建议先在测试环境中验证