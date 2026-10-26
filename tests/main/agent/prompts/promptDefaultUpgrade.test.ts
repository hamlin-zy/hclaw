/**
 * 内置提示词节点默认值升级机制测试
 *
 * 覆盖判定链三层保证：
 *   1. 基线命中 —— 内容等于上一版默认值 → 整体替换为当前默认值。
 *   2. 锚点补丁 —— 用户改过时只做精确旧段落替换；锚点不命中即跳过（绝不误覆盖）。
 *   3. 幂等 —— 迁移后二次运行全部 noop/skipped，内容不变。
 */
import {createHash} from 'node:crypto'
import {describe, expect, it} from 'vitest'
import {PROMPT_NODE_MIGRATIONS, runPromptNodeMigrations} from '../../../../src/main/agent/prompts/promptDefaultUpgrade'
import {getPromptNodeByKey} from '../../../../src/shared/prompts'

// ─── 上一版 system.routing 默认值（修复前随之分发，逐字）──────
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

// ─── 上一版 system.memory 默认值（修复前，逐字）──────
const MEMORY_DEFAULT_V1 = `## 记忆与知识

你的可用工具中可能包含记忆/知识系统（工具名含 \`memory\` / \`vault\` / \`knowledge\` / \`recall\` / \`store\` 等关键词，或描述涉及"持久化"、"存储"、"检索"、"上下文"等概念）。

若找到这样的工具，按以下流程使用：
1. **任务开始前** → 调用查询类工具获取相关上下文
2. **任务完成后** → 调用存储类工具保存关键发现（架构决策、可复用模式、踩坑记录等）

若未找到 → 忽略本规则`

function newDefault(): string {
    const node = getPromptNodeByKey('system.routing')
    if (!node) throw new Error('system.routing 节点缺失')
    return node.defaultValue
}

function migrate(content: string) {
    return runPromptNodeMigrations('system.routing', content)
}

function migrateById(id: string, content: string) {
    const migration = PROMPT_NODE_MIGRATIONS.find((m) => m.id === id)
    if (!migration) throw new Error(`migration not found: ${id}`)
    return migration.apply(content)
}

describe('promptDefaultUpgrade — 默认值守卫', () => {
    it('新默认值含「委派节奏」段，且旧标题/旧句式已消失（防锚点漂移）', () => {
        const defaultValue = newDefault()
        expect(defaultValue).toContain('### 委派节奏：先铺开，再收敛')
        expect(defaultValue).not.toContain('### 委派优先级')
        expect(defaultValue).not.toContain('一次委派一个')
    })

    it('迁移注册表覆盖 system.routing 且 id 稳定', () => {
        const ids = PROMPT_NODE_MIGRATIONS.map((m) => m.id)
        // system.output 的两条锚点补丁串行追加：先补「思考不预写正文」，
        // 再以该条目为锚点补「图表辅助」（8ac5da4，见 promptDefaultUpgrade.ts:238）
        expect(ids).toEqual([
            'routing-refresh-baseline',
            'routing-patch-duty-bullet',
            'routing-patch-priority-block',
            'output-refresh-baseline',
            'output-patch-thinking-bullet',
            'output-patch-mermaid-bullet',
            'memory-refresh-baseline',
            // system.workflow：baseline 必须排在锚点条目之前（先整体刷新，再定向补丁）
            'workflow-refresh-baseline-tool-split',
            'workflow-patch-tool-split',
        ])
        expect(PROMPT_NODE_MIGRATIONS.filter((m) => m.nodeKey === 'system.routing')).toHaveLength(3)
        expect(PROMPT_NODE_MIGRATIONS.filter((m) => m.nodeKey === 'system.output')).toHaveLength(3)
        expect(PROMPT_NODE_MIGRATIONS.filter((m) => m.nodeKey === 'system.memory')).toHaveLength(1)
        expect(PROMPT_NODE_MIGRATIONS.filter((m) => m.nodeKey === 'system.workflow')).toHaveLength(2)
    })
})

// ─── system.memory：记忆机制改述 ────────────────────────────

describe('memory-refresh-baseline — 基线命中与用户修改保护', () => {
    it('传入旧默认值全文 → applied，内容等于当前默认值', () => {
        const result = migrateById('memory-refresh-baseline', MEMORY_DEFAULT_V1)
        expect(result.outcome).toBe('applied')
        expect(result.content).toBe(getPromptNodeByKey('system.memory')!.defaultValue)
    })

    it('用户改过（不等于 baseline）→ skipped，内容逐字不动', () => {
        const mine = '## 记忆与知识\n\n我自己的记忆规则\n'
        const result = migrateById('memory-refresh-baseline', mine)
        expect(result.outcome).toBe('skipped')
        expect(result.content).toBe(mine)
    })

    it('已是新默认值 → 不产生写盘（noop）', () => {
        const latest = getPromptNodeByKey('system.memory')!.defaultValue
        const result = migrateById('memory-refresh-baseline', latest)
        expect(result.outcome).not.toBe('applied')
    })

    it('脏输入不抛异常（单条脏记录不阻断启动，防 T7）', () => {
        expect(() => migrateById('memory-refresh-baseline', '')).not.toThrow()
        expect(() => migrateById('memory-refresh-baseline', '   ')).not.toThrow()
    })

    it('baseline 快照守卫：MEMORY_DEFAULT_V1 的 trim 后 sha1 钉死为历史值', () => {
        // ── 这是**历史值快照，勿改**。它红了 = MEMORY_DEFAULT_V1 被改动（哪怕只改一个错别字）──
        // 后果：memory-refresh-baseline 的基线比对（contentHash）再也命不中存量会话，
        //       迁移对所有存量会话静默 skipped（fail-closed 表现为"漏升级"而非报错，很难被发现）。
        // 口径与 src/main/agent/prompts/promptDefaultUpgrade.ts 的 contentHash 一致：trim 后内容 sha1。
        // 若确需重建 baseline：先同步推进 controller.ts 的 PROMPT_REVISION（让存量会话系统提示词重建的
        // 唯一手动闸门），再更新此快照。
        expect(createHash('sha1').update(MEMORY_DEFAULT_V1.trim(), 'utf-8').digest('hex')).toBe(
            '23e08187103189b7199857cc5c24f571e4850ad8',
        )
    })
})

describe('routing-refresh-baseline — 基线命中', () => {
    it('传入旧默认值全文 → applied，内容等于新默认值', () => {
        const result = migrate(ROUTING_DEFAULT_V1)
        expect(result.applied).toContain('routing-refresh-baseline')
        expect(result.content).toBe(newDefault())
    })

    it('内容已等于新默认值 → 全部 noop/skipped，内容不变', () => {
        const result = migrate(newDefault())
        expect(result.applied).toEqual([])
        expect(result.content).toBe(newDefault())
    })

    it('tail 空白（repository 存原文）不影响基线命中', () => {
        const result = migrate(`\n${ROUTING_DEFAULT_V1}\n\n`)
        expect(result.applied).toContain('routing-refresh-baseline')
        expect(result.content).toBe(newDefault())
    })
})

describe('幂等性', () => {
    it('对基线迁移结果再跑一次 → 全部 noop/skipped，内容不变', () => {
        const first = migrate(ROUTING_DEFAULT_V1)
        const second = migrate(first.content)
        expect(second.applied).toEqual([])
        expect(second.content).toBe(first.content)
    })

    it('对锚点迁移结果再跑一次 → 全部 noop/skipped，内容不变', () => {
        const userEdited = ROUTING_DEFAULT_V1.replace('### 价值主张', '### 我们的价值主张')
        const first = migrate(userEdited)
        expect(first.applied.length).toBeGreaterThan(0)
        const second = migrate(first.content)
        expect(second.applied).toEqual([])
        expect(second.content).toBe(first.content)
    })
})

describe('锚点补丁 — 用户改过时', () => {
    it('完全自定义文本 → 不命中任何锚点，内容原样保留（不误覆盖）', () => {
        const custom = '## 我自己的分发协议\n\n这里是完全自定义的内容，与旧版毫无重合。\n'
        const result = migrate(custom)
        expect(result.applied).toEqual([])
        expect(result.content).toBe(custom)
    })

    it('用户只改了「价值主张」段 → 职责分界与优先级块被替换，其余保持原样', () => {
        const userEdited = ROUTING_DEFAULT_V1.replace(
            '### 价值主张\n每次委派让子 agent 用最小上下文做单一职责，精度更高、单次成本更低，且不撑大主会话上下文。效率与准确的来源是**分工**，不是主会话亲力亲为。',
            '### 价值主张\n我们团队自己的价值主张，与默认无关。',
        )
        const result = migrate(userEdited)

        expect(result.applied).toContain('routing-patch-duty-bullet')
        expect(result.applied).toContain('routing-patch-priority-block')
        // 用户改动保留
        expect(result.content).toContain('我们团队自己的价值主张，与默认无关。')
        // 职责分界锚点命中
        expect(result.content).toContain('**同批并列派出**')
        expect(result.content).toContain('- **名称模糊** → 先读 description 与触发条件（whenToUse）确认。')
        // 优先级块锚点命中
        expect(result.content).toContain('### 委派节奏：先铺开，再收敛')
        expect(result.content).not.toContain('### 委派优先级')
        // 未触及的段落原样
        expect(result.content).toContain('- **Explore** — 查代码、追实现、理架构、定位根因（只读）。')
    })

    it('CRLF 版本的锚点文本同样命中，且结果保持 CRLF', () => {
        const crlf = ROUTING_DEFAULT_V1.replace(/\n/g, '\r\n')
        const result = migrate(crlf)

        expect(result.applied).toContain('routing-patch-duty-bullet')
        expect(result.applied).toContain('routing-patch-priority-block')
        expect(result.content).toContain('### 委派节奏：先铺开，再收敛')
        expect(result.content).toContain('**同批并列派出**')
        expect(result.content).toContain('\r\n')
        expect(result.content).not.toMatch(/[^\r]\n/)
    })

    it('「名称模糊」行已存在时不重复追加', () => {
        const already = ROUTING_DEFAULT_V1
            .replace(
                '- **认知型/多步/跨领域**（调研、定位、设计、修复、验证、审查）→ **主动委派**给专职 agent，一次一个。',
                '- **认知型/多步/跨领域**（调研、定位、设计、修复、验证、审查）→ **主动委派**给专职 agent：一件职责配一个 agent，但彼此无依赖的多件**同批并列派出**。\n- **名称模糊** → 先读 description 与触发条件（whenToUse）确认。',
            )
        const result = migrateById('routing-patch-duty-bullet', already)
        expect(result.outcome).toBe('noop')
        expect(result.content).toBe(already)
        expect(result.content.match(/- \*\*名称模糊\*\*/g)?.length).toBe(1)
    })

    it('锚点缺失（用户改写了该行）→ skipped，内容原样', () => {
        const userEdited = ROUTING_DEFAULT_V1.replace(
            '- **认知型/多步/跨领域**（调研、定位、设计、修复、验证、审查）→ **主动委派**给专职 agent，一次一个。',
            '- **认知型/多步/跨领域** → 我自己处理。',
        )
        const result = migrateById('routing-patch-duty-bullet', userEdited)
        expect(result.outcome).toBe('skipped')
        expect(result.reason).toBe('anchor-miss-duty-bullet')
        expect(result.content).toBe(userEdited)
    })

    it('优先级块锚点缺失 → skipped，内容原样', () => {
        const userEdited = ROUTING_DEFAULT_V1.replace('### 委派优先级\n', '### 我的优先级\n')
        const result = migrateById('routing-patch-priority-block', userEdited)
        expect(result.outcome).toBe('skipped')
        expect(result.reason).toBe('anchor-miss-priority-block')
        expect(result.content).toBe(userEdited)
    })
})

// ─── system.output：思考不预写正文 ──────────────────────────

const OUTPUT_DEFAULT_V1 = `## 输出规范

- **结论先行** — 直接回答，不要铺垫
- **简洁** — 不用 emoji（除非用户要求），不重复用户的话
- **可追溯** — 引用代码用 \`file:line\`，GitHub 用 \`owner/repo#123\`
- **高效更新** — 增量修改时简短说明变更即可`

function newOutputDefault(): string {
    const node = getPromptNodeByKey('system.output')
    if (!node) throw new Error('system.output 节点缺失')
    return node.defaultValue
}

function migrateOutput(content: string) {
    return runPromptNodeMigrations('system.output', content)
}

describe('system.output — 思考不预写正文', () => {
    it('新默认值含「思考不预写正文」条目，且旧默认值全文不含该条目（防误判已升级）', () => {
        expect(newOutputDefault()).toContain('- **思考不预写正文**')
        expect(OUTPUT_DEFAULT_V1).not.toContain('思考不预写正文')
    })

    it('旧默认值全文 → 基线命中，整体替换为新默认值', () => {
        const result = migrateOutput(OUTPUT_DEFAULT_V1)
        expect(result.applied).toContain('output-refresh-baseline')
        expect(result.content).toBe(newOutputDefault())
    })

    it('用户改过输出规范 → 基线跳过，只追加新条目（其余自定义保留）', () => {
        const userEdited = OUTPUT_DEFAULT_V1.replace('- **简洁** — 不用 emoji（除非用户要求），不重复用户的话', '- **简洁** — 我们团队要求极简输出')
        const result = migrateOutput(userEdited)

        // 两条补丁串行追加：mermaid 条目以已补入的 thinking 条目为锚点
        expect(result.applied).toEqual(['output-patch-thinking-bullet', 'output-patch-mermaid-bullet'])
        expect(result.content).toContain('- **简洁** — 我们团队要求极简输出')
        expect(result.content).toContain('- **思考不预写正文**')
        // 只追加一条，不重复
        expect(result.content.match(/- \*\*思考不预写正文\*\*/g)?.length).toBe(1)
    })

    it('已含新条目 → 幂等 noop', () => {
        const result = migrateOutput(newOutputDefault())
        expect(result.applied).toEqual([])
        expect(result.content).toBe(newOutputDefault())
    })

    it('CRLF 版本命中的锚点保持 CRLF 风格', () => {
        const crlf = OUTPUT_DEFAULT_V1.replace(/\n/g, '\r\n')
        const result = migrateOutput(crlf)
        expect(result.applied).toContain('output-patch-thinking-bullet')
        expect(result.content).toContain('\r\n')
        expect(result.content).not.toMatch(/[^\r]\n/)
    })

    it('锚点行被用户改写 → skipped，内容原样（不误覆盖）', () => {
        const userEdited = OUTPUT_DEFAULT_V1.replace('- **高效更新** — 增量修改时简短说明变更即可', '- **高效更新** — 我们自己决定怎么写')
        const result = migrateById('output-patch-thinking-bullet', userEdited)
        expect(result.outcome).toBe('skipped')
        expect(result.reason).toBe('anchor-miss-output-last-line')
        expect(result.content).toBe(userEdited)
    })
})

// ─── system.workflow：工具分工规则 ──────────────────────────

// 上一版 system.workflow 默认值（修复前随之分发，逐字）
const WORKFLOW_DEFAULT_V1 = `## 工作流程

1. **先读后写** — 修改前先阅读现有上下文再动手，若用户提供了知识库、记忆能力，需要先查询相关知识&记忆。
2. **能力探索** — 不清楚怎么实现或不确定质量标准时，先看可用能力中的 skill/agent/命令，按关键词猜测用途。命令（/开头）提供了特定任务的方法论和质量标准，即使不可直接调用也应参考其规范
3. **最小变更** — 只改必须改的部分，不引入未要求的抽象
4. **并行效率** — 多个独立操作用并行工具调用一次完成（如同时搜索多个关键词、同时读取多个文件）
5. **精准搜索** — 优先用 grep 搜索关键词，避免宽泛的 glob 模式
6. **确认存在** — 引用文件路径前先确认文件存在，不编造路径
7. **验证闭环** — 修改后验证结果，确认不引入回归
8. **追踪遗留** — 无法立即修复的问题用 task_create 记录（含位置和修复建议）`

const WORKFLOW_TOOL_SPLIT_LINE = `6. **工具分工** — 读文件用 file_read（大文件带 offset/limit），改文件用 file_edit，新建或整体覆盖用 file_write；bash 仅用于构建、测试、git、进程等 shell 操作。file_edit 未匹配时先用 file_read 重读目标片段，连续 2 次失败再降级为 bash 重写并说明原因。`

function newWorkflowDefault(): string {
    const node = getPromptNodeByKey('system.workflow')
    if (!node) throw new Error('system.workflow 节点缺失')
    return node.defaultValue
}

function migrateWorkflow(content: string) {
    return runPromptNodeMigrations('system.workflow', content)
}

describe('system.workflow — 工具分工规则', () => {
    it('新默认值含第 6 条工具分工，且原 6-8 条顺延为 7-9（防锚点漂移）', () => {
        const defaultValue = newWorkflowDefault()
        expect(defaultValue).toContain(WORKFLOW_TOOL_SPLIT_LINE)
        expect(defaultValue).toContain('7. **确认存在**')
        expect(defaultValue).toContain('8. **验证闭环**')
        expect(defaultValue).toContain('9. **追踪遗留**')
        // 旧默认值不含新条目 → 基线命中不会被误判为「已是最新」
        expect(WORKFLOW_DEFAULT_V1).not.toContain('工具分工')
    })

    it('baseline 快照守卫：WORKFLOW_DEFAULT_V1 的 trim 后 sha1 钉死为历史值', () => {
        // ── 这是**历史值快照，勿改**。它红了 = WORKFLOW_DEFAULT_V1 被改动（哪怕只改一个错别字）──
        // 后果：workflow-refresh-baseline-tool-split 的基线比对（contentHash）再也命不中存量会话，
        //       迁移对所有存量会话静默 skipped（fail-closed 表现为"漏升级"而非报错，很难被发现）。
        // 口径与 src/main/agent/prompts/promptDefaultUpgrade.ts 的 contentHash 一致：trim 后内容 sha1。
        expect(createHash('sha1').update(WORKFLOW_DEFAULT_V1.trim(), 'utf-8').digest('hex')).toBe(
            'ecd1ac09a4d3ba57748d89be037c528a7c6ee07b',
        )
    })

    it('baseline 命中（旧默认值全文）→ applied，内容等于当前默认值', () => {
        const result = migrateById('workflow-refresh-baseline-tool-split', WORKFLOW_DEFAULT_V1)
        expect(result.outcome).toBe('applied')
        expect(result.content).toBe(newWorkflowDefault())
    })

    it('用户改过（不等于 baseline）→ baseline skipped，内容逐字不动', () => {
        const mine = '## 工作流程\n\n1. 我们自己的流程\n'
        const result = migrateById('workflow-refresh-baseline-tool-split', mine)
        expect(result.outcome).toBe('skipped')
        expect(result.reason).toBe('user-modified-baseline-miss')
        expect(result.content).toBe(mine)
    })

    it('锚点命中（用户改过但保留「精准搜索」行）→ applied，只追加工具分工条目', () => {
        const userEdited = WORKFLOW_DEFAULT_V1.replace('1. **先读后写**', '1. **先读后写（我们团队强调）**')
        const result = migrateById('workflow-patch-tool-split', userEdited)
        expect(result.outcome).toBe('applied')
        // 用户改动保留
        expect(result.content).toContain('1. **先读后写（我们团队强调）**')
        // 新条目紧随「精准搜索」之后，且只出现一次
        expect(result.content).toContain(`5. **精准搜索** — 优先用 grep 搜索关键词，避免宽泛的 glob 模式\n${WORKFLOW_TOOL_SPLIT_LINE}`)
        expect(result.content.match(/工具分工/g)?.length).toBe(1)
    })

    it('锚点缺失（用户改写了「精准搜索」行）→ skipped，内容原样', () => {
        const userEdited = WORKFLOW_DEFAULT_V1.replace(
            '5. **精准搜索** — 优先用 grep 搜索关键词，避免宽泛的 glob 模式',
            '5. **搜索** — 我自己决定怎么搜',
        )
        const result = migrateById('workflow-patch-tool-split', userEdited)
        expect(result.outcome).toBe('skipped')
        expect(result.reason).toBe('anchor-miss-workflow-tool-split')
        expect(result.content).toBe(userEdited)
    })

    it('已含新条目 → 幂等 noop（already-satisfied）', () => {
        const result = migrateById('workflow-patch-tool-split', newWorkflowDefault())
        expect(result.outcome).toBe('noop')
        expect(result.reason).toBe('already-satisfied')
    })

    it('重复执行：baseline 应用结果再跑一次 → 全部 noop，内容不变', () => {
        const first = migrateWorkflow(WORKFLOW_DEFAULT_V1)
        expect(first.applied).toEqual(['workflow-refresh-baseline-tool-split'])
        const second = migrateWorkflow(first.content)
        expect(second.applied).toEqual([])
        expect(second.content).toBe(first.content)
    })

    it('重复执行：锚点应用结果再跑一次 → 全部 noop，内容不变', () => {
        const userEdited = WORKFLOW_DEFAULT_V1.replace('1. **先读后写**', '1. **先读后写（我们团队强调）**')
        const first = migrateWorkflow(userEdited)
        expect(first.applied).toEqual(['workflow-patch-tool-split'])
        const second = migrateWorkflow(first.content)
        expect(second.applied).toEqual([])
        expect(second.content).toBe(first.content)
    })

    it('脏输入不抛异常', () => {
        expect(() => migrateWorkflow('')).not.toThrow()
        expect(() => migrateWorkflow('   ')).not.toThrow()
    })
})
