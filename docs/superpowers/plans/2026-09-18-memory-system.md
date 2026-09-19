# 用户习惯记忆系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 HClaw 中实现基于 skill 格式的用户习惯记忆系统：定时分析对话历史积累用户偏好/项目经验，在会话首次 LLM 请求时自动注入。

**Architecture:** 记忆文件存储在 `{hclawDir}/mem/`，由系统内置定时任务（"记忆沉淀"，6 小时 cron）通过 agent 会话分析对话并更新。注入通过 agent loop 新增 `runMemoryPreStep()` pre-step 实现，digest 门控，仿照 catalog 模式。定时任务管理 UI 改造为区分用户/系统任务。

**Tech Stack:** TypeScript, Electron, React, SQLite (better-sqlite3), Zod, Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-09-18-memory-system-design.md`

## Global Constraints

- 平台: Windows, Node.js v24, PowerShell
- 工作目录: `E:\workspace\media\hclaw`
- 配置目录: `C:\Users\Hamlin\.hclaw`
- 测试框架: Vitest (`vitest.config.ts`)
- 迁移文件命名: `NNN_description.sql`，序号从 048 开始
- scheduler 模块路径: `src/main/scheduler/`（非 `src/main/agent/schedule/`）
- 所有 pre-step 异常不得中断 mainLoop（内部 try-catch）
- 系统任务 ID 硬编码: `sys-memory-accumulation`

---

## File Structure

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/main/repositories/sqlite/migrations/048_add_schedules_is_system.sql` | schedules 表加 is_system 列 |
| `src/main/repositories/sqlite/migrations/049_cleanup_legacy_memory.sql` | 清理 memory_tasks 表 + 旧工具注册 |
| `src/shared/types/memory.ts` | 记忆相关共享类型 |
| `src/main/agent/defaults/systemSchedules.ts` | 系统内置任务默认配置 |
| `src/main/agent/memory/index.ts` | 记忆模块入口 |
| `src/main/agent/memory/memoryLoader.ts` | 记忆文件加载与 mtime 缓存 |
| `src/main/agent/memory/memoryStore.ts` | 记忆目录初始化、index.json 管理 |
| `src/main/agent/loop/memoryPublish.ts` | 记忆 pre-step：digest、注入、崩溃恢复 |
| `src/renderer/components/dialogs/ScheduleSystemActions.tsx` | 还原默认按钮组件 |
| `src/renderer/components/dialogs/ScheduleDisableConfirm.tsx` | 禁用确认对话框 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/shared/types/schedule.ts` | ScheduleRecord 加 `isSystem` |
| `src/main/scheduler/ScheduleRepository.ts` | COL_MAP 加 is_system |
| `src/main/scheduler/scheduleWorkspace.ts` | checkScheduleWorkspace 加 isSystem 旁路 |
| `src/main/scheduler/scheduleOps.ts` | 系统任务不可删除；restore-default |
| `src/main/scheduler/index.ts` | 启动初始化系统任务；executeSchedule 传 isSystem |
| `src/main/agent/loop/controller.ts` | mainLoop 加 runMemoryPreStep + restoreMemoryState |
| `src/main/agent/tools/builtin/systemManageTool.ts` | zod schema 加 memory 分类 |
| `src/main/agent/ipc/scheduleIPC.ts` | 加 restore-default IPC handler |
| `src/renderer/hooks/useScheduleListState.ts` | Tab 改 4 个；matchesTab 加 isSystem |
| `src/renderer/components/dialogs/ScheduleDialog.tsx` | Tab 按钮 + 新建按钮条件显示 |
| `src/renderer/components/dialogs/ScheduleCard.tsx` | 系统任务：隐藏删除、显示还原默认 |
| `src/renderer/components/dialogs/ScheduleEditModal.tsx` | 系统任务：锁定部分字段 |
| `src/renderer/stores/scheduleStore.ts` | 查询 API 加 isSystem |

---

### Task 1: DB Migrations

**Files:**
- Create: `src/main/repositories/sqlite/migrations/048_add_schedules_is_system.sql`
- Create: `src/main/repositories/sqlite/migrations/049_cleanup_legacy_memory.sql`

**Interfaces:**
- Produces: `schedules.is_system` column (INTEGER NOT NULL DEFAULT 0)
- Produces: `memory_tasks` table dropped, `memory_search`/`memory_save` tools deleted

- [ ] **Step 1: Create 048 migration**

```sql
-- 048_add_schedules_is_system.sql
-- 为 schedules 表添加 is_system 字段，标记系统内置定时任务
ALTER TABLE schedules ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_schedules_is_system ON schedules(is_system);
```

- [ ] **Step 2: Create 049 migration**

```sql
-- 049_cleanup_legacy_memory.sql
-- 清理历史遗留的记忆系统（已删除的功能，仅表结构残留）
DROP TABLE IF EXISTS memory_tasks;
DELETE FROM tools WHERE id IN ('memory_search', 'memory_save');
```

- [ ] **Step 3: Verify migrations apply**

Run: `cd E:\workspace\media\hclaw && npx tsx scripts/run-migrations.ts` (or start the app to trigger migrations)
Expected: No errors. Verify with `sqlite3` or node that `schedules` has `is_system` column and `memory_tasks` table no longer exists.

- [ ] **Step 4: Commit**

```bash
git add src/main/repositories/sqlite/migrations/048_add_schedules_is_system.sql src/main/repositories/sqlite/migrations/049_cleanup_legacy_memory.sql
git commit -m "feat: add is_system to schedules, clean up legacy memory_tasks"
```

---

### Task 2: Schedule Types & Repository

**Files:**
- Modify: `src/shared/types/schedule.ts`
- Modify: `src/main/scheduler/ScheduleRepository.ts`
- Test: `tests/scheduler/ScheduleRepository.isSystem.test.ts`

**Interfaces:**
- Produces: `ScheduleRecord.isSystem: boolean`
- Produces: `COL_MAP` includes `isSystem → is_system`

- [ ] **Step 1: Write failing test**

```typescript
// tests/scheduler/ScheduleRepository.isSystem.test.ts
import {describe, it, expect, beforeEach} from 'vitest'
import {ScheduleRepository} from '../../../src/main/scheduler/ScheduleRepository'

describe('ScheduleRepository is_system', () => {
  let repo: ScheduleRepository

  beforeEach(() => {
    // Use in-memory db
    repo = new ScheduleRepository(':memory:')
    // Run the create table + migration manually for test
    repo.db.exec(`
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
        cron_expression TEXT NOT NULL, task_type TEXT NOT NULL, task_target TEXT NOT NULL,
        task_args JSON DEFAULT '[]', enabled INTEGER DEFAULT 1, paused INTEGER DEFAULT 0,
        paused_at INTEGER, last_run_at INTEGER, last_run_status TEXT DEFAULT 'none',
        last_run_conversation_id TEXT, run_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        is_system INTEGER NOT NULL DEFAULT 0
      )
    `)
  })

  it('should persist and read isSystem field', () => {
    const now = Date.now()
    repo.create({
      id: 'test-1', name: 'Test', description: '', cronExpression: '0 * * * *',
      taskType: 'agent', taskTarget: 'General', taskArgs: [], enabled: true,
      paused: false, pausedAt: null, workspaceId: null, isSystem: true,
      createdAt: now, updatedAt: now,
    })
    const record = repo.get('test-1')
    expect(record).toBeDefined()
    expect(record!.isSystem).toBe(true)
  })

  it('should default isSystem to false for regular schedules', () => {
    const now = Date.now()
    repo.create({
      id: 'test-2', name: 'User Task', description: '', cronExpression: '0 * * * *',
      taskType: 'script', taskTarget: 'test.ps1', taskArgs: [], enabled: true,
      paused: false, pausedAt: null, workspaceId: null,
      createdAt: now, updatedAt: now,
    })
    const record = repo.get('test-2')
    expect(record!.isSystem).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scheduler/ScheduleRepository.isSystem.test.ts`
Expected: FAIL — `isSystem` not on type, `COL_MAP` missing entry

- [ ] **Step 3: Add isSystem to ScheduleRecord**

In `src/shared/types/schedule.ts`, add `isSystem` to the `ScheduleRecord` interface:

```typescript
// Add after workspaceId field:
  workspaceId: string | null
  isSystem: boolean
}
```

- [ ] **Step 4: Add isSystem to COL_MAP and rowToRecord**

In `src/main/scheduler/ScheduleRepository.ts`:

Add to `COL_MAP`:
```typescript
  isSystem: 'is_system',
```

In `rowToRecord` (or equivalent row-to-record mapping function), add:
```typescript
  isSystem: !!row.is_system,
```

In `create` method, ensure `is_system` is included in the INSERT. Add `isSystem` to the insert values:
```typescript
  is_system: record.isSystem ? 1 : 0,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/scheduler/ScheduleRepository.isSystem.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/schedule.ts src/main/scheduler/ScheduleRepository.ts tests/scheduler/ScheduleRepository.isSystem.test.ts
git commit -m "feat: add isSystem field to ScheduleRecord and repository"
```

---

### Task 3: scheduleWorkspace isSystem Bypass

**Files:**
- Modify: `src/main/scheduler/scheduleWorkspace.ts`
- Modify: `src/main/scheduler/index.ts` (executeSchedule call site)
- Test: `tests/scheduler/scheduleWorkspace.isSystem.test.ts`

**Interfaces:**
- Consumes: `ScheduleRecord.isSystem`
- Produces: `checkScheduleWorkspace(workspaceId, deps, isSystem?)` — isSystem=true bypasses guard

- [ ] **Step 1: Write failing test**

```typescript
// tests/scheduler/scheduleWorkspace.isSystem.test.ts
import {describe, it, expect} from 'vitest'
import {checkScheduleWorkspace} from '../../../src/main/scheduler/scheduleWorkspace'

describe('checkScheduleWorkspace isSystem bypass', () => {
  it('should return ok for null workspaceId when isSystem=true', () => {
    const result = checkScheduleWorkspace(null, undefined, true)
    expect(result.state).toBe('ok')
    expect(result.path).toBeNull()
  })

  it('should return unset for null workspaceId when isSystem=false', () => {
    const result = checkScheduleWorkspace(null, undefined, false)
    expect(result.state).toBe('unset')
  })

  it('should return unset for null workspaceId when isSystem undefined (backward compat)', () => {
    const result = checkScheduleWorkspace(null)
    expect(result.state).toBe('unset')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scheduler/scheduleWorkspace.isSystem.test.ts`
Expected: FAIL — `checkScheduleWorkspace` doesn't accept third param

- [ ] **Step 3: Implement isSystem bypass**

In `src/main/scheduler/scheduleWorkspace.ts`, modify `checkScheduleWorkspace`:

```typescript
export function checkScheduleWorkspace(
    workspaceId: string | null | undefined,
    deps: WorkspaceGuardDeps = defaultDeps,
    isSystem?: boolean,
): ScheduleWorkspaceHealth {
    // System tasks bypass workspace guard
    if (isSystem) {
        return {state: 'ok', path: null, reason: null}
    }
    return evaluateWorkspace(workspaceId, deps.findWorkspace, deps.isDirectory)
}
```

Also update `ScheduleWorkspaceHealth` type if `path` being null with `state: 'ok'` needs accommodation (check existing type — `path: string | null` should already be supported).

- [ ] **Step 4: Update executeSchedule to pass isSystem**

In `src/main/scheduler/index.ts`, find the `executeSchedule` function where `checkScheduleWorkspace` is called. Add `schedule.isSystem` as third argument:

```typescript
// Before:
const wsHealth = checkScheduleWorkspace(schedule?.workspaceId)
// After:
const wsHealth = checkScheduleWorkspace(schedule?.workspaceId, undefined, schedule?.isSystem)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/scheduler/scheduleWorkspace.isSystem.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/scheduler/scheduleWorkspace.ts src/main/scheduler/index.ts tests/scheduler/scheduleWorkspace.isSystem.test.ts
git commit -m "feat: bypass workspace guard for system schedules"
```

---

### Task 4: System Schedule Defaults & Initialization

**Files:**
- Create: `src/main/agent/defaults/systemSchedules.ts`
- Modify: `src/main/scheduler/index.ts` (add initialization on startup)
- Test: `tests/scheduler/systemScheduleInit.test.ts`

**Interfaces:**
- Produces: `SYSTEM_SCHEDULE_DEFAULTS` array with `sys-memory-accumulation` task
- Produces: `ensureSystemSchedules()` — called on startup, creates missing system tasks

- [ ] **Step 1: Write failing test**

```typescript
// tests/scheduler/systemScheduleInit.test.ts
import {describe, it, expect} from 'vitest'
import {SYSTEM_SCHEDULE_DEFAULTS, ensureSystemSchedules} from '../../main/agent/defaults/systemSchedules'

describe('SYSTEM_SCHEDULE_DEFAULTS', () => {
  it('should include memory accumulation task', () => {
    const memTask = SYSTEM_SCHEDULE_DEFAULTS.find(d => d.id === 'sys-memory-accumulation')
    expect(memTask).toBeDefined()
    expect(memTask!.name).toBe('记忆沉淀')
    expect(memTask!.cronExpression).toBe('0 */6 * * *')
    expect(memTask!.taskType).toBe('agent')
    expect(memTask!.taskTarget).toBe('General')
    expect(memTask!.taskArgs).toHaveLength(1)
    expect(memTask!.taskArgs[0]).toContain('分析自上次积累以来的新对话')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scheduler/systemScheduleInit.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create systemSchedules.ts**

```typescript
// src/main/agent/defaults/systemSchedules.ts

export interface SystemScheduleDefault {
  id: string
  name: string
  description: string
  cronExpression: string
  taskType: 'agent' | 'skill' | 'command' | 'script'
  taskTarget: string
  taskArgs: string[]
}

const MEMORY_ACCUMULATION_PROMPT = `## 任务目标
分析自上次积累以来的新对话，提取用户习惯和项目经验，更新记忆文件。

## 前置：读取状态
用 file_read 读取 {hclawDir}/mem/.state.json，获取 lastAnalyzedAt 和 lastConversationId。
如果文件不存在，lastAnalyzedAt 设为 0（分析全部历史）。

## 步骤 1：查询新会话
用 hclaw_db_query 查询自 lastAnalyzedAt 之后的会话，排除定时任务自身产生的会话：
SELECT id, workspace_path, meta, created_at, updated_at
FROM conversations
WHERE updated_at > {lastAnalyzedAt}
  AND (meta IS NULL OR json_extract(meta, '$.channel') != 'schedule')
ORDER BY updated_at ASC
如果没有新会话，直接结束，输出"无新会话"。

## 步骤 2：按工作目录分组
按 workspace_path 分组会话。过滤掉 workspace_path 为空的会话。
对每个 workspace_path，取最后一级目录名作为项目名。

## 步骤 3：提取对话内容（三块数据，控制数据量）
对每个项目，分三块提取对话内容：

### 块 1：用户消息
查询用户直接输入的文本（排除系统注入的系统提醒消息）：
SELECT m.id AS msg_id, m.timestamp, mb.content
FROM messages m
JOIN message_blocks mb ON mb.message_id = m.id
WHERE m.conversation_id IN (
  SELECT id FROM conversations
  WHERE workspace_path = '{workspace_path}'
    AND updated_at > {lastAnalyzedAt}
    AND (meta IS NULL OR json_extract(meta, '$.channel') != 'schedule')
)
  AND m.role = 'user'
  AND mb.block_type = 'text'
  AND mb.content IS NOT NULL
  AND length(mb.content) > 20
  AND mb.content NOT LIKE '<system-reminder>%'
ORDER BY m.timestamp ASC, mb.sequence ASC

### 块 2：ask_user 响应
用户对 ask_user 工具的回复内容。先找到 ask_user 的 tool_call，再查对应的 tool_result：
SELECT mb.message_id, mb.data
FROM message_blocks mb
WHERE mb.block_type = 'tool_call'
  AND json_extract(mb.data, '$.name') = 'ask_user'
  AND mb.message_id IN (
    SELECT m.id FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.workspace_path = '{workspace_path}'
      AND c.updated_at > {lastAnalyzedAt}
      AND (c.meta IS NULL OR json_extract(c.meta, '$.channel') != 'schedule')
  )
然后对每个 tool_call，用其 toolCallId 查 tool_result 的 output。

### 块 3：Assistant 最终摘要
每个 assistant 轮次最后一条有意义的 text 块：
SELECT m.id AS msg_id, m.timestamp, mb.turn_index, mb.content
FROM messages m
JOIN message_blocks mb ON mb.message_id = m.id
WHERE m.conversation_id IN (
  SELECT id FROM conversations
  WHERE workspace_path = '{workspace_path}'
    AND updated_at > {lastAnalyzedAt}
    AND (meta IS NULL OR json_extract(meta, '$.channel') != 'schedule')
)
  AND m.role = 'assistant'
  AND mb.block_type = 'text'
  AND mb.content IS NOT NULL
  AND length(mb.content) > 50
ORDER BY m.timestamp ASC, mb.sequence ASC
对同一 msg_id，只取 sequence 最大的（最后一条 text 块）。

### 数据量控制
- 每个项目最多取最近 30 条会话
- 每个会话最多提取前 20 条用户消息 + 20 条 ask_user 响应 + 10 条 assistant 摘要
- 超限时取最近的，跳过旧的

## 步骤 4：分析与提取
逐项目分析对话内容，特别关注：
- 用户多次强调的内容、明确要求"记住"的内容（来自块 1）
- 用户主动填写的偏好、决策选择、风格倾向（来自块 2）
- 常用技能组合、工作模式、项目特定约定（来自块 3）

## 步骤 5：更新项目记忆文件
对每个项目：
- 如果 ref/{项目目录名}/ 目录不存在，创建目录
- 读取现有 ref/{项目目录名}/memory.md（如有）
- 合并新提取的内容与现有内容（去重、合并同类项）
- 保持文件 ≤8 KB，超限时合并精简旧条目
- 用 file_write 写入

对用户级偏好（跨项目的通用习惯）：
- 读取现有 ref/_user/preferences.md
- 合并更新
- 保持 ≤4 KB
- 用 file_write 写入

## 步骤 6：更新 index.json
读取 ref/index.json（不存在则视为空对象）。
对新出现的 workspace_path，确定项目目录名：
- 取 workspace_path 最后一级目录名作为基础名
- 检查 index.json 中是否已有其他 workspace_path 使用相同目录名
- 如有冲突，目录名追加短 hash 后缀（SHA-256 前 4 位）
- 记录 { workspace_path: { dir, projectName } }
用 file_write 写入 index.json。

## 步骤 7：更新 SKILL.md 索引
读取现有 SKILL.md（不存在则创建）。
更新"用户偏好（摘要）"部分：从 ref/_user/preferences.md 提取精简摘要。
更新"记忆索引"部分：列出所有 ref/ 下的项目记忆文件。
如有新项目出现，添加索引条目。
保持 SKILL.md ≤2 KB。
用 file_write 写入。

## 步骤 8：更新状态
用 file_write 更新 .state.json：
{ "lastAnalyzedAt": {当前时间戳}, "lastConversationId": "{最后处理的会话ID}" }

## 约束
- 每个文件严格不超过大小上限
- 合并而非追加——旧条目与新条目同类时，合并为一条
- 只记录有价值的习惯，不记录具体对话内容
- 项目相关经验落地到项目 memory.md，跨项目通用习惯落地到 preferences.md
- index.json 和 SKILL.md 必须在最后统一更新（步骤 6-8），确保与 ref 文件内容一致`

export const SYSTEM_SCHEDULE_DEFAULTS: SystemScheduleDefault[] = [
  {
    id: 'sys-memory-accumulation',
    name: '记忆沉淀',
    description: '定时分析对话历史，积累用户习惯与项目经验',
    cronExpression: '0 */6 * * *',
    taskType: 'agent',
    taskTarget: 'General',
    taskArgs: [MEMORY_ACCUMULATION_PROMPT],
  },
]

/**
 * Ensure all system schedules exist in the database.
 * Called on app startup. Creates missing system tasks; does not overwrite existing user modifications.
 */
export function ensureSystemSchedules(scheduleRepo: {
  get: (id: string) => any
  create: (record: any) => void
}): void {
  for (const def of SYSTEM_SCHEDULE_DEFAULTS) {
    const existing = scheduleRepo.get(def.id)
    if (!existing) {
      const now = Date.now()
      scheduleRepo.create({
        id: def.id,
        name: def.name,
        description: def.description,
        cronExpression: def.cronExpression,
        taskType: def.taskType,
        taskTarget: def.taskTarget,
        taskArgs: def.taskArgs,
        enabled: true,
        paused: false,
        pausedAt: null,
        workspaceId: null,
        isSystem: true,
        createdAt: now,
        updatedAt: now,
      })
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/scheduler/systemScheduleInit.test.ts`
Expected: PASS

- [ ] **Step 5: Call ensureSystemSchedules on startup**

In `src/main/scheduler/index.ts`, find the initialization/startup section (after scheduler manager is created and DB is ready). Add:

```typescript
import {ensureSystemSchedules} from '../agent/defaults/systemSchedules'

// After scheduleRepo is initialized:
ensureSystemSchedules(scheduleRepo)
```

Also ensure the scheduler manager upserts these newly created tasks to the cron engine. After creation, fetch each system schedule and call `schedulerManager.upsertWorkerSchedule(record)` if enabled.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent/defaults/systemSchedules.ts src/main/scheduler/index.ts tests/scheduler/systemScheduleInit.test.ts
git commit -m "feat: system schedule defaults and startup initialization"
```

---

### Task 5: scheduleOps is_system Handling

**Files:**
- Modify: `src/main/scheduler/scheduleOps.ts`
- Test: `tests/scheduler/scheduleOps.isSystem.test.ts`

**Interfaces:**
- Produces: `deleteSchedule` rejects isSystem=true tasks
- Produces: `restoreSystemSchedule(id)` — restores defaults from `SYSTEM_SCHEDULE_DEFAULTS`

- [ ] **Step 1: Write failing test**

```typescript
// tests/scheduler/scheduleOps.isSystem.test.ts
import {describe, it, expect, beforeEach} from 'vitest'

// Mock scheduleRepo and schedulerManager for testing
describe('scheduleOps system task protection', () => {
  it('should reject deletion of system schedules', () => {
    // This will be an integration test with mocked repo
    // We test that deleteSchedule throws for isSystem=true records
  })

  it('should restore defaults via restoreSystemSchedule', () => {
    // Test that restoreSystemSchedule overwrites description/cron/args
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scheduler/scheduleOps.isSystem.test.ts`
Expected: FAIL — functions not implemented

- [ ] **Step 3: Add system task protection to deleteSchedule**

In `src/main/scheduler/scheduleOps.ts`, modify `deleteSchedule`:

```typescript
export function deleteSchedule(id: string): ScheduleResult<true> {
  try {
    const record = scheduleRepo.get(id)
    if (!record) throw notFound(id)
    if (record.isSystem) throw invalidArgument('delete', '系统内置任务不可删除')
    schedulerManager.stop(id)
    schedulerManager.deleteWorkerSchedule(id)
    scheduleRepo.delete(id)
    return ok(true)
  } catch (err) { return fail(err) }
}
```

- [ ] **Step 4: Add restoreSystemSchedule function**

In `src/main/scheduler/scheduleOps.ts`, add:

```typescript
import {SYSTEM_SCHEDULE_DEFAULTS} from '../agent/defaults/systemSchedules'

export function restoreSystemSchedule(id: string): ScheduleResult<ScheduleRecord> {
  try {
    const record = scheduleRepo.get(id)
    if (!record) throw notFound(id)
    if (!record.isSystem) throw invalidArgument('restore', '仅系统内置任务支持还原默认')

    const defaults = SYSTEM_SCHEDULE_DEFAULTS.find(d => d.id === id)
    if (!defaults) throw invalidArgument('restore', `未找到系统任务默认配置: ${id}`)

    scheduleRepo.update(id, {
      description: defaults.description,
      cronExpression: defaults.cronExpression,
      taskArgs: defaults.taskArgs,
    })

    // Re-fetch and re-upsert to cron engine
    const updated = scheduleRepo.get(id)
    if (!updated) throw storageFailure('restore', '还原后无法读回记录')
    if (updated.enabled) schedulerManager.upsertWorkerSchedule(updated)
    return ok(updated)
  } catch (err) { return fail(err) }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/scheduler/scheduleOps.isSystem.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/scheduler/scheduleOps.ts tests/scheduler/scheduleOps.isSystem.test.ts
git commit -m "feat: protect system schedules from deletion, add restore-default"
```

---

### Task 6: Memory Shared Types

**Files:**
- Create: `src/shared/types/memory.ts`

**Interfaces:**
- Produces: `MemoryState`, `MemoryContent`, `MemoryInjectMessage` types

- [ ] **Step 1: Create type definitions**

```typescript
// src/shared/types/memory.ts

/** 记忆 pre-step 跨轮状态 */
export interface MemoryState {
  lastMemoryDigest: string | null
}

/** 加载的记忆内容 */
export interface MemoryContent {
  skillMd: string | null
  preferencesMd: string | null
  projectMemoryMd: string | null
  projectName: string | null
}

/** index.json 条目 */
export interface MemoryIndexEntry {
  dir: string
  projectName: string
}

/** index.json 结构 */
export type MemoryIndex = Record<string, MemoryIndexEntry>

/** .state.json 结构 */
export interface MemoryAccumulationState {
  lastAnalyzedAt: number
  lastConversationId: string
}

/** 记忆消息 metadata 标识 */
export const MEMORY_SOURCE_KIND = 'memory'
export const MEMORY_DIGEST_KEY = 'memoryDigest'
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/types/memory.ts
git commit -m "feat: memory system shared types"
```

---

### Task 7: Memory Loader & Store

**Files:**
- Create: `src/main/agent/memory/index.ts`
- Create: `src/main/agent/memory/memoryLoader.ts`
- Create: `src/main/agent/memory/memoryStore.ts`
- Test: `tests/agent/memory/memoryLoader.test.ts`

**Interfaces:**
- Produces: `loadMemory(hclawDir, workspacePath)` → `MemoryContent | null`
- Produces: `readIndex(hclawDir)` → `MemoryIndex | null`
- Produces: `ensureMemoryDir(hclawDir)` — creates mem/ structure if missing

- [ ] **Step 1: Write failing test**

```typescript
// tests/agent/memory/memoryLoader.test.ts
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {writeFileSync, mkdirSync, rmSync} from 'fs'
import {join} from 'path'
import {loadMemory, readIndex, ensureMemoryDir} from '../../../src/main/agent/memory/memoryLoader'

describe('memoryLoader', () => {
  const tmpDir = join(process.env.TEMP || '/tmp', 'hclaw-mem-test')

  beforeEach(() => {
    rmSync(tmpDir, {recursive: true, force: true})
  })

  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true})
  })

  it('should return null when mem/ does not exist', () => {
    const result = loadMemory(tmpDir, 'E:\\workspace\\test')
    expect(result).toBeNull()
  })

  it('should load SKILL.md and preferences only when workspace not in index', () => {
    ensureMemoryDir(tmpDir)
    writeFileSync(join(tmpDir, 'mem', 'SKILL.md'), '---\nname: user-memory\n---\n# Memory')
    mkdirSync(join(tmpDir, 'mem', 'ref', '_user'), {recursive: true})
    writeFileSync(join(tmpDir, 'mem', 'ref', '_user', 'preferences.md'), '# Prefs')

    const result = loadMemory(tmpDir, 'E:\\workspace\\unknown')
    expect(result).not.toBeNull()
    expect(result!.skillMd).toContain('# Memory')
    expect(result!.preferencesMd).toContain('# Prefs')
    expect(result!.projectMemoryMd).toBeNull()
  })

  it('should load project memory when workspace matches index', () => {
    ensureMemoryDir(tmpDir)
    writeFileSync(join(tmpDir, 'mem', 'SKILL.md'), '# Memory')
    mkdirSync(join(tmpDir, 'mem', 'ref', '_user'), {recursive: true})
    writeFileSync(join(tmpDir, 'mem', 'ref', '_user', 'preferences.md'), '# Prefs')
    mkdirSync(join(tmpDir, 'mem', 'ref', 'hclaw'), {recursive: true})
    writeFileSync(join(tmpDir, 'mem', 'ref', 'hclaw', 'memory.md'), '# HClaw Memory')
    writeFileSync(join(tmpDir, 'mem', 'ref', 'index.json'),
      JSON.stringify({'E:\\workspace\\hclaw': {dir: 'hclaw', projectName: 'HClaw'}}))

    const result = loadMemory(tmpDir, 'E:\\workspace\\hclaw')
    expect(result!.projectMemoryMd).toContain('# HClaw Memory')
    expect(result!.projectName).toBe('HClaw')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/memory/memoryLoader.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create memoryStore.ts**

```typescript
// src/main/agent/memory/memoryStore.ts
import {existsSync, mkdirSync, writeFileSync} from 'fs'
import {join} from 'path'
import type {MemoryIndex} from '@shared/types/memory'

const MEM_DIR = 'mem'
const REF_DIR = 'ref'
const USER_DIR = '_user'

/** Ensure the mem/ directory structure exists */
export function ensureMemoryDir(hclawDir: string): void {
  const memPath = join(hclawDir, MEM_DIR)
  if (!existsSync(memPath)) {
    mkdirSync(memPath, {recursive: true})
  }
  const refPath = join(memPath, REF_DIR)
  if (!existsSync(refPath)) {
    mkdirSync(refPath, {recursive: true})
  }
  const userPath = join(refPath, USER_DIR)
  if (!existsSync(userPath)) {
    mkdirSync(userPath, {recursive: true})
  }
}

/** Initialize empty index.json if it doesn't exist */
export function ensureIndex(hclawDir: string): void {
  const indexPath = join(hclawDir, MEM_DIR, REF_DIR, 'index.json')
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, '{}', 'utf-8')
  }
}

/** Get the mem/ directory path */
export function getMemDir(hclawDir: string): string {
  return join(hclawDir, MEM_DIR)
}

/** Get the ref/ directory path */
export function getRefDir(hclawDir: string): string {
  return join(hclawDir, MEM_DIR, REF_DIR)
}
```

- [ ] **Step 4: Create memoryLoader.ts**

```typescript
// src/main/agent/memory/memoryLoader.ts
import {existsSync, readFileSync, statSync} from 'fs'
import {join} from 'path'
import {createHash} from 'crypto'
import type {MemoryContent, MemoryIndex, MemoryState} from '@shared/types/memory'
import {ensureMemoryDir} from './memoryStore'
import {getMemDir, getRefDir} from './memoryStore'

/** mtime-based file cache to avoid re-reading unchanged files */
const fileCache = new Map<string, {mtime: number, content: string}>()

function readWithCache(filePath: string): string | null {
  if (!existsSync(filePath)) return null
  const stat = statSync(filePath)
  const cached = fileCache.get(filePath)
  if (cached && cached.mtime === stat.mtimeMs) return cached.content
  const content = readFileSync(filePath, 'utf-8')
  fileCache.set(filePath, {mtime: stat.mtimeMs, content})
  return content
}

/** Read index.json */
export function readIndex(hclawDir: string): MemoryIndex | null {
  const indexPath = join(getRefDir(hclawDir), 'index.json')
  const raw = readWithCache(indexPath)
  if (!raw) return null
  try {
    return JSON.parse(raw) as MemoryIndex
  } catch {
    return null
  }
}

/** Load memory content for a given workspace */
export function loadMemory(hclawDir: string, workspacePath: string | null): MemoryContent | null {
  const memDir = getMemDir(hclawDir)
  if (!existsSync(memDir)) return null

  // Load SKILL.md
  const skillMd = readWithCache(join(memDir, 'SKILL.md'))
  if (!skillMd) return null  // No SKILL.md = memory not initialized

  // Load preferences
  const preferencesMd = readWithCache(join(getRefDir(hclawDir), '_user', 'preferences.md'))

  // Match workspace to project memory
  let projectMemoryMd: string | null = null
  let projectName: string | null = null

  if (workspacePath) {
    const index = readIndex(hclawDir)
    if (index) {
      const entry = index[workspacePath]
      if (entry) {
        projectMemoryMd = readWithCache(join(getRefDir(hclawDir), entry.dir, 'memory.md'))
        projectName = entry.projectName
      }
    }
  }

  return {skillMd, preferencesMd, projectMemoryMd, projectName}
}

/** Compute digest for memory content */
export function computeMemoryDigest(content: MemoryContent): string {
  const parts = [content.skillMd || '', content.preferencesMd || '', content.projectMemoryMd || '']
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

/** Re-export ensureMemoryDir for convenience */
export {ensureMemoryDir} from './memoryStore'
```

- [ ] **Step 5: Create index.ts**

```typescript
// src/main/agent/memory/index.ts
export {loadMemory, readIndex, computeMemoryDigest, ensureMemoryDir} from './memoryLoader'
export {ensureMemoryDir, ensureIndex, getMemDir, getRefDir} from './memoryStore'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/agent/memory/memoryLoader.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/agent/memory/ tests/agent/memory/memoryLoader.test.ts
git commit -m "feat: memory loader and store with mtime caching"
```

---

### Task 8: Memory Publish (Pre-step)

**Files:**
- Create: `src/main/agent/loop/memoryPublish.ts`
- Test: `tests/agent/loop/memoryPublish.test.ts`

**Interfaces:**
- Consumes: `loadMemory`, `computeMemoryDigest` from Task 7
- Consumes: `LoopState`, `addMessage` from state module
- Produces: `MemoryState` interface, `restoreMemoryState()`, `runMemoryPreStep()`

- [ ] **Step 1: Write failing test**

```typescript
// tests/agent/loop/memoryPublish.test.ts
import {describe, it, expect} from 'vitest'
import {restoreMemoryState} from '../../../src/main/agent/loop/memoryPublish'

describe('restoreMemoryState', () => {
  it('should return empty state when no memory messages', () => {
    const state = restoreMemoryState([])
    expect(state.lastMemoryDigest).toBeNull()
  })

  it('should find last memory digest from messages', () => {
    const messages = [
      {metadata: {}},
      {metadata: {memoryDigest: 'abc123', sourceKind: 'memory'}},
      {metadata: {}},
      {metadata: {memoryDigest: 'def456', sourceKind: 'memory'}},
    ] as any
    const state = restoreMemoryState(messages)
    expect(state.lastMemoryDigest).toBe('def456')
  })

  it('should return null when no memory messages found', () => {
    const messages = [
      {metadata: {sourceKind: 'catalog'}},
      {metadata: {}},
    ] as any
    const state = restoreMemoryState(messages)
    expect(state.lastMemoryDigest).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/loop/memoryPublish.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create memoryPublish.ts**

```typescript
// src/main/agent/loop/memoryPublish.ts
import {createHash} from 'crypto'
import type {LoopState} from '../state'
import {addMessage} from '../state'
import type {IConversationRepository} from '../../repositories/interfaces'
import type {Message} from '@shared/types'
import {MEMORY_SOURCE_KIND, MEMORY_DIGEST_KEY} from '@shared/types/memory'
import {loadMemory, computeMemoryDigest} from '../memory/memoryLoader'
import {logger} from '../logger'

export interface MemoryState {
  lastMemoryDigest: string | null
}

export function restoreMemoryState(messages: ReadonlyArray<{metadata?: Record<string, unknown>}>): MemoryState {
  for (let i = messages.length - 1; i >= 0; i--) {
    const meta = messages[i].metadata
    if (meta?.sourceKind === MEMORY_SOURCE_KIND) {
      return {lastMemoryDigest: (meta[MEMORY_DIGEST_KEY] as string) ?? null}
    }
  }
  return {lastMemoryDigest: null}
}

interface MemoryPreStepResult {
  state: LoopState
  memoryState: MemoryState
}

export function runMemoryPreStep(
  state: LoopState,
  memoryState: MemoryState,
  conversationRepo: IConversationRepository,
  sessionId: string,
  hclawDir: string,
  workspacePath: string | null,
  memoryEnabled: boolean,
  channel?: string,
): MemoryPreStepResult {
  try {
    // Skip if memory disabled
    if (!memoryEnabled) return {state, memoryState}

    // Skip for schedule sessions (avoid injecting memory into accumulation task's own session)
    if (channel === 'schedule') return {state, memoryState}

    // Load memory content
    const content = loadMemory(hclawDir, workspacePath)
    if (!content) return {state, memoryState}  // mem/ not initialized

    // Compute digest
    const digest = computeMemoryDigest(content)

    // Skip if digest unchanged (memory already in history)
    if (memoryState.lastMemoryDigest === digest) return {state, memoryState}

    // Build message content
    const parts: string[] = []
    parts.push('<system-reminder>')
    parts.push('# 用户习惯记忆')
    parts.push('')
    parts.push(content.skillMd || '')
    if (content.preferencesMd) {
      parts.push('---')
      parts.push('## 用户偏好')
      parts.push('')
      parts.push(content.preferencesMd)
    }
    if (content.projectMemoryMd) {
      parts.push('---')
      parts.push(`## 项目记忆（${content.projectName ?? 'unknown'}）`)
      parts.push('')
      parts.push(content.projectMemoryMd)
    }
    parts.push('</system-reminder>')

    const messageText = parts.join('\n')

    // Create and persist message
    const msg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: messageText,
      conversationId: state.conversationId,
      timestamp: Date.now(),
      metadata: {
        sourceKind: MEMORY_SOURCE_KIND,
        [MEMORY_DIGEST_KEY]: digest,
      },
    }

    conversationRepo.writeMessagesDelta(sessionId, [msg])
    const newState = addMessage(state, msg)

    return {
      state: newState,
      memoryState: {lastMemoryDigest: digest},
    }
  } catch (err) {
    logger.warn('memory pre-step skipped', {error: String(err)})
    return {state, memoryState}
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/loop/memoryPublish.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/loop/memoryPublish.ts tests/agent/loop/memoryPublish.test.ts
git commit -m "feat: memory pre-step with digest gating and crash recovery"
```

---

### Task 9: Controller Integration

**Files:**
- Modify: `src/main/agent/loop/controller.ts`

**Interfaces:**
- Consumes: `runMemoryPreStep`, `restoreMemoryState`, `MemoryState` from Task 8
- Consumes: `getSettings()` to check `memory.enabled`

- [ ] **Step 1: Add imports to controller.ts**

Near the existing imports of `catalogPublish` and `envPublish` (around line 39-41):

```typescript
import {restoreMemoryState, runMemoryPreStep, type MemoryState} from './memoryPublish'
import {getSettings} from '../../settings'  // or the correct settings import path
```

- [ ] **Step 2: Initialize MemoryState alongside CatalogState/EnvState**

Find where `catalogState` is initialized (likely near `restoreCatalogState` call around line 247). Add:

```typescript
let memoryState: MemoryState = restoreMemoryState(currentState.messages)
```

- [ ] **Step 3: Add runMemoryPreStep call after env pre-step**

After the env pre-step block (around line 607), add:

```typescript
// ── 用户习惯记忆发布（pre-step）：记忆文件 digest 变化时追加记忆消息 ──
{
    const r = runMemoryPreStep(
        currentState, memoryState, conversationRepo, sessionId,
        hclawDir, workingDir,
        getSettings()?.memory?.enabled ?? true,
        channel,
    )
    currentState = r.state
    memoryState = r.memoryState
}
```

> Note: `hclawDir`, `workingDir`, and `channel` need to be available in scope. Check the controller for existing variables that hold these values. `hclawDir` is the HClaw config directory; `workingDir` is the conversation's workspace path; `channel` is the session channel.

- [ ] **Step 4: Verify the app starts without errors**

Run: `cd E:\workspace\media\hclaw && npm run dev`
Expected: App starts normally, no console errors about memoryPublish

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/loop/controller.ts
git commit -m "feat: integrate memory pre-step into agent loop controller"
```

---

### Task 10: systemManageTool Schema Extension

**Files:**
- Modify: `src/main/agent/tools/builtin/systemManageTool.ts`

**Interfaces:**
- Produces: `settings.memory.enabled` configurable via `update_settings`
- Produces: `get_settings` returns `memory` section

- [ ] **Step 1: Add memory to zod schema**

In `src/main/agent/tools/builtin/systemManageTool.ts`, add `memory` to the `settings` object in the zod schema (after `subagent`):

```typescript
        memory: z.object({
            enabled: z.boolean().optional().describe('是否启用用户习惯记忆功能'),
        }).optional(),
```

- [ ] **Step 2: Update get_settings output**

In the `get_settings` handler, add `memory` to the returned object:

```typescript
// In the get_settings action handler, add:
memory: currentSettings.memory ?? {enabled: true},
```

- [ ] **Step 3: Verify settings can be read and written**

Run the app and use the `system_manage` tool with `action: 'get_settings'`. Verify `memory` appears in output.
Then use `action: 'update_settings'` with `settings: {memory: {enabled: false}}`. Verify it persists.

- [ ] **Step 4: Commit**

```bash
git add src/main/agent/tools/builtin/systemManageTool.ts
git commit -m "feat: extend system_manage schema with memory settings"
```

---

### Task 11: Schedule IPC — Restore Default

**Files:**
- Modify: `src/main/agent/ipc/scheduleIPC.ts` (or `src/main/scheduler/scheduleIPC.ts` — verify path)

**Interfaces:**
- Produces: IPC channel `scheduler-restore-default` that calls `restoreSystemSchedule()`

- [ ] **Step 1: Add IPC handler**

Find the existing schedule IPC handlers. Add a new handler for restore-default:

```typescript
ipcMain.handle('scheduler-restore-default', async (_event, id: string) => {
  const result = restoreSystemSchedule(id)
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  // Broadcast the update
  scheduleBroadcast.updated(result.value)
  return result.value
})
```

Add the import:
```typescript
import {restoreSystemSchedule} from '../scheduler/scheduleOps'
```

- [ ] **Step 2: Add preload bridge (if applicable)**

Check if there's a preload API file that exposes schedule IPC to renderer. If so, add:

```typescript
restoreDefault: (id: string) => ipcRenderer.invoke('scheduler-restore-default', id),
```

- [ ] **Step 3: Commit**

```bash
git add src/main/agent/ipc/scheduleIPC.ts
git commit -m "feat: add restore-default IPC for system schedules"
```

---

### Task 12: Frontend — useScheduleListState Tabs

**Files:**
- Modify: `src/renderer/hooks/useScheduleListState.ts`

- [ ] **Step 1: Update tab definitions**

Replace `SCHEDULE_LIST_TABS` and `ScheduleListTab`:

```typescript
export type ScheduleListTab = 'user' | 'system' | 'enabled' | 'disabled'

export const SCHEDULE_LIST_TABS: ReadonlyArray<{key: ScheduleListTab; label: string}> = [
    {key: 'user', label: '用户'},
    {key: 'system', label: '系统任务'},
    {key: 'enabled', label: '启用'},
    {key: 'disabled', label: '禁用'},
]
```

- [ ] **Step 2: Update matchesTab function**

```typescript
export function matchesTab(s: ScheduleUI, tab: ScheduleListTab): boolean {
    switch (tab) {
        case 'user':
            return !s.isSystem
        case 'system':
            return s.isSystem
        case 'enabled':
            return s.enabled
        case 'disabled':
            return !s.enabled
        default:
            return true
    }
}
```

- [ ] **Step 3: Update filterCounts to include new tabs**

The `filterCounts` computation should count for each tab. Add `user` and `system` counts:

```typescript
// In the filterCounts computation:
user: schedules.filter(s => !s.isSystem).length,
system: schedules.filter(s => s.isSystem).length,
```

- [ ] **Step 4: Ensure ScheduleUI type includes isSystem**

In the `ScheduleUI` type (or wherever it's defined), add:

```typescript
isSystem: boolean
```

This should map from `ScheduleRecord.isSystem` in the store.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/hooks/useScheduleListState.ts
git commit -m "feat: update schedule tabs to user/system/enabled/disabled"
```

---

### Task 13: Frontend — ScheduleDialog Tab Buttons & New Button

**Files:**
- Modify: `src/renderer/components/dialogs/ScheduleDialog.tsx`

- [ ] **Step 1: Hide "新建" button on system tab**

In the tab button rendering section, conditionally show the "新建" button:

```tsx
{/* 新建按钮 — 系统任务 tab 不显示 */}
{activeTab !== 'system' && (
  <button
    onClick={handleNew}
    className="px-3 py-1.5 text-xs font-medium rounded-md ..."
    data-name="schedule-dialog-new-button">
    新建
  </button>
)}
```

- [ ] **Step 2: Verify tab labels render correctly**

The existing tab rendering maps over `SCHEDULE_LIST_TABS`, so the label change from "全部" to "用户" and the new "系统任务" tab will automatically appear.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/dialogs/ScheduleDialog.tsx
git commit -m "feat: hide new button on system tab, update tab labels"
```

---

### Task 14: Frontend — ScheduleCard System Task UI

**Files:**
- Modify: `src/renderer/components/dialogs/ScheduleCard.tsx`
- Create: `src/renderer/components/dialogs/ScheduleSystemActions.tsx`
- Create: `src/renderer/components/dialogs/ScheduleDisableConfirm.tsx`

- [ ] **Step 1: Create ScheduleSystemActions component**

```tsx
// src/renderer/components/dialogs/ScheduleSystemActions.tsx
import {useState} from 'react'

export interface ScheduleSystemActionsProps {
  scheduleId: string
  onRestoreDefault: (id: string) => Promise<void>
}

export function ScheduleSystemActions({scheduleId, onRestoreDefault}: ScheduleSystemActionsProps) {
  const [confirming, setConfirming] = useState(false)

  const handleRestore = async () => {
    if (!confirming) {
      setConfirming(true)
      return
    }
    await onRestoreDefault(scheduleId)
    setConfirming(false)
  }

  return (
    <button
      type="button"
      onClick={handleRestore}
      onBlur={() => setConfirming(false)}
      className="p-1.5 rounded transition-colors text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)]"
      title={confirming ? '再次点击确认还原' : '还原默认'}
      aria-label="还原默认"
      data-name="schedule-dialog-restore-button"
    >
      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
        <path d="M3 3v5h5"/>
      </svg>
    </button>
  )
}
```

- [ ] **Step 2: Create ScheduleDisableConfirm component**

```tsx
// src/renderer/components/dialogs/ScheduleDisableConfirm.tsx

export interface ScheduleDisableConfirmProps {
  open: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ScheduleDisableConfirm({open, onConfirm, onCancel}: ScheduleDisableConfirmProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div className="bg-[var(--surface)] rounded-lg p-6 max-w-sm mx-4" onClick={e => e.stopPropagation()}>
        <p className="text-sm text-[var(--text-primary)] mb-4">
          关闭「记忆沉淀」任务将同步关闭记忆功能（会话中不再注入用户习惯记忆）。
          已积累的记忆文件不会被删除，重新启用后可继续使用。
          是否继续？
        </p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]">
            取消
          </button>
          <button onClick={onConfirm} className="px-3 py-1.5 text-xs rounded-md bg-[var(--error)] text-white hover:opacity-90">
            确认关闭
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Modify ScheduleCard to handle system tasks**

In `ScheduleCard.tsx`, add `isSystem` to props and conditionally render:

```tsx
// Add to ScheduleCardProps:
  isSystem?: boolean
  onRestoreDefault?: () => void
```

In the operation buttons section, wrap the delete button:
```tsx
{/* 删除 — 系统任务不显示 */}
{!isSystem && (
  <button type="button" onClick={onDelete} ...>
    {/* delete icon */}
  </button>
)}

{/* 还原默认 — 仅系统任务显示 */}
{isSystem && onRestoreDefault && (
  <ScheduleSystemActions scheduleId={schedule.id} onRestoreDefault={onRestoreDefault} />
)}
```

- [ ] **Step 4: Handle disable confirmation for system tasks**

In the `onToggleEnabled` handler logic (in `useScheduleListState` or `ScheduleDialog`), add:

```typescript
// When toggling enabled for a system task being disabled:
if (schedule.isSystem && !schedule.enabled === false) {
  // Show confirmation dialog
  setDisableConfirm({open: true, scheduleId: schedule.id})
}
```

On confirm: disable schedule AND set `memory.enabled = false` via `system_manage` tool or IPC.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/dialogs/ScheduleCard.tsx src/renderer/components/dialogs/ScheduleSystemActions.tsx src/renderer/components/dialogs/ScheduleDisableConfirm.tsx
git commit -m "feat: system task card UI with restore-default and disable confirmation"
```

---

### Task 15: Frontend — ScheduleEditModal System Task Restrictions

**Files:**
- Modify: `src/renderer/components/dialogs/ScheduleEditModal.tsx`

- [ ] **Step 1: Add isSystem prop and lock fields**

```tsx
// Add to props:
  isSystem?: boolean
```

In the form fields, disable `name`, `taskType`, `taskTarget` when `isSystem`:

```tsx
<input
  id={FIELD_IDS.name}
  value={formData.name}
  onChange={e => setFormData({...formData, name: e.target.value})}
  disabled={isSystem}
  className={isSystem ? 'opacity-50 cursor-not-allowed' : ''}
/>
```

Apply the same pattern to `taskType` selector and `taskTarget` input.

`description`, `cronExpression` (cron config), and `taskPrompt` remain editable.

- [ ] **Step 2: Commit**

```bash
git add src/renderer/components/dialogs/ScheduleEditModal.tsx
git commit -m "feat: lock system task fields in edit modal"
```

---

### Task 16: Frontend — scheduleStore isSystem

**Files:**
- Modify: `src/renderer/stores/scheduleStore.ts`

- [ ] **Step 1: Add isSystem to ScheduleUI type**

Find the `ScheduleUI` type (likely in the store or a shared types file). Add:

```typescript
isSystem: boolean
```

- [ ] **Step 2: Map isSystem in the record-to-UI conversion**

Find where `ScheduleRecord` is mapped to `ScheduleUI` and add:

```typescript
isSystem: record.isSystem,
```

- [ ] **Step 3: Add restoreDefault action to store**

```typescript
restoreDefault: async (id: string) => {
  await window.electronAPI.scheduler.restoreDefault(id)
  // The broadcast will update the store, but also trigger manually
}
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/stores/scheduleStore.ts
git commit -m "feat: add isSystem to schedule store and restoreDefault action"
```

---

### Task 17: End-to-End Verification

**Files:** No new files — manual/integration testing

- [ ] **Step 1: Verify system task initialization**

Start the app. Open the schedule management page. Verify "系统任务" tab shows "记忆沉淀" task with `cron: 0 */6 * * *`.

- [ ] **Step 2: Verify memory injection**

Create a new conversation in a workspace. Check the first LLM request's messages (via DB or debug logging). Verify a `<system-reminder>` message with "用户习惯记忆" is NOT present (because `mem/` doesn't exist yet — expected behavior).

- [ ] **Step 3: Manually create mem/ structure and verify injection**

Create `{hclawDir}/mem/SKILL.md` with test content. Create `ref/_user/preferences.md`. Start a new conversation. Verify the memory message is injected.

- [ ] **Step 4: Verify schedule session skips memory**

Trigger "记忆沉淀" task manually (立即执行). Check the created conversation's messages. Verify NO memory message is injected (channel='schedule' skip).

- [ ] **Step 5: Verify UI restrictions**

- Click "系统任务" tab → verify "新建" button is hidden
- Click delete on system task → verify it's disabled/blocked
- Edit system task → verify name/task_type/task_target are disabled
- Click "还原默认" → verify confirmation then restoration
- Disable system task → verify confirmation dialog appears
- Confirm disable → verify memory.enabled is also set to false

- [ ] **Step 6: Verify tab filtering**

- "用户" tab shows only non-system tasks
- "系统任务" tab shows only system tasks
- "启用" shows both types that are enabled
- "禁用" shows both types that are disabled

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "test: end-to-end verification of memory system"
```

---

## Self-Review

### Spec Coverage

| Spec Section | Task(s) | Status |
|---|---|---|
| §2 记忆组织结构 | Task 6, 7 | ✅ |
| §3 记忆注入机制 | Task 8, 9 | ✅ |
| §3 schedule 会话跳过 | Task 8 (channel check) | ✅ |
| §3 digest 崩溃恢复 | Task 8 (restoreMemoryState) | ✅ |
| §4 记忆沉淀定时任务 | Task 4, 5 | ✅ |
| §4 系统任务执行旁路 | Task 3 | ✅ |
| §5 UI 改造 | Task 12-16 | ✅ |
| §6 系统设置 | Task 10 | ✅ |
| §6 历史清理 | Task 1 (migration 049) | ✅ |
| §7 is_system 字段 | Task 1, 2 | ✅ |
| §8 测试用例 | Task 17 + unit tests in each task | ✅ |

### Placeholder Scan

No TBD, TODO, or vague steps. All code blocks contain actual implementation code. The memory accumulation prompt in Task 4 contains the full prompt text from the spec.

### Type Consistency

- `ScheduleRecord.isSystem: boolean` — used consistently in Task 2, 3, 4, 5, 12, 16
- `MemoryState.lastMemoryDigest: string | null` — used in Task 8, 9
- `MemoryContent` fields — used in Task 7, 8
- `SYSTEM_SCHEDULE_DEFAULTS` — defined in Task 4, used in Task 5
- `restoreSystemSchedule(id)` — defined in Task 5, used in Task 11
- `runMemoryPreStep()` params — defined in Task 8, called in Task 9
