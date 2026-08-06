# 消息持久化加固 & 内存优化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 缩小流式期间消息丢失窗口至 5s 以内，降低 SDD 场景单条 assistant 气泡的内存占用（子 Agent 流式事件限流 + 大工具结果截断），并引入 is_partial 标记支持崩溃后精确恢复。

**Architecture:** 渲染进程 throttle 驱动增量落库（第1个chunk立即写 + 2s/500字符阈值）→ 主进程 5s 心跳兜底纯文本窗口 → 每条心跳写入带 `is_partial=1` 标记 → 崩溃后 `buildMessagesFromRows` 检测标记 → 渲染层消除 thinking 僵尸状态。内存优化：子 Agent 流 500 条滑动窗口 + 工具结果 >5KB 落库后截断 + 会话权重兜底。

**Tech Stack:** TypeScript, Zustand, better-sqlite3, Electron IPC

## Global Constraints

- 不改动 MessageList 组件（不引入虚拟滚动）
- 不改动 messageToBlocks / blocksToMessage 序列化逻辑
- 不改动退出保存路径（before-quit → flush-save IPC）
- 不改动子会话持久化（isChildConversation 跳过）
- 不改动 switchActiveConversation 流式消息合并逻辑
- 迁移编号使用 033

---

### Task 1: Migration — messages 表增加 is_partial 列

**Files:**
- Create: `src/main/repositories/sqlite/migrations/033_message_partial.sql`

**Interfaces:**
- Consumes: (none)
- Produces: `messages.is_partial INTEGER NOT NULL DEFAULT 0` column

- [ ] **Step 1: Write migration SQL**

```sql
-- 033_message_partial.sql
ALTER TABLE messages ADD COLUMN is_partial INTEGER NOT NULL DEFAULT 0;

UPDATE messages SET is_partial = 0 WHERE is_partial IS NULL;
```

- [ ] **Step 2: Run migration to verify**

Run: `npx tsx -e "require('./src/main/repositories/sqlite').initDatabaseSync(); console.log('migration applied')"`
Expected: No error. 数据库文件在 WAL 模式下，列 `is_partial` 已添加。

- [ ] **Step 3: Commit**

```bash
git add src/main/repositories/sqlite/migrations/033_message_partial.sql
git commit -m "feat(migration): add is_partial column for crash recovery"
```

---

### Task 2: #3 — 子 Agent 流滑动窗口（500 条上限）

**Files:**
- Modify: `src/renderer/stores/toolCallsStore.ts:271-305`

**Interfaces:**
- Consumes: `SubAgentStreamEntry` interface (already exists at L38)
- Produces: `appendSubAgentStream` with 500-entry sliding window + truncation marker

- [ ] **Step 1: Add constant and rewrite appendSubAgentStream**

In `src/renderer/stores/toolCallsStore.ts`, replace the `appendSubAgentStream` block (L271-305):

```typescript
const MAX_SUBAGENT_STREAM_ENTRIES = 500

appendSubAgentStream: (toolCallId, entry) => {
    set((state) => {
        const existing = state.states[toolCallId] || {status: 'running' as const}
        const currentStream = existing.subAgentStream || []
        // 合并连续 text 条目：LLM token 级流式输出逐 token 到达，
        // 若上一个 entry 也是 text 类型，追加内容而非创建新 entry，避免单个词/字独占一行
        const lastEntry = currentStream.length > 0 ? currentStream[currentStream.length - 1] : undefined
        if (entry.type === 'text' && lastEntry?.type === 'text') {
            const merged = {
                ...lastEntry,
                content: (lastEntry.content || '') + (entry.content || ''),
            }
            const newStream = [...currentStream]
            newStream[newStream.length - 1] = merged
            return {
                states: {
                    ...state.states,
                    [toolCallId]: { ...existing, subAgentStream: newStream },
                },
            }
        }

        if (currentStream.length < MAX_SUBAGENT_STREAM_ENTRIES) {
            return {
                states: {
                    ...state.states,
                    [toolCallId]: {
                        ...existing,
                        subAgentStream: [...currentStream, entry],
                    },
                },
            }
        }

        // 达到上限：shift 头部 + push 尾部 + 首次截断插入标记
        const trimmed = currentStream.slice(-MAX_SUBAGENT_STREAM_ENTRIES + 1)
        const hasMarker = trimmed.some(e => e.type === 'text' && (e as any)._truncationMarker)
        const withEntry = hasMarker
            ? [...trimmed, entry]
            : [
                { type: 'text' as const, timestamp: Date.now(), content: '(已截断较早流式记录，仅保留最近 500 条)', _truncationMarker: true },
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

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | Select-String -Pattern "toolCallsStore" | Select-Object -First 10`
Expected: No errors matching toolCallsStore.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/stores/toolCallsStore.ts
git commit -m "feat(toolCallsStore): add subAgentStream sliding window (500 max entries)"
```

---

### Task 3: #1 — 流式 delta save debounce → throttle

**Files:**
- Modify: `src/renderer/stores/conversationStore.ts:85-183`

**Interfaces:**
- Consumes: `deltaTimers` (L91), `dirtyMessages` (L89), `markMessageDirty` (L141), `scheduleDeltaSave` (L149), `flushDirtyMessages` (L159)
- Produces: 替换 `deltaTimers` + `scheduleDeltaSave` 为 throttle 实现，新增 `deltaThrottle` 状态

- [ ] **Step 1: Replace deltaTimers with throttle state**

In `src/renderer/stores/conversationStore.ts` at L88-91, replace:

```typescript
/** 每会话的 dirty 消息 Map（messageId → Message），只增不减，flush 后清空 */
const dirtyMessages: Record<string, Map<string, Message>> = {}
/** 每会话的 delta 落库 debounce timer */
const deltaTimers: Record<string, ReturnType<typeof setTimeout> | null> = {}
```

With:

```typescript
/** 每会话的 dirty 消息 Map（messageId → Message），只增不减，flush 后清空 */
const dirtyMessages: Record<string, Map<string, Message>> = {}

/** Throttle state per conversation for delta save */
interface DeltaThrottleState {
    lastFlush: number
    accumulatedChars: number
    timer: ReturnType<typeof setTimeout> | null
}
const deltaThrottle: Record<string, DeltaThrottleState> = {}
```

- [ ] **Step 2: Replace markMessageDirty to track accumulated chars**

At L141-146, replace:

```typescript
function markMessageDirty(convId: string, message: Message) {
    if (isChildConversation(convId)) return
    getDirtyMap(convId).set(message.id, message)
    isDirty = true
}
```

With:

```typescript
function markMessageDirty(convId: string, message: Message) {
    if (isChildConversation(convId)) return
    getDirtyMap(convId).set(message.id, message)
    isDirty = true
    // 累积字符计数（text content + thinkContent）
    const chars = (message.content?.length ?? 0) + (message.thinkBlock?.content?.length ?? 0)
    const throttle = deltaThrottle[convId]
    if (throttle) {
        throttle.accumulatedChars += chars
    }
}
```

- [ ] **Step 3: Rewrite scheduleDeltaSave as throttle**

At L149-156, replace:

```typescript
function scheduleDeltaSave(convId: string, delay: number) {
    if (isChildConversation(convId)) return
    if (deltaTimers[convId]) clearTimeout(deltaTimers[convId]!)
    deltaTimers[convId] = setTimeout(() => {
        deltaTimers[convId] = null
        void flushDirtyMessages(convId)
    }, delay)
}
```

With:

```typescript
const THROTTLE_MS = 2000
const THROTTLE_CHAR_THRESHOLD = 500

function scheduleDeltaSave(convId: string, _delay: number) {
    if (isChildConversation(convId)) return
    let state = deltaThrottle[convId]
    if (!state) {
        state = { lastFlush: 0, accumulatedChars: 0, timer: null }
        deltaThrottle[convId] = state
    }

    const elapsed = Date.now() - state.lastFlush
    const shouldFlushNow = elapsed >= THROTTLE_MS || state.accumulatedChars >= THROTTLE_CHAR_THRESHOLD

    if (shouldFlushNow) {
        // 距上次写入超过 2s 或累积超过 500 字符 → 立即写
        if (state.timer) {
            clearTimeout(state.timer)
            state.timer = null
        }
        void flushDirtyMessages(convId)
        state.lastFlush = Date.now()
        state.accumulatedChars = 0
    } else if (!state.timer) {
        // 未到阈值 → 设兜底 timer（确保不会永远不写）
        state.timer = setTimeout(() => {
            void flushDirtyMessages(convId)
            state.lastFlush = Date.now()
            state.accumulatedChars = 0
            state.timer = null
        }, THROTTLE_MS - elapsed)
    }
}
```

- [ ] **Step 4: Update flushDirtyMessages to clear throttle state**

At L159-183, inside `flushDirtyMessages`, add throttle state cleanup before the `dirtyMap` check. Insert after L165 (`if (isChildConversation(convId))`) and before L170 (`const dirtyMap = dirtyMessages[convId]`):

```typescript
    // 清理 throttle 状态
    const throttleState = deltaThrottle[convId]
    if (throttleState?.timer) {
        clearTimeout(throttleState.timer)
    }
    delete deltaThrottle[convId]
```

And remove the existing `deltaTimers` cleanup at L166-169 (the old timer clearing pattern).

- [ ] **Step 5: Update cancelPendingSave to clear throttle state**

At L214-228, inside `cancelPendingSave`, replace the old delta timers cleanup:

Replace:
```typescript
    for (const convId of Object.keys(deltaTimers)) {
        if (deltaTimers[convId]) clearTimeout(deltaTimers[convId])
        deltaTimers[convId] = null
    }
```

With:
```typescript
    for (const convId of Object.keys(deltaThrottle)) {
        const ts = deltaThrottle[convId]
        if (ts?.timer) clearTimeout(ts.timer)
        delete deltaThrottle[convId]
    }
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | Select-String -Pattern "conversationStore" | Select-Object -First 10`
Expected: No errors matching conversationStore.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/stores/conversationStore.ts
git commit -m "feat(persistence): delta save debounce → throttle (2s or 500 chars)"
```

---

### Task 4: #4 — 工具结果内存截断

**Files:**
- Modify: `src/renderer/stores/conversationStore.ts`

**Interfaces:**
- Consumes: `flushDirtyMessages` (from Task 3), `Message` type
- Produces: `truncateLargeResults(message: Message): Message`

- [ ] **Step 1: Add truncation function and constant**

Add after the `flushDirtyMessages` function definition (after L183), before `persistMessages`:

```typescript
const TOOL_RESULT_MEMORY_CAP = 5000

/** 截断 message 中大型工具结果的内存副本，完整内容已通过 flushDirtyMessages 落库 */
function truncateLargeResults(message: Message): Message {
    if (!message.toolCalls || message.toolCalls.length === 0) return message
    let modified = false
    const truncated = message.toolCalls.map(tc => {
        if (!tc.result || typeof tc.result.output !== 'string') return tc
        if (tc.result.output.length <= TOOL_RESULT_MEMORY_CAP) return tc
        modified = true
        return {
            ...tc,
            result: {
                ...tc.result,
                _fullOutputStored: true as any,
                _outputTruncatedLength: tc.result.output.length as any,
                output: tc.result.output.slice(0, TOOL_RESULT_MEMORY_CAP)
                    + '\n\n*(输出过长，已截断。展开加载完整内容)*',
            },
        }
    })
    return modified ? { ...message, toolCalls: truncated } : message
}
```

- [ ] **Step 2: Hook truncation into flushDirtyMessages**

在 `flushDirtyMessages` (L159-183) 中，**修改** dirtyMap 清理位置并在写入循环后加截断。

（修正：原方案在写入循环后引用 `dirtyMap.has(m.id)`，但 `dirtyMap.clear()` 在 L173 已执行，has() 恒为 false → 截断永不触发。改为在 clear 前保存 `pendingIds`。）

**修改 a)**：在 L172 (`const pending = [...dirtyMap.values()]`) 之后、L173 (`dirtyMap.clear()`) 之前，插入：

```typescript
    // 保存本次写入的消息 ID 集合（dirtyMap 随后被 clear，截断判断需用此集合）
    const pendingIds = new Set(pending.map(p => p.id))
```

**修改 b)**：在写入循环之后（L177-179 的 for 循环结束后），插入：

```typescript
        // 截断大型工具结果的内存副本（完整内容已落库）
        const store = useConversationStore.getState()
        const msgs = store.messagesMap[convId]
        if (msgs) {
            let needsUpdate = false
            const newMsgs = msgs.map(m => {
                if (!pendingIds.has(m.id)) return m
                const truncated = truncateLargeResults(m)
                if (truncated !== m) needsUpdate = true
                return truncated
            })
            if (needsUpdate) {
                useConversationStore.setState({
                    messagesMap: { ...store.messagesMap, [convId]: newMsgs },
                    loadedMessages: convId === store.activeConversationId ? newMsgs : store.loadedMessages,
                })
            }
        }
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | Select-String -Pattern "conversationStore" | Select-Object -First 10`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/stores/conversationStore.ts
git commit -m "feat(persistence): truncate large tool results in memory after flush"
```

---

### Task 5: #2 — 主进程心跳落库 + is_partial

**Files:**
- Modify: `src/main/agent/manager.impl.ts:50-58` (class fields), `src/main/agent/manager.impl.ts:402-486` (handleStreamEvent)
- Modify: `src/main/agent/manager.persister.ts:102-180` (doMergeAndPersist)

**Interfaces:**
- Consumes: `doMergeAndPersist(convId, pending, isFinal)` (existing), `PendingAssistantMsg` (existing)
- Produces: `heartbeatTimers: Map<string, NodeJS.Timeout>`, `lastPersistedHash: Map<string, string>`, updated `doMergeAndPersist` with `is_partial` column

- [ ] **Step 1: Add heartbeat fields to AgentManager class**

In `src/main/agent/manager.impl.ts`, after L56 (after `pendingNeedsTurnReset` field), add:

```typescript
  /** 心跳落库 timer（纯文本 streaming 期间每 5s 的兜底落库，防崩溃丢消息） */
  private heartbeatTimers: Map<string, ReturnType<typeof setInterval>> = new Map()
  /** 上次心跳落库的内容 hash（去重用） */
  private lastPersistedHash: Map<string, string> = new Map()
```

- [ ] **Step 2: Add startHeartbeat / clearHeartbeat helper methods**

Add after the `handleStreamEvent` method (after L486), before `postChannelResult`:

```typescript
  private startHeartbeat(conversationId: string): void {
    if (this.heartbeatTimers.has(conversationId)) return
    const timer = setInterval(async () => {
      const pending = this.pendingAssistantMsg.get(conversationId)
      if (!pending) return
      const hash = `${pending.content ?? ''}|${pending.thinkContent ?? ''}`
      if (hash === this.lastPersistedHash.get(conversationId)) return
      try {
        await doMergeAndPersist(conversationId, pending, false)
        this.lastPersistedHash.set(conversationId, hash)
      } catch (err) {
        logger.error('[AgentManager] heartbeat persist failed', { error: err, conversationId })
      }
    }, 5000)
    this.heartbeatTimers.set(conversationId, timer)
  }

  private clearHeartbeat(conversationId: string): void {
    const timer = this.heartbeatTimers.get(conversationId)
    if (timer) {
      clearInterval(timer)
      this.heartbeatTimers.delete(conversationId)
    }
    this.lastPersistedHash.delete(conversationId)
  }
```

- [ ] **Step 3: Wire heartbeat into handleStreamEvent**

In `handleStreamEvent` (L403):

a) **Start heartbeat on text/thinking**: After L425 (`this.accumulateEvent` call), add:
```typescript
    // 启动心跳落库（text/thinking chunk 到达时启动 5s 间隔兜底落库）
    if (event.type === 'text' || event.type === 'thinking') {
      this.startHeartbeat(conversationId)
    }
```

b) **Clear heartbeat on llm_call_done event**（修正：只清心跳，不做 final 落库——llm_call_done 只是单轮 LLM 调用结束，Agent 循环可能继续工具执行和后续轮次，isFinal=true 会提前写 endedAt 并误判 is_partial=0。文本流期间心跳已每 5s 覆盖落库，工具结果由渲染端 delta save 负责，最终 done/error 才 isFinal=true）: At L453-458 (inside `if (event.type === 'llm_call_done')`), BEFORE the existing `this.logLlmCall` line, add:
```typescript
      this.clearHeartbeat(conversationId)
```

- [ ] **Step 4: Clear heartbeat on done/error/abort**

In `handleDoneEvent` (L567), before `await doMergeAndPersist`, add:
```typescript
    this.clearHeartbeat(conversationId)
```

In `handleErrorEvent` (L596), before `await doMergeAndPersist`, add:
```typescript
    this.clearHeartbeat(conversationId)
```

In the abort path (`abort` method), find where the worker is terminated and add heartbeat cleanup. The `abort` method should be in the same file — locate it and add:
```typescript
    this.clearHeartbeat(conversationId)
```
before the worker termination block.

- [ ] **Step 5: Update doMergeAndPersist to set is_partial**

In `src/main/agent/manager.persister.ts`, in `doMergeAndPersist` (L147), change the INSERT SQL from:

```
'INSERT OR REPLACE INTO messages (id, conversation_id, role, timestamp, ended_at, metadata, llm_stats) VALUES (?, ?, ?, ?, ?, ?, ?)'
```

To include `is_partial`:

```
'INSERT OR REPLACE INTO messages (id, conversation_id, role, timestamp, ended_at, metadata, llm_stats, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
```

And add `isFinal ? 0 : 1` as the last parameter. The full call becomes:

```typescript
    db.prepare(
      'INSERT OR REPLACE INTO messages (id, conversation_id, role, timestamp, ended_at, metadata, llm_stats, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      msgRecord.id,
      conversationId,
      msgRecord.role,
      msgRecord.timestamp,
      msgRecord.endedAt ?? null,
      JSON.stringify(msgRecord.metadata),
      existingLlmStats ?? null,
      isFinal ? 0 : 1,
    )
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | Select-String -Pattern "manager\.(impl|persister)" | Select-Object -First 10`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/agent/manager.impl.ts src/main/agent/manager.persister.ts
git commit -m "feat(persistence): main process heartbeat persist with is_partial flag"
```

---

### Task 6: #2 — 崩溃恢复：buildMessagesFromRows 读取 is_partial

**Files:**
- Modify: `src/main/repositories/sqlite/conversationRepository.ts:280-328`

**Interfaces:**
- Consumes: `messages.is_partial` column (from Task 1 migration), `Message` type
- Produces: messages with `metadata._partialRecovery = true` for is_partial=1 rows

- [ ] **Step 1: Update msgRowType to include is_partial**

In `src/main/repositories/sqlite/conversationRepository.ts` at L281-284, update:

```typescript
    private readonly msgRowType = null as unknown as {
        id: string; role: string; timestamp: number;
        ended_at: number | null; metadata: string | null; llm_stats: string | null;
        is_partial: number;
    }
```

- [ ] **Step 2: Update all SELECT queries to include is_partial**

In `readMessages` (L95), change SELECT to include `is_partial`:

```sql
SELECT id, role, timestamp, ended_at, metadata, llm_stats, is_partial FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC
```

In `readMessagesTail` (L339), change:

```sql
SELECT id, role, timestamp, ended_at, metadata, llm_stats, is_partial FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?
```

In `readMessagesBefore` (L362), change:

```sql
SELECT id, role, timestamp, ended_at, metadata, llm_stats, is_partial FROM messages WHERE conversation_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?
```

- [ ] **Step 3: Handle is_partial in buildMessagesFromRows**

（修正：恢复判定改为 `is_partial === 1 || (assistant && ended_at == null)`。理由：渲染端 writeMessagesDelta 的 INSERT 不带 is_partial（默认 0），崩溃瞬间最后写入者大概率是渲染端 delta（2s 频率 > 心跳 5s），若仅凭 is_partial 判定会漏标 → UI 显示进行中僵尸动画。ended_at 是"完成"权威信号。副作用：历史存量中 601 条渲染端写入但主进程 final persist 缺失的 assistant 消息（内容完整、无 end block）也会被标记——显示为完成态而非动画态，对用户无实际影响。）

In `buildMessagesFromRows` (L307-327), after constructing the `message` object and before calling `blocksToMessage`, add:

In the `return msgRows.map(row => {` block, after L312 (`content: role === 'assistant' ? '' : (metadata.content || ''), ...metadata,`), add:

```typescript
            // 标记崩溃恢复的未完成消息：
            // is_partial=1（主进程心跳写入未 final）或 assistant 消息无 ended_at（渲染端 delta 最后写入但未完成）
            if (role === 'assistant' && (row.is_partial === 1 || row.ended_at == null)) {
                message.metadata = { ...message.metadata, _partialRecovery: true }
            }
```

- [ ] **Step 4: Verify TypeScript and SQL compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | Select-String -Pattern "conversationRepository" | Select-Object -First 5`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/repositories/sqlite/conversationRepository.ts
git commit -m "feat(recovery): detect is_partial messages on crash recovery"
```

---

### Task 7: #5 — 单会话内存权重上限（兜底）

**Files:**
- Modify: `src/renderer/stores/conversationStore.ts`

**Interfaces:**
- Consumes: `messagesMap`, `hasMoreMap`, `flushDirtyMessages`
- Produces: `maybeTrimConversation(convId)` function, called after `addMessageToConv` / `updateMessageForConv`

- [ ] **Step 1: Add weight computation and trim logic**

Add after the `truncateLargeResults` function (from Task 4), before `persistMessages`:

```typescript
const CONVERSATION_WEIGHT_CAP = 500

function computeMessageWeight(msg: Message): number {
    let w = 1
    w += (msg.contentBlocks?.length ?? 0)
    if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
            if (tc.result?.output && tc.result.output.length > 1000) {
                w += 5
            }
        }
    }
    return w
}

function maybeTrimConversation(convId: string): void {
    const store = useConversationStore.getState()
    const msgs = store.messagesMap[convId]
    if (!msgs || convId === store.activeConversationId) return
    const totalWeight = msgs.reduce((sum, m) => sum + computeMessageWeight(m), 0)
    if (totalWeight <= CONVERSATION_WEIGHT_CAP) return

    // 先 flush dirty
    const dirtyMap = dirtyMessages[convId]
    if (dirtyMap && dirtyMap.size > 0) {
        // 异步 flush 后再 trim
        void flushDirtyMessages(convId)
    }

    // Evict 最旧的 30% 消息
    const evictCount = Math.max(1, Math.floor(msgs.length * 0.3))
    const evicted = msgs.slice(0, evictCount)
    const kept = msgs.slice(evictCount)

    useConversationStore.setState({
        messagesMap: { ...store.messagesMap, [convId]: kept },
        hasMoreMap: { ...store.hasMoreMap, [convId]: true },
    })

    // 清理被 evict 消息的 dirty 标记
    if (dirtyMessages[convId]) {
        const evictIds = new Set(evicted.map(m => m.id))
        for (const id of evictIds) {
            dirtyMessages[convId]?.delete(id)
        }
    }
}
```

- [ ] **Step 2: Wire maybeTrimConversation into addMessageToConv and updateMessageForConv**

In the `addMessageToConv` implementation (L593-594), after the existing `markMessageDirty` + `scheduleDeltaSave` calls, add:

```typescript
    // 异步检查内存权重上限（不阻塞当前操作）
    setTimeout(() => maybeTrimConversation(convId), 0)
```

In the `updateMessageForConv` implementation (L609-610), add the same:

```typescript
    setTimeout(() => maybeTrimConversation(convId), 0)
```

Note: The exact locations of these calls are at the end of `addMessageToConv` and `updateMessageForConv` within the store creator. These are the lines immediately after `scheduleDeltaSave(convId, 2000)` and `scheduleDeltaSave(convId, 1000)` respectively.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | Select-String -Pattern "conversationStore" | Select-Object -First 5`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/stores/conversationStore.ts
git commit -m "feat(memory): conversation weight cap with LRU eviction (500 limit)"
```

---

### Task 8: 集成验证

**无代码变更。** 验证整个链路。

- [ ] **Step 1: 全量 TypeScript 编译检查**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: 现有测试回归**

Run: `npm test 2>&1 | Select-Object -Last 20`
Expected: All existing tests pass (no regressions).

- [ ] **Step 3: 手动验证清单**

1. 启动应用，创建新会话
2. 发送一条消息，让 Agent 执行 SDD 流程（含多轮工具调用 + 子 Agent）
3. 观察：
   - 助手气泡不会重复（ID 稳定不变）
   - 子 Agent 流展开卡片正常渲染，无截断异常
   - 工具输出 >5KB 时截断标记可见
4. 在 streaming 过程中强制结束进程（`taskkill /f /im hclaw.exe`）
5. 重启应用，进入同一会话：
   - 崩溃前的消息已恢复（含 `is_partial` 心跳写入的部分）
   - `is_partial=1` 的消息不显示 thinking 动画（thinkBlock status 为 'complete'）
   - 无僵尸气泡

- [ ] **Step 4: Commit verification notes**

```bash
git commit --allow-empty -m "chore: integration verification passed for persistence hardening"
```
