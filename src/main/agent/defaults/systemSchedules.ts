/**
 * 系统内置定时任务的默认配置 — 出厂值（唯一真相）。
 *
 * 系统任务（isSystem=true）受保护：不可删除（见 scheduleOps.deleteSchedule），
 * 但可修改。改乱后可用 restoreSystemSchedule 从此处的默认配置覆盖回去。
 *
 * 应用启动时由 scheduler/index.ts 调用 ensureSystemSchedules 补齐缺失的系统任务。
 */
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

## 记忆准入规则（写任何文件前先过这一关）
准入——值得沉淀的：
- 用户明确要求记住的内容、多次重复强调的要求
- 稳定的协作约定与授权边界（如何协作、什么必须请示）
- 可复用的经验与坑：模式级结论（缺陷模式 + 修复口诀）
- 项目契约：关键路径、字段命名、命令、流程骨架
排除——不沉淀的（这些归备忘录 / 任务系统 / git 提交正文）：
- 进行中任务的状态快照、未拍板的方案、待验证清单
- commit hash 清单、逐文件逐行的修复过程（只保留「模式 + 口诀」级结论）
- 无结论的一次性探索会话（不建目录、不写文件、不进索引）
- 中途放弃/被打断会话（assistant 摘要以被打断口吻收尾、无收束结论）——只允许提取「用户明确要求」类内容，禁止提取 assistant 的中途结论
判断口诀：半年后的新会话读到这条，还能指导行动吗？不能就不写。

## 前置：读取状态
用 file_read 读取 {hclawDir}/mem/.state.json，获取 lastAnalyzedAt 和 lastConversationId。
如果文件不存在，lastAnalyzedAt 设为 0（分析全部历史）。

## 步骤 1：查询新会话（带冷却期）
用 hclaw_db_query 查询自 lastAnalyzedAt 之后的会话，排除定时任务自身产生的会话。
冷却期：必须排除最近 30 分钟内仍有更新的会话——它们可能正在运行，半成品摘要不是终稿；
跳过的会话留待下一轮（updated_at 会继续大于 lastAnalyzedAt，自然补上）。
冷却截止 = 当前时间戳 - 30*60*1000。
注意：必须用 IFNULL 包住 json_extract——大多数会话的 meta JSON 里没有 channel 键，
json_extract 返回 SQL NULL，NULL != 'schedule' 结果为 NULL（非真），会把这些行全部漏掉。
SELECT id, workspace_path, meta, created_at, updated_at
FROM conversations
WHERE updated_at > {lastAnalyzedAt}
  AND updated_at < {冷却截止时间戳}
  AND (IFNULL(json_extract(meta, '$.channel'), '') != 'schedule')
ORDER BY updated_at ASC
如果没有新会话，直接结束，输出"无新会话"。

## 步骤 2：按工作目录分组（带质量门槛）
按 workspace_path 分组会话。过滤掉 workspace_path 为空的会话。
对每个 workspace_path，取最后一级目录名作为项目名。
质量门槛：剔除消息总数 < 3 的会话（一问即弃、纯探索）——
SELECT conversation_id, COUNT(*) AS n FROM messages GROUP BY conversation_id，
保留 n >= 3 的会话再进入步骤 3。

## 步骤 3：提取对话内容（三块数据，控制数据量）
只处理步骤 2 中已过冷却期且通过质量门槛的会话。
对每个项目，分三块提取对话内容：

### 块 1：用户消息
SELECT m.id AS msg_id, m.timestamp, mb.content
FROM messages m
JOIN message_blocks mb ON mb.message_id = m.id
WHERE m.conversation_id IN (
  SELECT id FROM conversations
  WHERE workspace_path = '{workspace_path}'
    AND updated_at > {lastAnalyzedAt}
    AND updated_at < {冷却截止时间戳}
    AND (IFNULL(json_extract(meta, '$.channel'), '') != 'schedule')
)
  AND m.role = 'user'
  AND mb.block_type = 'text'
  AND mb.content IS NOT NULL
  AND length(mb.content) > 20
  AND mb.content NOT LIKE '<system-reminder>%'
ORDER BY m.timestamp ASC, mb.sequence ASC

### 块 2：ask_user 响应
SELECT mb.message_id, mb.data
FROM message_blocks mb
WHERE mb.block_type = 'tool_call'
  AND json_extract(mb.data, '$.name') = 'ask_user'
  AND mb.message_id IN (
    SELECT m.id FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.workspace_path = '{workspace_path}'
      AND c.updated_at > {lastAnalyzedAt}
      AND c.updated_at < {冷却截止时间戳}
      AND (IFNULL(json_extract(c.meta, '$.channel'), '') != 'schedule')
  )
然后对每个 tool_call，用其 toolCallId 查 tool_result 的 output。

### 块 3：Assistant 最终摘要
SELECT m.id AS msg_id, m.timestamp, mb.turn_index, mb.content
FROM messages m
JOIN message_blocks mb ON mb.message_id = m.id
WHERE m.conversation_id IN (
  SELECT id FROM conversations
  WHERE workspace_path = '{workspace_path}'
    AND updated_at > {lastAnalyzedAt}
    AND updated_at < {冷却截止时间戳}
    AND (IFNULL(json_extract(meta, '$.channel'), '') != 'schedule')
)
  AND m.role = 'assistant'
  AND mb.block_type = 'text'
  AND mb.content IS NOT NULL
  AND length(mb.content) > 50
ORDER BY m.timestamp ASC, mb.sequence ASC
对同一 msg_id，只取 sequence 最大的（最后一条 text 块）。
注意：每个会话只取最后一轮的 assistant 摘要作为「终稿」依据，中间轮次的摘要只是过程稿，
仅当终稿缺失（会话中途被打断）时才参考，且按准入规则不得从中提取结论。

### 数据量控制
- 每个项目最多取最近 30 条会话
- 每个会话最多提取前 20 条用户消息 + 20 条 ask_user 响应 + 10 条 assistant 摘要
- 超限时取最近的，跳过旧的

## 步骤 4：分析与提取
逐项目分析对话内容，特别关注：
- 用户多次强调的内容、明确要求"记住"的内容（来自块 1）
- 用户主动填写的偏好、决策选择、风格倾向（来自块 2）
- 常用技能组合、工作模式、项目特定约定（来自块 3）
提取前先过「记忆准入规则」：命中排除项的内容直接丢弃，不进任何文件。

## 步骤 5：更新项目记忆文件
对每个项目：
- 准入判断：本次无可沉淀内容的新项目 → 不建目录、不写文件、不进索引
- 注意：{项目名}（workspace_path 最后一级，步骤 2）与 {dir}（ref/ 下目录名，步骤 6）是两个值——目录名冲突时 {dir} 带 hash 后缀，勿混淆
- memory.md 固定骨架，新内容归入既有段落，禁止新建平行标题段：
  # 项目记忆：{项目名}
  ## 项目背景
  ## 协作约定（用户明确要求）
  ## 已知坑 / 经验
  ## 开发工作流
  ## git 纪律（仅代码类项目需要）
  ## 归档卷（仅当 archive/ 下有卷时保留此段）
- 写入前必须通读现有 memory.md 全文，执行合并纪律：
  - 禁止出现重复标题段（发现即合并——曾出现过两个「## 项目背景」）
  - 同主题条目改写而非追加
  - 过时内容直接删除（原始对话在数据库永久可查，记忆不怕删）
- 大小闭环（不可跳过）：
  1. file_write 写入 ref/{dir}/memory.md
  2. bash 实测字节数：(Get-Item '{hclawDir}/mem/ref/{dir}/memory.md').Length
  3. 超过 8192 字节 → 把「细节层」压缩为「模式层」（文件行号、修复过程、commit hash 压成一句话结论 + 口诀）；被压缩的细节原文移入 ref/{dir}/archive/{yyyy-MM}-{专项名}.md
     - 归档卷按专项/主题拆分：同专项续用既有卷，新专项开新卷，专项完结即封卷不再追加
     - 无明确专项的杂项用 {yyyy-MM}-misc.md
     - 例外：稳定复用的同类型积累（如缺陷模式库）允许开 archive/patterns.md 类型卷，需在 memory.md 归档段注明
  4. 重测直到 ≤8192，禁止凭感觉估算字节数（中文 UTF-8 每字 3 字节，估算不可靠）
- memory.md 末尾维护「归档卷」指针段（一行一卷：卷名 + 一句话内容），主会话靠它发现归档卷
- archive/ 下的卷不进 SKILL.md 索引，卷名自描述

用户级偏好（跨项目通用习惯）：
- 读取现有 ref/_user/preferences.md，合并更新（同样执行合并纪律）
- 上限 4096 字节，同上大小闭环（路径 ref/_user/preferences.md）

## 步骤 6：更新 index.json
读取 ref/index.json（不存在则视为空对象）。
对新出现的 workspace_path，确定项目目录名：
- 取 workspace_path 最后一级目录名作为基础名
- 检查 index.json 中是否已有其他 workspace_path 使用相同目录名
- 如有冲突，目录名追加短 hash 后缀（SHA-256 前 4 位）
- 记录 { workspace_path: { dir, projectName } }
- 未建 memory.md 的项目不登记
用 file_write 写入 index.json。

## 步骤 7：更新 SKILL.md 索引
读取现有 SKILL.md（不存在则创建）。
- 「用户偏好（摘要）」≤4 行，从 ref/_user/preferences.md 提炼
- 「记忆索引」只列活跃项目（memory.md 近 30 天有更新）；轻项目合并为一行列名；未建 memory.md 的项目不出现
- 大小闭环：写后 bash 实测 ≤2048 字节；超限优先删注解文字、折叠轻项目行
用 file_write 写入。

## 步骤 8：过期清理提示（只提示，不自动删）
扫描各项目 archive/ 目录：卷龄超过 6 个月且对应专项已完结的卷，在最终输出中列出"建议删除的归档卷"清单，等用户确认，不自动删除。patterns.md 类型卷（模式库）豁免过期清理。

## 步骤 9：更新状态
用 file_write 更新 .state.json：
{ "lastAnalyzedAt": {当前时间戳}, "lastConversationId": "{最后处理的会话ID}" }

## 约束
- 每个文件严格不超过大小上限，且必须经 bash 实测验证，禁止估算
- 合并而非追加——旧条目与新条目同类时改写合并，禁止重复标题段
- 只记录有价值的习惯，不记录具体对话内容；进行中状态、未拍板方案、commit 清单一律排除归备忘录
- 冷却期与质量门槛的跳过不是丢弃——被跳过的会话仍在时间窗口内，后续轮次自然补上；lastAnalyzedAt 不得因跳过而前移
- 项目经验落地到项目 memory.md，跨项目通用习惯落地到 preferences.md
- index.json 和 SKILL.md 必须在最后统一更新，确保与 ref 文件内容一致`

export const SYSTEM_SCHEDULE_DEFAULTS: SystemScheduleDefault[] = [
  {
    id: 'sys-memory-accumulation',
    name: '记忆沉淀',
    description:
      '每 6 小时分析新会话，沉淀用户习惯与项目经验到 mem/ref/。带准入规则、冷却期、质量门槛、去重纪律、专项卷归档与写后字节实测闭环，防止脏知识与记忆膨胀。',
    cronExpression: '0 * * * *',
    taskType: 'agent',
    taskTarget: 'General',
    taskArgs: [MEMORY_ACCUMULATION_PROMPT],
  },
]

/**
 * 启动时补齐系统内置任务：默认配置里存在而库里没有的，按出厂值创建。
 * 幂等——已存在（含被用户改过）的记录不动。
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
