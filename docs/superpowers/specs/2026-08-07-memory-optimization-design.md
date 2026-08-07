# 内存优化：副本消除 + 清理保护 + 死代码清理

**日期**: 2026-08-07  
**关联排查**: systematic-debugging 技能输出

## 问题根因

21 轮以内的会话（原始数据 2-3MB），在 `agent-start` 流程中产生过多的 V8 内存副本，峰值同时存在 3-4 份拷贝（spread、Worker structuredClone），叠加 V8 对象膨胀（10-15MB/份）。同时运行 2-3 个子 Agent 时，瞬时突破 200MB。

此外，`cleanupInactiveConversations` 无 Agent 状态保护，可能误清理运行中/等待交互的会话。

## 存储结构（SQLite 验证）

以 `conv-b2a3a389` 为例：21 条 messages，172 条 message_blocks。

**assistant 消息**（最重，89 blocks / 条的典型值）：

| 字段 | 内容 | 大小 |
|------|------|------|
| `metadata` | `{}` | 2B |
| `llm_stats` | `{totalTokens, usage...}` | ~3.6KB |
| blocks.text | 正文 | 12 条, ~2KB |
| blocks.think | 思考过程 | 24 条, ~96KB |
| blocks.tool_call | 工具调用 | 26 条, ~17.5KB |
| blocks.tool_result | 工具结果 | 26 条, ~128KB |
| blocks.end | 结束标记 | 1 条 |

**user 消息**：`metadata: {content, commandId, commandArgs}`（173B~11KB），无 blocks。

**buildMessagesFromRows 走两次查询**：先 `SELECT ... FROM messages WHERE conversation_id = ?`，再 `SELECT ... FROM message_blocks WHERE message_id IN (...)` 批量加载 blocks。对于 21 条消息的会话，第二次查询返回 172 行，按 `message_id` 分组后组装成 V8 对象数组。

**索引验证**：当前 `idx_messages_conversation_id` 是 `conversation_id` 单列索引。`readMessages` 的 `WHERE conversation_id = ? ORDER BY timestamp ASC` 使用该索引查找行，但 ORDER BY 需要额外 `USE TEMP B-TREE FOR ORDER BY`（内存中排序）。复合索引 `(conversation_id, timestamp)` 可消除此步骤。

## 数据流副本分析

```
SQLite DB
  │
  ├── [readMessages] → Copy A: Message[]（V8 对象）
  │     │
  │     ├── for loop → Copy B: ChatMessage[]（逐条解构重建）
  │     │     │
  │     │     └── spread → Copy C: [...converted, newUserMsg]
  │     │           │
  │     │           └── postMessage → Copy D: Worker structuredClone
  │     │
  │     └── [A/B/C 三份同时存活至 handler return]
```

## 设计方案

### Part A: 副本消除

**execution.ts** — spread→push：

改前：`readMessages` → `convertedMessages` (Copy B) → spread `[...converted, newUserMsg]` (Copy C)。B 和 C 同时存活。

改后：直接在 `messages` 数组上 push，消除 spread 副本。

```typescript
// 改前：3 副本同时存活（history, convertedMessages, messages spread）
// 改后：2 副本（messages, Worker structuredClone）
const history = conversationRepo.readMessages(convId)
const messages: ChatMessage[] = []
for (const msg of history) {
    messages.push(restructured(msg))
}
messages.push({role: 'user', content: ...})  // push 替代 [...spread]
await agentManager.start({messages})
```

### Part B: 清理保护

**conversationStore.ts:cleanupInactiveConversations** — 防止误清理运行中/等待交互的会话：

```typescript
const agentConv = useAgentStore.getState().convAgentStates[id]
if (agentConv?.agentState?.status === 'running' ||
    agentConv?.agentState?.status === 'thinking') return true  // 不清理
if (agentConv?.pendingPermissionConfirm ||
    agentConv?.pendingQuestion) return true  // 等待用户交互，不清理
```

覆盖：子 Agent 后台运行中、权限确认弹窗、ask_user 等待中。

### Part C: 数据库索引

迁移 `034_message_indexes.sql`（按项目编号规范，续在 `033_message_partial.sql` 之后）：

```sql
-- 替换单列索引为复合索引：同时覆盖 WHERE + ORDER BY，消除文件排序
DROP INDEX IF EXISTS idx_messages_conversation_id;
CREATE INDEX idx_messages_conv_ts ON messages(conversation_id, timestamp);
```

受益方：`readMessages`（WHERE + ORDER BY timestamp ASC）、`readMessagesTail`（WHERE + ORDER BY timestamp DESC LIMIT N）、`readMessagesBefore`（WHERE + ORDER BY + LIMIT）。复合索引替代原 `idx_messages_conversation_id`（仅覆盖 WHERE），排序列直接从索引读取无需额外步骤。

### Part D: 死代码清理

compact 命令已移除，`structuredTruncation`（内存操作）替代了旧的 compact_persist 写 DB 流程。残余死代码：

| 文件 | 删除内容 |
|------|---------|
| `manager.persister.ts` | **整个文件**。`doMergeAndPersist` 内联进 `manager.impl.ts` |
| `manager.backup.ts` | 整个文件 |
| `manager.impl.ts` | `handleCompactPersist` + 事件分发；+内联 `doMergeAndPersist` |
| `stream.ts` | `compact_persist` / `compact_persisted` / `context_compacted` 类型 |
| `streamSystem.ts` | `handleContextCompacted` / `handleCompactPersisted` 实现 |
| `streamEvents.ts` | compact case 分支 |
| `shared/types/events.ts` | `context_compacted` / `compact_status` 枚举 |

**`doMergeAndPersist` 内联理由**：4 个调用方全在 `manager.impl.ts`，`persistCompactedMessages` 死后无外部引用。

## 改动清单

| 文件 | 改动 | 行数 |
|------|------|------|
| `execution.ts` | spread→push | ~5 |
| `conversationStore.ts` | 清理加 Agent 保护 | ~10 |
| `migrations/034_message_indexes.sql` | 新增 | 3 |
| `manager.persister.ts` | **删除文件** → `doMergeAndPersist` 内联进 `manager.impl.ts` | -200 |
| `manager.backup.ts` | 删除文件 | -30 |
| `manager.impl.ts` | 删 compact 逻辑 + 内联 `doMergeAndPersist` | -25 +100 |
| `stream.ts` | 删 compact 类型 | -30 |
| `streamSystem.ts` | 删 compact handler | -30 |
| `streamEvents.ts` | 删 compact case | -10 |
| `shared/types/events.ts` | 删 compact 枚举 | -2 |

**活跃代码 ~15 行 + 内联 ~100 行，死代码删除 ~330 行。净 -215 行。**

## 风险

| 风险 | 缓解 |
|------|------|
| `structuredTruncation` 不是 compact 等效品 | 已在生产运行，已验证足够 |
| 清理保护可能永久保留僵尸会话 | Agent done/error → idle → 进入 10min 清理窗口 |

## 验证

- [ ] Agent 启动：Chrome DevTools Memory 对比改前峰值
- [ ] 子 Agent 运行中切走 ≥12min：确认不被清理
- [ ] 权限弹窗出现后切走 ≥12min：确认不被清理
- [ ] `npm run build && npm test`
- [ ] 死代码删除后：编译无引用错误
