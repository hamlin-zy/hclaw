# 消息持久化加固 & 内存优化 设计文档

## 动机

- **流式期间消息丢失**：纯文本 streaming 期间 debounce timer 被高频 chunk 不断重置，delta save 可能长时间不触发；主进程仅在 `llm_call_done` / `done` / `error` 落库，期间崩溃全部丢失。
- **内存持续增长**：SDD 流程场景下，单条 assistant 气泡包含大量 `contentBlocks`（思考块、工具调用结果 200KB+、子 Agent 流式事件 300-600 条），并行 agent 工具时峰值内存可达数十 MB。
- **崩溃恢复不完整**：恢复仅依赖 SQLite 快照，丢失从上次 `doMergeAndPersist` 到崩溃时刻之间的全部内容。

## 优先级

| # | 改动 | 目标 |
|---|------|------|
| 1 | 流式 delta save debounce→throttle + 字符阈值 | 缩小纯文本 streaming 丢失窗口 |
| 2 | 主进程心跳落库 + `is_partial` DB 标记 | 确保 streaming 期间最多丢失 5s 内容，崩溃后准确标记未完成消息 |
| 3 | 子 Agent 流滑动窗口（500 条上限） | SDD 场景即时内存收益（最大头） |
| 4 | 工具结果内存截断（>5KB 落库后换 stub） | 批次编译输出等大结果不再驻留内存 |
| 5 | 单会话内存权重上限（兜底） | 防止极端场景 OOM |

## #1 流式持久化 throttle 改造

**文件**：`src/renderer/stores/conversationStore.ts`

**核心变更**：`scheduleDeltaSave` 从 debounce 改为 throttle。

```
当前：clearTimeout → setTimeout(2000)  ← 高频 chunk 永远不触发
改为：首次立即写（0ms）→ 后续 ≥2s 间隔 → 500 字符累积阈值触发
```

**实现**：

```typescript
// 每会话 throttle 状态
const deltaThrottle: Record<string, { lastFlush: number; accumulatedChars: number; timer: Timer | null }> = {}

function scheduleDeltaSave(convId: string, delay: number) {
  if (isChildConversation(convId)) return
  const state = deltaThrottle[convId] ?? { lastFlush: 0, accumulatedChars: 0, timer: null }
  deltaThrottle[convId] = state

  const elapsed = Date.now() - state.lastFlush
  const THROTTLE_MS = 2000

  if (elapsed >= THROTTLE_MS) {
    // 距上次写入超过 2s → 立即写
    clearTimer(state)
    void flushDirtyMessages(convId)
    state.lastFlush = Date.now()
    state.accumulatedChars = 0
  } else if (state.accumulatedChars >= 500) {
    // 累积超过 500 字符 → 强制写入
    clearTimer(state)
    void flushDirtyMessages(convId)
    state.lastFlush = Date.now()
    state.accumulatedChars = 0
  } else {
    // 未到阈值 → 设兜底 timer（确保不会永远不写）
    clearTimer(state)
    state.timer = setTimeout(() => {
      void flushDirtyMessages(convId)
      state.lastFlush = Date.now()
      state.accumulatedChars = 0
      state.timer = null
    }, THROTTLE_MS - elapsed)
  }
}
```

**字符计数**：`markMessageDirty` 中按 `message.content.length + (thinkBlock?.content?.length ?? 0)` 累加。

**行为**：
- 流式 text chunk 到达 → 第 1 个 chunk 立即写（首次 `elapsed=∞ > 2s`）
- 后续 chunk → 每 2s 或每 500 字符写一次
- 最坏丢失窗口：2s（vs 原来的整个 LLM 响应时长）

---

## #2 主进程心跳落库 + is_partial 标记

**文件**：
- `src/main/repositories/sqlite/migrations/033_message_partial.sql`（新增）
- `src/main/agent/manager.impl.ts`
- `src/main/agent/manager.persister.ts`
- `src/main/repositories/sqlite/conversationRepository.ts`

### 2.1 Migration

```sql
ALTER TABLE messages ADD COLUMN is_partial INTEGER NOT NULL DEFAULT 0;

-- 存量数据：所有已存在的消息视为完整消息
UPDATE messages SET is_partial = 0 WHERE is_partial IS NULL;
```

### 2.2 主进程心跳

在 `manager.impl.ts` 的 `handleStreamEvent` 中：

- **启动**：首次收到 `text` / `thinking` 事件时启动 5s 间隔心跳 timer
- **心跳逻辑**：调用 `doMergeAndPersist(convId, pending, false)`（`isFinal=false` → `is_partial=1`，`endedAt=null`）
- **去重**：比较 `pending.content + pending.thinkContent` 的 hash，无变化则跳过本次写入
- **清理**：`llm_call_done` / `done` / `error` → 清除 timer → `doMergeAndPersist(isFinal=true)` → `is_partial=0`
- **abort**：清除 timer + 最终落库

```
// 伪代码
private heartbeatTimers: Map<string, Timer> = new Map()
private lastPersistedHash: Map<string, string> = new Map()

on text/thinking event:
  startHeartbeat(conversationId)

on llm_call_done:
  clearHeartbeat(conversationId)
  await doMergeAndPersist(conversationId, pending, true)

startHeartbeat(convId):
  if timer exists: return  // 已启动
  timer = setInterval(async () => {
    const hash = hashPending(pending)
    if (hash === lastPersistedHash.get(convId)) return
    await doMergeAndPersist(convId, pending, false)
    lastPersistedHash.set(convId, hash)
  }, 5000)
```

### 2.3 `doMergeAndPersist` 扩展

新增参数 `isFinal: boolean`（已有），行为：
- `isFinal=false` → `is_partial=1`，`endedAt=NULL`
- `isFinal=true` → `is_partial=0`，`endedAt=now()`（现有行为）

### 2.4 崩溃恢复

`buildMessagesFromRows` 读取 `is_partial` 列：
- `is_partial=1` → 在 Message 对象上标记 `metadata._partialRecovery = true`
- 渲染层检测此标记：思考块固定显示为 `'complete'`（不闪烁），文本正常渲染

**行为**：
- streaming 期间最多丢失 5s 内容（心跳间隔）
- 崩溃后恢复能看到被心跳写入的部分内容
- 未完成消息有明确标记，不会出现"卡在 thinking 动画"的僵尸气泡

---

## #3 子 Agent 流滑动窗口

**文件**：`src/renderer/stores/toolCallsStore.ts`

**核心变更**：`appendSubAgentStream` 限制单工具流条目上限。

```typescript
const MAX_SUBAGENT_STREAM_ENTRIES = 500

appendSubAgentStream: (toolCallId, entry) => {
    set((state) => {
        const existing = state.states[toolCallId]
        if (!existing) return {}
        const currentStream = existing.subAgentStream || []

        if (currentStream.length < MAX_SUBAGENT_STREAM_ENTRIES) {
            return {
                states: {
                    ...state.states,
                    [toolCallId]: { ...existing, subAgentStream: [...currentStream, entry] },
                },
            }
        }

        // 达到上限：shift 头部 + push 尾部 + 首次截断插入标记
        const trimmed = currentStream.slice(-MAX_SUBAGENT_STREAM_ENTRIES + 1)
        const hasMarker = trimmed.some(e => e.type === 'text' && e._truncationMarker)
        const withEntry = hasMarker
            ? [...trimmed, entry]
            : [
                { type: 'text' as const, timestamp: Date.now(), content: '(已截断较早流式记录)', _truncationMarker: true },
                ...trimmed,
                entry,
              ]
        return {
            states: {
                ...state.states,
                [toolCallId]: { ...existing, subAgentStream: withEntry },
            },
        }
    })
},
```

**行为**：
- 单工具最多保留最近 500 条流事件
- 首次截断时插入一条提示标记
- 完整内容仍在 SQLite `message_blocks` 中（`doMergeAndPersist` 写入的 block 不受影响）
- `mergeTimeline` 和 `StreamEntryRenderer` 渲染逻辑不变

---

## #4 工具结果内存截断

**文件**：`src/renderer/stores/conversationStore.ts`

**核心变更**：增量落库完成后，将大型工具结果的内存副本替换为 stub。

```typescript
const TOOL_RESULT_MEMORY_CAP = 5000  // 字符数

function truncateLargeResults(message: Message): Message {
  if (!message.toolCalls) return message
  const truncated = message.toolCalls.map(tc => {
    if (!tc.result || typeof tc.result.output !== 'string') return tc
    if (tc.result.output.length <= TOOL_RESULT_MEMORY_CAP) return tc
    return {
      ...tc,
      result: {
        ...tc.result,
        _fullOutputStored: true,
        _outputTruncatedLength: tc.result.output.length,
        output: tc.result.output.slice(0, TOOL_RESULT_MEMORY_CAP)
          + '\n\n(输出过长，已截断。展开加载完整内容)',
      },
    }
  })
  return { ...message, toolCalls: truncated }
}
```

**触发时机**：`flushDirtyMessages` 完成后立即调用 `truncateLargeResults`。

**UI 响应**：`ToolCallBody` 检测 `result._fullOutputStored` → 显示"展开完整输出"按钮 → 从 SQLite 按需读取。

**行为**：
- 200KB 编译结果 → 内存中只保留 5KB 预览 + 标记
- 用户点击展开 → 从 DB 读取完整内容
- 不影响增量落库（落库走 `messageToBlocks`，其中 `tool_result` block 的 `data` 字段存的是完整结果）

---

## #5 单会话内存权重上限（兜底）

**文件**：`src/renderer/stores/conversationStore.ts`

```typescript
const CONVERSATION_WEIGHT_CAP = 500

function computeMessageWeight(msg: Message): number {
  let w = 1  // 基础权重
  w += (msg.contentBlocks?.length ?? 0)
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      if (tc.result?.output && tc.result.output.length > 1000) w += 5
    }
  }
  return w
}

function maybeTrimConversation(convId: string): void {
  const msgs = messagesMap[convId]
  if (!msgs) return
  const totalWeight = msgs.reduce((sum, m) => sum + computeMessageWeight(m), 0)
  if (totalWeight <= CONVERSATION_WEIGHT_CAP) return

  // flush → evict 最旧的 30% 消息 → mark hasMore
  // (具体逻辑同原 #3 降级方案)
}
```

`maybeTrimConversation` 在 `addMessageToConv` / `updateMessageForConv` 之后异步调用。

**行为**：
- 常规多轮对话不触发（权重累计慢）
- SDD 场景（一条消息权重可能 50-100）可能触发，但 evict 的是最旧消息而非当前活动消息
- 兜底性质，防止极端 OOM

---

## 不改动/不受影响的部分

- `MessageList` 组件：不引入虚拟滚动，渲染逻辑不变
- `messageToBlocks` / `blocksToMessage`：序列化/反序列化逻辑不变
- `saveMessages` / `flushDirtyMessages`：落库路径不变（仅触发时机改变）
- 退出保存路径（`before-quit` → `flush-save` IPC）：不变
- 子会话持久化（`isChildConversation` 跳过）：不变
- `switchActiveConversation` 的流式消息合并逻辑：不变

## 涉及文件清单

| 文件 | # | 预计变更行数 |
|------|---|-------------|
| `src/renderer/stores/conversationStore.ts` | #1, #4, #5 | ~120 |
| `src/renderer/stores/toolCallsStore.ts` | #3 | ~30 |
| `src/main/agent/manager.impl.ts` | #2 | ~60 |
| `src/main/agent/manager.persister.ts` | #2 | ~20 |
| `src/main/repositories/sqlite/conversationRepository.ts` | #2 | ~15 |
| `src/main/repositories/sqlite/migrations/0XX-message-partial.sql` | #2 | 3 |
