/**
 * 内置提示词节点默认值升级机制
 *
 * 背景：prompt_scheme_nodes 在创建方案时会**快照**当时的代码 defaultValue；
 * PromptResolver 优先用方案节点覆盖（resolver.ts:resolve），
 * 于是改 prompts.ts 的 defaultValue 对老用户完全无效，且老用户可能手改过该节点。
 *
 * 判定链（安全不变量：失败方向始终是"漏升级"而非"误覆盖"）：
 *   1. 基线命中 —— 节点内容（trim 后）sha1 等于上一版默认值 → 用户从未改过 → 整体替换为新默认值。
 *   2. 锚点补丁 —— 用户改过时，只做"精确旧段落 → 新段落"的定向替换；命中才写，不命中即跳过。
 *   3. 不确定一律不动（fail-closed）。
 *
 * 迁移必须**幂等**：应用后内容已等于新默认值（或旧锚点已消失），二次运行自然 noop。
 * 故不引入 applied-migrations 记录表（与 builtinAgentUpgrade.ts 的取舍一致）。
 */

import * as crypto from 'crypto'
import type {PromptNodeKey} from '@shared/types'
import {getPromptNodeByKey} from '@shared/prompts'

// ─── 结果与迁移类型 ───────────────────────────────────────

export interface PromptMigrationResult {
    outcome: 'applied' | 'noop' | 'skipped'
    content: string
    reason?: string
}

export interface PromptNodeDefaultMigration {
    id: string
    nodeKey: PromptNodeKey
    description: string
    apply(content: string): PromptMigrationResult
}

// ─── 基础工具 ────────────────────────────────────────────

/** 基线/幂等比较统一以 trim 后内容为准（repository 存原文，resolver 读时 trim） */
function contentHash(content: string): string {
    return crypto.createHash('sha1').update(content.trim(), 'utf-8').digest('hex')
}

/** 探测内容的主换行符（首次出现的即视作主风格） */
function detectEol(content: string): string {
    return content.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * 换行符自适应块替换：把锚点与其替换文本都转成内容自身的换行符再匹配/写入。
 * 未命中返回 skipped（fail-closed，绝不猜测）。
 */
function replaceTextBlock(content: string, oldBlock: string, newBlock: string, reason: string): PromptMigrationResult {
    const eol = detectEol(content)
    const oldText = oldBlock.replace(/\n/g, eol)
    const idx = content.indexOf(oldText)
    if (idx === -1) return {outcome: 'skipped', content, reason}
    const newText = newBlock.replace(/\n/g, eol)
    return {outcome: 'applied', content: content.slice(0, idx) + newText + content.slice(idx + oldText.length)}
}

// ─── 上一版 system.routing 默认值（基线 hash 来源，逐字，勿改）──

const ROUTING_DEFAULT_V1 = `## 任务分发协议

你是**导演，不是演员**：认知型工作能委派就委派，主会话只亲自做最轻的原子操作。你负责拆任务、选 agent、下派、接收、合流、汇报，不与子 agent 抢细节。

### 职责分界（成本感知）
- **原子操作**（读文件/跑命令/回一条消息/改一行/查一个值）→ **自己快速做**，不委派。
- **认知型/多步/跨领域**（调研、定位、设计、修复、验证、审查）→ **主动委派**给专职 agent，一次一个。
- **匹配不到合适 agent 且自己能胜任** → 自己做，不卡住。
- **不确定怎么派** → 先问用户，不要闷头选。

### 委派优先级
1. 能**精确匹配专职 agent** → 一次委派一个，等结果回来再决定下一步。
2. 属**多步流水线** → 按依赖串行；互相无依赖 → 同一批并行下派。
3. 名称模糊 → 读 description 与触发条件（whenToUse）确认。

### 强流水线范式（问题排查/开发类）
- **Explore** — 查代码、追实现、理架构、定位根因（只读）。
- **Plan** — 仅复杂/影响面大时用，产出方案（只读）。
- **Implementer** — 按方案实现、修复、产出代码。
- **Verification** — 验收：跑测试、复现、边界与回归，天职是"故意打破它"而非"确认它工作"。
- **Code Reviewer** — 质量/规范/需求符合度，独立对抗视角把关。

### 价值主张
每次委派让子 agent 用最小上下文做单一职责，精度更高、单次成本更低，且不撑大主会话上下文。效率与准确的来源是**分工**，不是主会话亲力亲为。`

// ─── system.routing 锚点（旧 → 新）───────────────────────

/** 职责分界：「主动委派」条目（旧单行 → 新句） */
const ROUTING_DUTY_LINE_OLD = `- **认知型/多步/跨领域**（调研、定位、设计、修复、验证、审查）→ **主动委派**给专职 agent，一次一个。`
const ROUTING_DUTY_LINE_NEW = `- **认知型/多步/跨领域**（调研、定位、设计、修复、验证、审查）→ **主动委派**给专职 agent：一件职责配一个 agent，但彼此无依赖的多件**同批并列派出**。`

/** 职责分界末条：「不确定怎么派」（作为「名称模糊」条目的插入锚点，保持与新版默认值同序） */
const ROUTING_DUTY_LAST_LINE = `- **不确定怎么派** → 先问用户，不要闷头选。`

/** 旧「委派优先级」的第 3 条由该行并入职责分界 */
const ROUTING_NAME_AMBIGUITY_LINE = `- **名称模糊** → 先读 description 与触发条件（whenToUse）确认。`

/** 旧「委派优先级」整段 */
const ROUTING_PRIORITY_BLOCK_OLD = `### 委派优先级
1. 能**精确匹配专职 agent** → 一次委派一个，等结果回来再决定下一步。
2. 属**多步流水线** → 按依赖串行；互相无依赖 → 同一批并行下派。
3. 名称模糊 → 读 description 与触发条件（whenToUse）确认。`

/** 新「委派节奏：先铺开，再收敛」整段（与 prompts.ts 新版默认值逐字一致） */
const ROUTING_PRIORITY_BLOCK_NEW = `### 委派节奏：先铺开，再收敛

拆完任务先问自己一句话：**"这些子任务里，有哪些的输入我现在就能写出来？"**
输入齐备、彼此不依赖的，就是同一批——**在同一轮里一次全部派出，让它们同时跑**。

为什么：并行几乎不花额外成本，串行却要乘上波数。10 个子任务一次派完，
只等最慢的那一个；拆成 3 波，就要等 3 个"最慢的"。**收敛是免费的，分批不是。**

容易踩的两个坑：
- 按"档位/模型角色"分批 —— 并发宽度与 modelRole 无关，不同角色一样能同时跑。
- 按"先看一批结果再继续"分批 —— 除非下一步的输入**真的**依赖上一批输出，否则这只是排队习惯。

唯一该分波的信号：**B 的输入必须等 A 的输出**（真依赖链），
或**需要先探路、再决定是否投入**（试水）。除此之外，一次派完。

派发前自检：*我拆了几波？每波的拆散理由，是"真依赖"，还是"习惯性排队"？*`

const ROUTING_NEW_HEADING = '### 委派节奏：先铺开，再收敛'

// ─── 迁移注册表 ──────────────────────────────────────────

export const PROMPT_NODE_MIGRATIONS: PromptNodeDefaultMigration[] = [
    {
        id: 'routing-refresh-baseline',
        nodeKey: 'system.routing',
        description: 'system.routing 内容等于上一版默认值（用户未改）→ 整体替换为新默认值',
        apply: (content) => {
            const target = getPromptNodeByKey('system.routing')?.defaultValue
            if (!target) return {outcome: 'noop', content, reason: 'no-code-default'}
            if (content.trim() === target.trim()) return {outcome: 'noop', content, reason: 'already-latest'}
            if (contentHash(content) !== contentHash(ROUTING_DEFAULT_V1)) {
                return {outcome: 'skipped', content, reason: 'user-modified-baseline-miss'}
            }
            return {outcome: 'applied', content: target}
        },
    },
    {
        id: 'routing-patch-duty-bullet',
        nodeKey: 'system.routing',
        description: '职责分界：「主动委派」条目改写为同批并列派出，并补入「名称模糊」条目',
        apply: (content) => {
            const hasNewDutyLine = content.includes(ROUTING_DUTY_LINE_NEW)
            const hasNameAmbiguity = content.includes(ROUTING_NAME_AMBIGUITY_LINE)
            if (hasNewDutyLine && hasNameAmbiguity) return {outcome: 'noop', content, reason: 'already-satisfied'}

            let out = content
            let changed = false

            if (!hasNewDutyLine) {
                const step = replaceTextBlock(out, ROUTING_DUTY_LINE_OLD, ROUTING_DUTY_LINE_NEW, 'anchor-miss-duty-bullet')
                if (step.outcome !== 'applied') return {outcome: 'skipped', content, reason: 'anchor-miss-duty-bullet'}
                out = step.content
                changed = true
            }

            // 并入新版默认值末尾（职责分界最后一条之后），保持与新默认值同序
            if (!hasNameAmbiguity) {
                const step = replaceTextBlock(
                    out,
                    ROUTING_DUTY_LAST_LINE,
                    `${ROUTING_DUTY_LAST_LINE}\n${ROUTING_NAME_AMBIGUITY_LINE}`,
                    'anchor-miss-name-ambiguity',
                )
                // 插入锚点缺失不阻断：主体条目已改写即算 applied
                if (step.outcome === 'applied') {
                    out = step.content
                    changed = true
                }
            }

            return changed ? {outcome: 'applied', content: out} : {outcome: 'noop', content, reason: 'already-satisfied'}
        },
    },
    {
        id: 'routing-patch-priority-block',
        nodeKey: 'system.routing',
        description: '「委派优先级」整段替换为「委派节奏：先铺开，再收敛」',
        apply: (content) => {
            if (content.includes(ROUTING_NEW_HEADING)) return {outcome: 'noop', content, reason: 'already-latest'}
            return replaceTextBlock(content, ROUTING_PRIORITY_BLOCK_OLD, ROUTING_PRIORITY_BLOCK_NEW, 'anchor-miss-priority-block')
        },
    },
]

// ─── 迁移执行 ────────────────────────────────────────────

/** 对单个节点依次执行所有适用迁移（幂等：已满足的迁移返回 noop，不产生写盘） */
export function runPromptNodeMigrations(nodeKey: PromptNodeKey, content: string): {content: string; applied: string[]} {
    const applied: string[] = []
    let current = content
    for (const migration of PROMPT_NODE_MIGRATIONS) {
        if (migration.nodeKey !== nodeKey) continue
        const result = migration.apply(current)
        if (result.outcome === 'applied') {
            current = result.content
            applied.push(migration.id)
        }
    }
    return {content: current, applied}
}
