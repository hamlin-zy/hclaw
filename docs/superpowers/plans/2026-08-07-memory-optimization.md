# 内存优化：副本消除 + 清理保护 + 死代码清理 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 agent-start 流程中的 V8 内存副本、保护运行中会话不被误清理、清理 compact 死代码 ~330 行、升级 messages + message_blocks 表索引为复合索引。

**Architecture:** 4 部分独立修改——Part A（副本消除）改 execution.ts 的 spread→push，Part B（清理保护）改 conversationStore.ts 增加 Agent 状态判断，Part C（索引）新增 migration SQL，Part D（死代码）删除 compact 全链路 + 内联 doMergeAndPersist。

**Tech Stack:** TypeScript, Electron, Zustand, node:sqlite

**Spec:** `docs/superpowers/specs/2026-08-07-memory-optimization-design.md`

## Global Constraints

- 不改 `readMessages` 签名
- `doMergeAndPersist` 内联到 `manager.impl.ts`（不保留单文件）
- 迁移按项目规范：编号 034，前缀 DROP INDEX IF EXISTS + CREATE INDEX
- 所有 `compact_persist`、`compact_persisted`、`context_compacted`、`compact_status` 引用全部删除

---

### Task 1: 数据库索引 — 新增复合索引 migration

**Files:**
- Create: `src/main/repositories/sqlite/migrations/034_message_indexes.sql`（已创建）

**Interfaces:**
- Consumes: 现有索引 `idx_messages_conversation_id`（014_add_conversation_indexes.sql）、`idx_message_blocks_message_id`（同）
- Produces: `idx_messages_conv_ts(conversation_id, timestamp)`、`idx_message_blocks_msg_seq(message_id, sequence)`

- [ ] **Step 1: 验证 migration SQL 文件存在且内容正确**

文件已创建于 `src/main/repositories/sqlite/migrations/034_message_indexes.sql`，内容：

```sql
-- messages 表：替换单列索引为复合索引
DROP INDEX IF EXISTS idx_messages_conversation_id;
CREATE INDEX idx_messages_conv_ts ON messages(conversation_id, timestamp);

-- message_blocks 表：复合索引覆盖 WHERE + ORDER BY
DROP INDEX IF EXISTS idx_message_blocks_message_id;
CREATE INDEX idx_message_blocks_msg_seq ON message_blocks(message_id, sequence);
```

- [ ] **Step 2: 用 sqlite-mcp 验证迁移可执行且无错误**

```bash
# 在 sqlite-mcp 中执行：
# 1. 先执行 DROP + CREATE，确认返回 'migration_ok'
# 2. EXPLAIN QUERY PLAN 确认 messages 表不再有 USE TEMP B-TREE FOR ORDER BY
# 3. EXPLAIN QUERY PLAN 确认 message_blocks 表不再有 USE TEMP B-TREE FOR ORDER BY
```

验证查询：

```sql
EXPLAIN QUERY PLAN SELECT id, role, timestamp, ended_at, metadata, llm_stats, is_partial
FROM messages WHERE conversation_id = 'conv-b2a3a389-41dc-4195-b209-a09d0f89dfec'
ORDER BY timestamp ASC;

EXPLAIN QUERY PLAN SELECT id, message_id, block_type, content, data, sequence, timestamp, ended_at
FROM message_blocks WHERE message_id IN (...)
ORDER BY message_id, sequence ASC;
```

预期：两个查询均只有 `SEARCH ... USING COVERING INDEX`，无 `USE TEMP B-TREE FOR ORDER BY`。

- [ ] **Step 3: Commit**

```bash
git add src/main/repositories/sqlite/migrations/034_message_indexes.sql
git commit -m "feat(db): composite indexes for messages (conv_id+ts) and message_blocks (msg_id+seq)"
```

---

### Task 2: Part A — execution.ts spread→push

**Files:**
- Modify: `src/main/agent/ipc/execution.ts:275-284`

**Interfaces:**
- Consumes: `conversationRepo.readMessages(convId)`, `convertedMessages`（现有变量）
- Produces: 不变 — `messages: AgentStartParams['messages']`（对 Worker 接口无变化）

- [ ] **Step 1: 替换 spread 为 push**

在 `execution.ts` 的 `agent-start` handler 中，找到第 276-285 行的 spread 表达式：

```typescript
// 改前（line 276-285）:
const messages: AgentStartParams['messages'] = [
    ...convertedMessages,
    {
        role: 'user' as const,
        content: userMessageContent,
        metadata: params.messageMetadata,
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
]
```

改为 push：

```typescript
// 改后:
const messages = convertedMessages as AgentStartParams['messages']
messages.push({
    role: 'user' as const,
    content: userMessageContent,
    metadata: params.messageMetadata,
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
})
```

**为什么**：改前 `[...convertedMessages, newMsg]` 创建第三个副本（Copy C），与 `history`（Copy A）和 `convertedMessages`（Copy B）三者同时存活直到 handler return。改后直接在 `convertedMessages` 上 push，消除 spread 副本——不需要时额外数组。`convertedMessages` 在 handler 末尾离开作用域，`messages` 传给 `agentManager.start()` → Worker structuredClone。

- [ ] **Step 2: 验证编译通过**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/main/agent/ipc/execution.ts
git commit -m "perf: eliminate spread copy in agent-start handler, push instead"
```

---

### Task 3: Part B — conversationStore 清理保护

**Files:**
- Modify: `src/renderer/stores/conversationStore.ts:1233-1256`

**Interfaces:**
- Consumes: `useAgentStore.getState().convAgentStates[id]`
- Produces: `keepIds` 过滤逻辑增强（不改变返回类型）

- [ ] **Step 1: 在 cleanupInactiveConversations 的 filter 中加入 Agent 状态保护**

在 `cleanupInactiveConversations` 方法中，找到 keepIds 的 filter 逻辑（line 1237-1241）：

```typescript
// 改前（line 1237-1241）:
const keepIds = state.renderedConversationIds.filter(id => {
    if (id === state.activeConversationId) return true
    const lastActive = state.conversationLastActiveAt[id] ?? 0
    return now - lastActive < TEN_MIN_MS
})
```

改为：

```typescript
// 改后:
const keepIds = state.renderedConversationIds.filter(id => {
    if (id === state.activeConversationId) return true
    // ★ Agent 保护：运行中或等待用户交互的会话不允许清理
    const agentConv = useAgentStore.getState().convAgentStates[id]
    if (agentConv?.agentState?.status === 'running' ||
        agentConv?.agentState?.status === 'thinking') return true
    if (agentConv?.pendingPermissionConfirm ||
        agentConv?.pendingQuestion) return true
    const lastActive = state.conversationLastActiveAt[id] ?? 0
    return now - lastActive < TEN_MIN_MS
})
```

**覆盖场景**：
- 子 Agent 后台运行中，主窗口切走超过 10 分钟 → 不清理
- 权限确认弹窗（`pendingPermissionConfirm`）等待用户响应 → 不清理
- `ask_user` 提问（`pendingQuestion`）等待用户回答 → 不清理
- 窗口最小化：`activeConversationId` 保护已在位，不受影响

- [ ] **Step 2: 验证编译通过**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/stores/conversationStore.ts
git commit -m "fix(store): protect running/pending-agent conversations from inactivity cleanup"
```

---

### Task 4: Part D — 死代码清理（compact 全链路）

**Files:**
- Modify: `src/main/agent/stream.ts`（删除 line 90-116）
- Modify: `src/main/agent/manager.impl.ts`（删除 line 460-469 + handleCompactPersist 方法 + 内联 doMergeAndPersist + 重写 import）
- Modify: `src/renderer/stores/agentStore/handlers/streamEvents.ts`（删除 compact case）
- Modify: `src/renderer/stores/agentStore/handlers/streamSystem.ts`（删除 compact handler 函数）
- Modify: `src/shared/types/events.ts`（删除 `context_compacted | compact_status`）
- Delete: `src/main/agent/manager.persister.ts`
- Delete: `src/main/agent/manager.backup.ts`

**Interfaces:**
- Consumes: 现有 compact_persist 全链路引用
- Produces: `doMergeAndPersist` 作为 `AgentManager` 的私有方法 `#mergeAndPersist()`

#### Task 4a: 删除 stream.ts 中的 compact 类型定义

- [ ] **Step 1: 删除 stream.ts line 90-116**

删除 `AgentStreamEvent` 类型中以下三个联合成员：

```typescript
// 删除:
| { type: 'context_compacted'; beforeTokens: number; ... }
| { type: 'compact_status'; compactStatus: 'waiting' | 'compacting' | 'completed' }
| { type: 'compact_persist'; messages: ChatMessage[]; ... }
| { type: 'compact_persisted'; beforeTokens: number; ... }
```

具体位置：`src/main/agent/stream.ts:90-116`。

- [ ] **Step 2: Commit**

```bash
git add src/main/agent/stream.ts
git commit -m "refactor: remove compact event types from AgentStreamEvent"
```

#### Task 4b: 删除 streamSystem.ts + streamEvents.ts 中的 compact handler

- [ ] **Step 1: 删除 streamSystem.ts 中的 compact handler 函数**

删除 `src/renderer/stores/agentStore/handlers/streamSystem.ts` 中的 `handleContextCompacted` 和 `handleCompactPersisted` 函数及导出。这两个函数位于文件中部，用 `grep "handleContextCompacted\|handleCompactPersisted"` 精确查找行号后删除。

- [ ] **Step 2: 删除 streamEvents.ts 中的 compact case**

删除 `src/renderer/stores/agentStore/handlers/streamEvents.ts` 中的 4 个 case 分支（约 line 84-87）：

```typescript
// 删除:
case 'context_compacted':      handleContextCompacted(ctx);        break
case 'compact_status':         handleCompactStatus(ctx);           break
case 'compact_persisted':      await handleCompactPersisted(ctx);  break
```

同时删除文件顶部对 `handleContextCompacted`、`handleCompactStatus`、`handleCompactPersisted` 的 import。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/stores/agentStore/handlers/streamSystem.ts src/renderer/stores/agentStore/handlers/streamEvents.ts
git commit -m "refactor: remove compact event handlers from streamSystem and streamEvents"
```

#### Task 4c: 删除 events.ts 中的 compact 枚举

- [ ] **Step 1: 删除 shared/types/events.ts line 81**

将第 81 行：

```typescript
    | 'context_compacted' | 'compact_status'
```

改为：

```typescript

```

（即删除该联合成员。注意保持前后联合类型的 `|` 连续。）

- [ ] **Step 2: 删除 shared/types/events.ts 中 compact_status 的注释块**

删除约 line 137 的注释 `// 压缩状态（compact_status）` 及相关内容。

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/events.ts
git commit -m "refactor: remove compact event enum values from shared types"
```

#### Task 4d: 内联 doMergeAndPersist + 删除 persister.ts + backup.ts

- [ ] **Step 1: 将 doMergeAndPersist 方法体复制到 manager.impl.ts**

在 `manager.impl.ts` 的 `AgentManager` 类中新增私有方法。将 `manager.persister.ts:102-221` 的 `doMergeAndPersist` 完整方法体粘贴进去，改为：

```typescript
private async #mergeAndPersist(
    conversationId: string,
    pending: PendingAssistantMsg | null | undefined,
    isFinal: boolean,
): Promise<void> {
    // [完整的 doMergeAndPersist 方法体，从 persister.ts:102-221 复制]
    // 保持不变：if (!pending) return; await import getDatabase; await import convRepo;
    // 保险丝检查 existingBlocks; messageToBlocks; existingLlmStats; TOCTOU 防护;
    // DELETE blocks; INSERT OR REPLACE messages; INSERT blocks; saveDatabase
    // 方法体 120 行，此处省略以节省篇幅——从 persister.ts 原样复制
}
```

然后更新类中 4 个调用点：将 `doMergeAndPersist(...)` 替换为 `this.#mergeAndPersist(...)`。调用点：
- line 408: `handleInjectedMessage` 内
- line 572: `handleDoneEvent` 内
- line 598: `handleErrorEvent` 内
- line 618: `handlePendingMessagesAfterExit` 内

- [ ] **Step 2: 删除 compact_persist 事件分发**

删除 `manager.impl.ts:460-469`（事件循环中 compact_persist 的分发逻辑）：

```typescript
// 删除 line 460-469:
// compact_persist 事件
if (event.type === 'compact_persist') {
    await this.handleCompactPersist(conversationId, event as {...})
    return
}
```

- [ ] **Step 3: 删除 handleCompactPersist 方法**

删除 `manager.impl.ts:535-563` 的 `handleCompactPersist` 方法体。

- [ ] **Step 4: 删除 import + 删除文件**

删除 `manager.impl.ts:37` 的 import：
```typescript
// 删除:
import {doMergeAndPersist} from './manager.persister'
```

删除 `manager.persister.ts` 和 `manager.backup.ts` 两个文件。

- [ ] **Step 5: 验证编译通过**

```bash
npx tsc --noEmit
```

确认无 "Module not found" 或其他编译错误。如有残留引用，用 grep 搜索 `persistCompactedMessages|doMergeAndPersist|manager.persister|manager.backup` 确认全部清理。

- [ ] **Step 6: Commit**

```bash
git rm src/main/agent/manager.persister.ts src/main/agent/manager.backup.ts
git add src/main/agent/manager.impl.ts
git commit -m "refactor: inline doMergeAndPersist, remove compact dead code (~230 lines)"
```

---

### Task 5: 全量验证

- [ ] **Step 1: TypeScript 编译**

```bash
npx tsc --noEmit
```

- [ ] **Step 2: 运行现有测试**

```bash
npm test
```

- [ ] **Step 3: 构建检查**

```bash
npm run build
```

- [ ] **Step 4: 手工验证（可选）**

启动应用，执行一次 Agent 对话，在 Chrome DevTools Performance 面板录制 Memory，对比改前峰值。

---

## Self-Review

1. **Spec coverage**: Part A (副本消除) → Task 2, Part B (清理保护) → Task 3, Part C (索引) → Task 1, Part D (死代码) → Task 4。全部覆盖。

2. **Placeholder scan**: 无 "TBD"、"TODO"、"add appropriate error handling" 等占位符。Task 4d 的 `#mergeAndPersist` 方法体标注了"从 persister.ts 原样复制"，指向明确来源。

3. **Type consistency**: `#mergeAndPersist` 参数签名与 `doMergeAndPersist` 一致。4 个调用点改为 `this.#mergeAndPersist(conversationId, pending, isFinal)`。
