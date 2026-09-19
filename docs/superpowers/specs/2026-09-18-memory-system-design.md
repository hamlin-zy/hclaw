# 用户习惯记忆系统设计

> **日期**: 2026-09-18
> **状态**: 设计已批准（修订 v2），待实现
> **分类**: Architectural

## 1. 概述

在系统提示词与用户指令之间增加一层"记忆 cap"——用户习惯记忆。该系统通过定时分析对话历史，积累用户的使用习惯、项目经验和个人偏好，在新会话首次 LLM 请求时自动注入，使 Agent 能够记住用户的偏好和工作方式。

### 核心设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 记忆载体格式 | 复用 skill 格式（SKILL.md + ref/） | 格式复用，LLM 已熟悉此结构 |
| 注入位置 | User 角色消息（类似 catalog/env） | 不破坏 system prompt 缓存 |
| Ref 加载方式 | 按 workspace_path 自动注入 | 无感知、可靠，不依赖 LLM 主动请求 |
| 积累执行方式 | 系统内置 schedule（agent 类型） | 复用现有定时任务执行链路 |
| 存储表 | 统一到 schedules 表（加 is_system） | 废弃遗留的 memory_tasks 表 |

> **注**：SKILL.md 复用 skill 的 frontmatter + Markdown 格式，但**不注册到 skill registry**——它只是被读取注入的文本文件，不参与 skill 的加载/调用流程。这是格式复用，非功能复用。

## 2. 记忆组织结构

### 目录结构

```
{hclawDir}/mem/
├── SKILL.md              ← 索引 + 用户层精简摘要（每次会话注入）
├── ref/
│   ├── index.json        ← workspace_path → 项目目录映射
│   ├── _user/            ← 用户偏好（非项目特有）
│   │   └── preferences.md
│   ├── hclaw/            ← HClaw 项目记忆
│   │   └── memory.md
│   └── guali/            ← guali 项目记忆
│       └── memory.md
└── .state.json           ← 积累任务状态
```

### 文件职责

| 文件 | 职责 | 大小上限 |
|------|------|----------|
| `SKILL.md` | 索引 + 用户偏好精简摘要 | ≤2 KB（~700 tokens） |
| `ref/_user/preferences.md` | 跨项目通用用户偏好的详细内容 | ≤4 KB（~1,400 tokens） |
| `ref/{project}/memory.md` | 项目级记忆：特定要求、常用技能组合、项目习惯 | ≤8 KB（~2,800 tokens） |
| `ref/index.json` | workspace_path → { dir, projectName } 映射 | — |
| `.state.json` | { lastAnalyzedAt, lastConversationId } 增量分析状态 | — |

### index.json 结构与项目名冲突处理

```json
{
  "E:\\workspace\\media\\hclaw": { "dir": "hclaw", "projectName": "HClaw" },
  "E:\\workspace\\test\\hclaw": { "dir": "hclaw-2a3f", "projectName": "hclaw (test)" }
}
```

**目录名冲突处理**：index.json 以完整 `workspace_path` 为 key，保证查找精确匹配。当两个不同路径的最后一级目录名相同时，后出现的目录名追加短 hash 后缀（取 workspace_path 的 SHA-256 前 4 位），如 `hclaw-2a3f`。projectName 中标注区分来源。

### SKILL.md 结构示例

```markdown
---
name: user-memory
description: 用户习惯记忆
---

# 用户习惯记忆

## 用户偏好（摘要）
- 偏好中文交流，简洁直接
- 修改前先读现有上下文，优先委派子 agent

## 记忆索引
- ref/_user/preferences.md: 用户偏好详情
- ref/hclaw/memory.md: HClaw 项目记忆
- ref/guali/memory.md: guali 项目记忆
```

### 总注入预算

| 组成部分 | 大小 |
|----------|------|
| SKILL.md | ≤2 KB |
| ref/_user/preferences.md | ≤4 KB |
| ref/{匹配项目}/memory.md | ≤8 KB |
| **总注入** | **≤14 KB（~5,000 tokens）** |

## 3. 记忆注入机制

### 注入位置

在 agent loop 的每轮 pre-step 中，新增 `runMemoryPreStep()`，与现有 `runCatalogPreStep()`（技能目录）和 `runEnvPreStep()`（日期环境）并列。

```
pre-steps:
  1. runCatalogPreStep()   ← 技能/MCP 目录（digest 门控）
  2. runEnvPreStep()       ← 日期环境快照
  3. runMemoryPreStep()    ← 用户习惯记忆（digest 门控）
↓
user 消息（用户实际输入）
```

> **注**：技术上每轮都会执行 `runMemoryPreStep()` 检查，但 digest 门控确保只在记忆内容变化时才实际注入消息。同一会话内记忆文件不变，因此只在首轮注入一次。

### Schedule 会话跳过

`runMemoryPreStep()` 检查会话的 `channel` 字段，当 `channel === 'schedule'` 时直接返回，不注入记忆。这避免"记忆沉淀"任务自身的会话被注入记忆 cap（浪费 token 且可能造成分析混淆）。

### Digest 门控

复用 catalog 的 digest 机制：
- `sha256(SKILL.md 内容 + ref/_user/preferences.md 内容 + ref/{匹配项目}/memory.md 内容)`
- digest 不变 → 跳过注入（记忆已在历史消息中，LLM 可见）
- digest 变化 → 追加新记忆消息（不修改旧消息）

**自然行为**：同一会话内，记忆文件不变，digest 不变，只在首轮注入一次。若"记忆沉淀"任务在会话进行中更新了记忆文件，下一轮 digest 变化，自动追加新记忆消息。

### Digest 状态持久化与崩溃恢复

仿照 catalog 的 `restoreCatalogState()` 机制：

**持久化**：每次注入记忆消息时，将当前 digest 写入消息的 `metadata.memoryDigest`，随消息落库。

**崩溃恢复**：`restoreMemoryState(messages)` 在会话恢复时从消息历史倒序扫描，找到最后一条含 `metadata.memoryDigest` 的记忆消息，重建 `lastMemoryDigest` 状态。恢复入口在 `controller.ts` 的会话初始化阶段，与 `restoreCatalogState` 并列调用。

```typescript
// loop/memoryPublish.ts
interface MemoryState {
  lastMemoryDigest: string | null;
}

function restoreMemoryState(messages: Message[]): MemoryState {
  for (let i = messages.length - 1; i >= 0; i--) {
    const digest = messages[i].metadata?.memoryDigest;
    if (digest) return { lastMemoryDigest: digest };
  }
  return { lastMemoryDigest: null };
}
```

### 注入消息格式

```xml
<system-reminder>
# 用户习惯记忆

[SKILL.md 全文]

---

## 用户偏好

[ref/_user/preferences.md 全文]

---

## 项目记忆（{projectName}）

[ref/{匹配项目}/memory.md 全文]
</system-reminder>
```

记忆消息的 `metadata` 中标记 `memoryDigest` 和 `memoryKind: 'user-memory'`，供崩溃恢复识别。

### Workspace 匹配逻辑

1. 从会话上下文获取 `workspacePath`
2. 读 `ref/index.json`，用完整 `workspacePath` 做 key 查找
3. 找到 → 注入对应的 `ref/{dir}/memory.md`
4. 未找到 → 仅注入 SKILL.md + preferences.md

### 首次初始化

- `mem/` 目录不存在时，`runMemoryPreStep()` 静默跳过
- 记忆功能启用但目录为空时，不影响正常使用

### 缓存优化

- 记忆文件读取结果缓存在内存中（文件 mtime 检查），避免每轮读盘
- digest 计算开销极低（sha256 几 KB 文本）

### 错误处理

`runMemoryPreStep()` 内部包 try-catch（与 catalogPublish/envPublish 一致），异常不向上抛出。失败时记录日志 `memory pre-step skipped`，返回未变更状态，不中断 mainLoop。

### 开关控制

- 系统设置中 `memory.enabled` 配置项控制注入
- 关闭时 `runMemoryPreStep()` 直接返回
- 关闭时不影响"记忆沉淀"定时任务（任务有独立 `enabled` 开关）

## 4. 记忆沉淀定时任务

### 任务配置

| 字段 | 值 |
|------|---|
| id | `sys-memory-accumulation`（硬编码，初始化时固定使用此 ID） |
| name | 记忆沉淀 |
| description | 定时分析对话历史，积累用户习惯与项目经验 |
| cron_expression | `0 */6 * * *`（每 6 小时） |
| task_type | `agent` |
| task_target | `General` |
| task_args | [完整 prompt（见下）] |
| enabled | 1 |
| is_system | 1 |
| workspace_id | null（系统任务不绑定工作目录，执行时走 is_system 旁路，见 §5.2） |

### 系统任务执行旁路

现有 `scheduleWorkspace.ts` 的工作目录守卫要求 `workspace_id` 非 null 才允许执行。系统任务需要旁路此检查：

```
scheduleWorkspace.checkScheduleWorkspace(workspaceId, isSystem?)
  → if (isSystem) return { state: 'ok', path: null, bypassed: true }
  → else: 现有逻辑
```

修改 `executeSchedule` 调用处，传入 `schedule.is_system`，is_system=1 时跳过工作目录守卫，直接进入执行流程。旁路仅对 is_system=1 生效，用户任务（is_system=0）仍受守卫约束。

### 积累 Prompt（task_args 内容）

```
## 任务目标
分析自上次积累以来的新对话，提取用户习惯和项目经验，更新记忆文件。

## 前置：读取状态
用 file_read 读取 {hclawDir}/mem/.state.json，获取 lastAnalyzedAt 和 lastConversationId。
如果文件不存在，lastAnalyzedAt 设为 0（分析全部历史）。

## 步骤 1：查询新会话
用 hclaw_db_query 查询自 lastAnalyzedAt 之后的会话，排除定时任务自身产生的会话：
```sql
SELECT id, workspace_path, meta, created_at, updated_at
FROM conversations
WHERE updated_at > {lastAnalyzedAt}
  AND (meta IS NULL OR json_extract(meta, '$.channel') != 'schedule')
ORDER BY updated_at ASC
```
如果没有新会话，直接结束，输出"无新会话"。

## 步骤 2：按工作目录分组
按 workspace_path 分组会话。过滤掉 workspace_path 为空的会话。
对每个 workspace_path，取最后一级目录名作为项目名。

## 步骤 3：提取对话内容（三块数据，控制数据量）

对每个项目，分三块提取对话内容：

### 块 1：用户消息
查询用户直接输入的文本（排除系统注入的系统提醒消息）：
```sql
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
```

### 块 2：ask_user 响应
用户对 ask_user 工具的回复内容。先找到 ask_user 的 tool_call，
再查对应的 tool_result：
```sql
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
```
然后对每个 tool_call，用其 toolCallId 查 tool_result 的 output。

### 块 3：Assistant 最终摘要
每个 assistant 轮次最后一条有意义的 text 块：
```sql
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
```
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
```json
{
  "lastAnalyzedAt": {当前时间戳},
  "lastConversationId": "{最后处理的会话ID}"
}
```

## 约束
- 每个文件严格不超过大小上限
- 合并而非追加——旧条目与新条目同类时，合并为一条
- 只记录有价值的习惯，不记录具体对话内容
- 项目相关经验落地到项目 memory.md，跨项目通用习惯落地到 preferences.md
- index.json 和 SKILL.md 必须在最后统一更新（步骤 6-8），确保与 ref 文件内容一致
```

### 状态文件 `.state.json`

```json
{
  "lastAnalyzedAt": 1789716683895,
  "lastConversationId": "conv-abc123"
}
```

### 任务执行特性

- **模型**：使用 General agent + 默认模型方案
- **工具集**：agent 默认工具 + hclaw_db_query + file_read + file_write
- **超时**：复用 schedule 默认超时
- **幂等性**：通过 `.state.json` 的 lastAnalyzedAt 保证增量分析。任务中途失败时 .state.json 未更新，下次运行重试。合并机制确保重复处理不会产生重复条目。

## 5. 定时任务管理 UI 改造

### 数据库变更

**migration: `048_add_schedules_is_system.sql`**
```sql
ALTER TABLE schedules ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_schedules_is_system ON schedules(is_system);
```

### 系统任务执行旁路

`scheduleWorkspace.ts` 修改：`checkScheduleWorkspace` 增加 `isSystem` 参数。`isSystem=true` 时直接返回 `{ state: 'ok', path: null, bypassed: true }`，跳过工作目录存在性检查。

`scheduler/index.ts` 的 `executeSchedule` 调用处传入 `schedule.is_system`。

### 系统内置任务定义

在源码中维护默认配置（版本控制）：
`src/main/agent/defaults/systemSchedules.ts`

```typescript
export const SYSTEM_SCHEDULE_DEFAULTS = [
  {
    id: 'sys-memory-accumulation',
    name: '记忆沉淀',
    description: '定时分析对话历史，积累用户习惯与项目经验',
    cronExpression: '0 */6 * * *',
    taskType: 'agent',
    taskTarget: 'General',
    taskArgs: ['...(完整积累 prompt，见 §4)...'],
  }
  // 未来可扩展更多系统任务
];
```

**初始化逻辑**：应用启动时检查系统任务是否存在（按 `id` 匹配），不存在则创建（从默认配置插入，`is_system=1`，`workspace_id=null`）。已存在的不覆盖用户修改，只检查是否需要同步 `enabled` 状态。

### Tab 结构变更

当前 Tab：`全部 | 启用 | 禁用`

改为：`用户 | 系统任务 | 启用 | 禁用`

| Tab | 筛选条件 | 新建按钮 |
|-----|---------|---------|
| 用户 | `is_system=0` | 有（创建用户任务） |
| 系统任务 | `is_system=1` | 无 |
| 启用 | 全部，`enabled=1` | 有（创建用户任务） |
| 禁用 | 全部，`enabled=0` | 有（创建用户任务） |

### 系统任务卡片特殊行为

| 操作 | 用户任务 | 系统任务 |
|------|---------|---------|
| 编辑 | 全字段可编辑 | 仅 `description` + `cron_expression` + `task_args` 可编辑 |
| 删除 | 可删除 | **不可删除** |
| 新建 | 可新建 | 不可新建 |
| 启用/禁用 | 直接切换 | 切换时检查关联功能（见下） |
| 还原默认 | 无 | 有"还原默认"按钮，恢复 `task_args`、`description`、`cron_expression` |

### 关联功能同步

当用户禁用"记忆沉淀"系统任务时：

```
弹出确认对话框：
"关闭「记忆沉淀」任务将同步关闭记忆功能（会话中不再注入用户习惯记忆）。
已积累的记忆文件不会被删除，重新启用后可继续使用。
是否继续？"

→ 确认：设置 schedule.enabled=0，同时设置 memory.enabled=false
→ 取消：不操作
```

重新启用时：只设置 `schedule.enabled=1`，**不自动开启** `memory.enabled`（由用户在设置中独立控制）。

### 还原默认机制

"还原默认"按钮点击后：
1. 从 `SYSTEM_SCHEDULE_DEFAULTS` 读取对应 `id` 的默认配置
2. 覆盖当前 schedule 的 `description`、`cron_expression`、`task_args`
3. `name` 和 `enabled` 保持用户当前设置不变（系统任务的 `name` 本身不可编辑，此处保持一致性）
4. 弹出确认提示"确定还原为系统默认配置？"

## 6. 系统设置与历史清理

### 系统设置新增

现有 `systemManageTool.ts` 使用 zod 严格 schema，只允许 `ui`/`agent`/`model`/`subagent` 四个分类。需要**扩展 schema** 增加 `memory` 分类：

```typescript
// systemManageTool.ts 的 zod schema 扩展
const settingsSchema = z.object({
  ui: z.object({ theme: z.enum(THEME_SETTINGS) }).optional(),
  agent: z.object({ /* 现有 */ }).optional(),
  model: z.object({ /* 现有 */ }).optional(),
  subagent: z.object({ /* 现有 */ }).optional(),
  memory: z.object({
    enabled: z.boolean().optional(),
  }).optional(),  // ★ 新增
});
```

同时更新 `get_settings` 输出格式，读取并返回 `memory` 分类配置。配置持久化到现有 settings 存储机制（SQLite 或 JSON 文件）。

**行为逻辑**：
- `memory.enabled = false` → `runMemoryPreStep()` 直接返回，不注入记忆消息
- `memory.enabled = false` → 不影响"记忆沉淀"定时任务的运行
- 设置页面新增开关："用户习惯记忆"，描述："会话首次请求时自动注入你的使用习惯和项目经验。由「记忆沉淀」定时任务自动维护。"

### 历史清理

**`049_cleanup_legacy_memory.sql`**
```sql
DROP TABLE IF EXISTS memory_tasks;
DELETE FROM tools WHERE id IN ('memory_search', 'memory_save');
```

保留迁移文件 007、008、009 作为历史记录。

### 配置层级关系

```
memory.enabled (系统设置)
    ↓ 控制
runMemoryPreStep() 是否注入

"记忆沉淀" schedule.enabled (定时任务开关)
    ↓ 控制
是否定时分析对话、更新记忆文件

两者独立，但有关联提示：
- 禁用"记忆沉淀"任务 → 提示是否同步关闭 memory.enabled
- 重新启用"记忆沉淀"任务 → 不自动开启 memory.enabled
- 关闭 memory.enabled → 不影响"记忆沉淀"任务运行
```

## 7. 实现总览

### 涉及文件清单

**新增文件（10）**：

| 文件 | 职责 |
|------|------|
| `src/main/agent/defaults/systemSchedules.ts` | 系统内置任务默认配置 |
| `src/main/agent/loop/memoryPublish.ts` | 记忆 pre-step：文件加载、digest、注入、崩溃恢复 |
| `src/main/agent/memory/index.ts` | 记忆模块入口 |
| `src/main/agent/memory/memoryLoader.ts` | SKILL.md + ref 文件加载与 mtime 缓存 |
| `src/main/agent/memory/memoryStore.ts` | 记忆目录初始化、index.json 管理与冲突处理 |
| `src/main/repositories/sqlite/migrations/048_add_schedules_is_system.sql` | schedules 加 is_system |
| `src/main/repositories/sqlite/migrations/049_cleanup_legacy_memory.sql` | 清理 memory_tasks + 旧工具 |
| `src/renderer/components/dialogs/ScheduleSystemActions.tsx` | 系统任务"还原默认"按钮组件 |
| `src/renderer/components/dialogs/ScheduleDisableConfirm.tsx` | 禁用系统任务确认对话框 |
| `src/shared/types/memory.ts` | 记忆相关共享类型 |

**修改文件（13）**：

| 文件 | 改动 |
|------|------|
| `src/shared/types/schedule.ts` | ScheduleRecord 增加 `isSystem` 字段 |
| `src/main/repositories/sqlite/ScheduleRepository.ts` | COL_MAP 增加 is_system 映射 |
| `src/main/agent/schedule/scheduleOps.ts` | CRUD 处理 is_system；系统任务不可删除 |
| `src/main/agent/schedule/scheduleWorkspace.ts` | `checkScheduleWorkspace` 增加 isSystem 旁路 |
| `src/main/agent/schedule/index.ts` | 启动时初始化系统内置任务；executeSchedule 传 is_system |
| `src/main/agent/loop/controller.ts` | mainLoop 增加 `runMemoryPreStep()`；初始化时调用 `restoreMemoryState()` |
| `src/main/agent/ipc/scheduleIPC.ts` | 增加 restore-default IPC |
| `src/main/agent/tools/builtin/systemManageTool.ts` | zod schema 扩展 `memory` 分类；get_settings 输出增加 memory |
| `src/renderer/hooks/useScheduleListState.ts` | Tab 改为 4 个；matchesTab 增加 is_system |
| `src/renderer/components/dialogs/ScheduleDialog.tsx` | Tab 按钮改为 4 个；新建按钮条件显示 |
| `src/renderer/components/dialogs/ScheduleCard.tsx` | 系统任务：隐藏删除、显示还原默认 |
| `src/renderer/components/dialogs/ScheduleEditModal.tsx` | 系统任务：锁定部分字段 |
| `src/renderer/stores/scheduleStore.ts` | 查询 API 增加 is_system 参数 |

### 实现顺序

1. **DB 迁移** — is_system 字段 + 历史清理
2. **类型 & 仓库层** — ScheduleRecord 扩展、ScheduleRepository 映射
3. **scheduleWorkspace 旁路** — isSystem 参数 + executeSchedule 调用修改
4. **系统任务默认配置 & 初始化** — systemSchedules.ts + 启动检查
5. **记忆模块** — memoryLoader/memoryStore + memoryPublish pre-step + restoreMemoryState
6. **Controller 集成** — 在 mainLoop 中挂载 runMemoryPreStep + restoreMemoryState 调用
7. **系统设置** — systemManageTool zod schema 扩展 + memory.enabled
8. **前端 UI** — Tab 改造、系统任务卡片、编辑限制、还原默认、禁用确认
9. **测试** — 见 §8

## 8. 测试用例

### 8.1 记忆注入测试

| # | 用例 | 预期 |
|---|------|------|
| M1 | 新会话首请求，mem/ 目录存在且有内容 | 注入记忆消息，digest 存入消息 metadata.memoryDigest |
| M2 | 同会话第二轮 | digest 不变，跳过注入 |
| M3 | mem/ 目录不存在 | 静默跳过，无错误，不中断 mainLoop |
| M4 | memory.enabled=false | 不注入，无异常 |
| M5 | workspace_path 在 index.json 中 | 注入 SKILL.md + preferences + 项目记忆 |
| M6 | workspace_path 不在 index.json 中 | 仅注入 SKILL.md + preferences |
| M7 | 记忆文件被积累任务更新（digest 变化） | 下一轮追加新记忆消息 |
| M8 | 崩溃重启后会话恢复 | restoreMemoryState 从消息历史恢复 lastMemoryDigest |
| M9 | schedule 会话（channel='schedule'） | 跳过记忆注入 |
| M10 | runMemoryPreStep 内部异常 | 不中断 mainLoop，记录日志 |
| M11 | 两个 workspace_path 同名（如 .../hclaw 和 .../hclaw） | index.json 完整 key 精确匹配；目录名 hash 后缀避免冲突 |

### 8.2 积累任务测试

| # | 用例 | 预期 |
|---|------|------|
| A1 | 首次运行（无 .state.json） | 分析全部历史，创建 ref 目录 + index.json + SKILL.md |
| A2 | 二次运行（有 .state.json） | 只处理新会话 |
| A3 | 无新会话 | 输出"无新会话"，不修改任何文件 |
| A4 | 新项目出现 | 创建 ref/{dir}/memory.md + 更新 index.json + 更新 SKILL.md 索引 |
| A5 | 文件超限时 | 合并精简旧条目，不超限 |
| A6 | 任务中途失败 | .state.json 未更新，下次重试 |
| A7 | 积累任务自身的会话（channel='schedule'） | SQL 查询过滤，不分析 |
| A8 | 同名目录冲突 | index.json 用完整 key 区分，目录名加 hash 后缀 |

### 8.3 UI 测试

| # | 用例 | 预期 |
|---|------|------|
| U1 | 用户 Tab | 只显示 is_system=0 的任务 |
| U2 | 系统任务 Tab | 只显示 is_system=1 的任务 |
| U3 | 系统任务 Tab 的新建按钮 | 隐藏 |
| U4 | 删除系统任务 | 按钮 disabled 或点击提示不可删除 |
| U5 | 编辑系统任务 | name/task_type/task_target 字段 disabled |
| U6 | 还原默认 | 弹确认 → 覆盖 description/cron/args |
| U7 | 禁用记忆沉淀 | 弹确认 → 同步关闭 memory.enabled |
| U8 | 重新启用记忆沉淀 | 不自动开启 memory.enabled |
| U9 | 启用 Tab | 显示用户+系统任务中 enabled=1 的 |
| U10 | 禁用 Tab | 显示用户+系统任务中 enabled=0 的 |

### 8.4 迁移测试

| # | 用例 | 预期 |
|---|------|------|
| D1 | 048 迁移后 existing schedules | is_system 全部为 0 |
| D2 | 049 迁移后 memory_tasks 表 | 不存在 |
| D3 | 049 迁移后 tools 表 | 无 memory_search/memory_save |
| D4 | 应用启动后系统任务初始化 | schedules 表有 is_system=1 的记忆沉淀任务 |
| D5 | 应用启动后已有系统任务 | 不覆盖用户修改，保持现有配置 |

### 8.5 边界测试

| # | 用例 | 预期 |
|---|------|------|
| E1 | 积累任务写文件时，runMemoryPreStep 同时读 | mtime 缓存检测到变化，重新读取；最坏情况读到部分写入，digest 与上一轮不同，下一轮修正 |
| E2 | 大量项目（20+） | SKILL.md 索引保持在 2KB 内（精简为项目名+文件路径） |
| E3 | workspace_path 为空字符串 | 跳过该项目，不创建 ref 目录 |
| E4 | system_manage 设置 memory.enabled=true 但 schedule.enabled=false | 记忆注入启用但无新积累，使用旧记忆文件 |
| E5 | system_manage 设置 memory.enabled=false 但 schedule.enabled=true | 定时任务继续运行更新文件，但不注入会话 |

## 9. 修订日志

### v2（2026-09-18 复审修订）

| 编号 | 问题 | 修复 |
|------|------|------|
| P1 | 系统任务 workspace_id=null 无法执行 | §5 增加 scheduleWorkspace is_system 旁路；任务配置增加 workspace_id=null 说明 |
| P2 | system_manage schema 不支持 memory key | §6 明确扩展 zod schema 增加 memory 分类；修改文件清单增加 systemManageTool.ts |
| P3 | index.json 未在积累步骤中 | 积累 prompt 拆分为步骤 6（更新 index.json）和步骤 7（更新 SKILL.md），明确两者职责 |
| P4 | 积累会话被注入记忆 | §3 增加 schedule 会话跳过逻辑（channel='schedule' 不注入） |
| P5 | digest 恢复未设计 | §3 增加 Digest 状态持久化与崩溃恢复（restoreMemoryState），消息 metadata 存储 memoryDigest |
| P6 | 项目名冲突 | §2 增加 index.json 结构与冲突处理策略（完整 key + hash 后缀） |
| P7 | 积累会话自引用 | 步骤 1-3 的 SQL 查询增加 `json_extract(meta, '$.channel') != 'schedule'` 过滤 |
| P8 | 无测试用例 | 新增 §8 完整测试用例（注入 11 项 + 积累 8 项 + UI 10 项 + 迁移 5 项 + 边界 5 项） |
| D1 | "更新索引"歧义 | 拆分为步骤 6（index.json）和步骤 7（SKILL.md），明确各自职责 |
| D2 | "首次请求"vs"每轮" | §3 注释说明"技术上每轮检查，digest 门控确保只在内容变化时注入" |
