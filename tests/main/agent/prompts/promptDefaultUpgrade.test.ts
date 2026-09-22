/**
 * 内置提示词节点默认值升级机制测试
 *
 * 覆盖判定链三层保证：
 *   1. 基线命中 —— 内容等于上一版默认值 → 整体替换为当前默认值。
 *   2. 锚点补丁 —— 用户改过时只做精确旧段落替换；锚点不命中即跳过（绝不误覆盖）。
 *   3. 幂等 —— 迁移后二次运行全部 noop/skipped，内容不变。
 */
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
        expect(ids).toEqual([
            'routing-refresh-baseline',
            'routing-patch-duty-bullet',
            'routing-patch-priority-block',
            'output-refresh-baseline',
            'output-patch-thinking-bullet',
        ])
        expect(PROMPT_NODE_MIGRATIONS.filter((m) => m.nodeKey === 'system.routing')).toHaveLength(3)
        expect(PROMPT_NODE_MIGRATIONS.filter((m) => m.nodeKey === 'system.output')).toHaveLength(2)
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

        expect(result.applied).toEqual(['output-patch-thinking-bullet'])
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
