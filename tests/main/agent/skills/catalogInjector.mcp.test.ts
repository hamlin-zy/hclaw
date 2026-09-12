/**
 * MCP 工具目录（catalog 通道）单测 —— spec §9.2 / §4.4。
 *
 * 覆盖：
 * 1. 紧凑 schema 渲染（原始 rawInputSchema，非 mcpSchemaToZod 的退化版本）
 * 2. <available_mcp_tools> 文案与 call_mcp_tool 引导
 * 3. 两源独立 digest / 独立消息：MCP 变化不重发技能目录（反之亦然）
 * 4. restoreCatalogState 按 catalogKind 分别倒序扫描 + 旧数据（无 catalogKind）兼容
 * 5. 元数据往返：catalogKind 落库 → 读回 → 收拢进 metadata → restoreCatalogState 可见
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

const mcpState = vi.hoisted(() => ({
    metas: [] as Array<{proxyName: string; serverId: string; serverName?: string; rawToolName: string; rawInputSchema: unknown}>,
}))

vi.mock('../../../../src/main/agent/mcp/discovery', () => ({
    getAllMcpToolMeta: () => mcpState.metas,
    getMcpToolMeta: (name: string) => mcpState.metas.find(m => m.proxyName === name),
}))

import {skillRegistry} from '@/main/agent/skills/registry'
import {
    collectCatalogSnapshot,
    computeMcpDigest,
    computeDigest,
    decideMcpPublish,
    formatCompactSchema,
    renderMcpCatalogContent,
} from '@/main/agent/skills/catalogInjector'
import {restoreCatalogState, runCatalogPreStep, type CatalogState} from '@/main/agent/loop/catalogPublish'
import {createLoopState} from '@/main/agent/state'
import {convertUserHistoryMessage} from '@/main/agent/utils/userContentBuilder'
import {SOURCE_KIND_CATALOG} from '@shared/types/message'

function meta(proxyName: string, rawToolName: string, rawInputSchema: unknown, serverId = 'plugin:github', description?: string) {
    return {proxyName, serverId, serverName: 'github', rawToolName, description, rawInputSchema}
}

const ISSUE_SCHEMA = {
    type: 'object',
    properties: {
        repo: {type: 'string'},
        title: {type: 'string'},
        body: {type: 'string'},
        labels: {type: 'array'},
        state: {type: 'string', enum: ['open', 'closed']},
    },
    required: ['repo', 'title'],
}

function injectSkills(entries: Array<{name: string; description?: string}> = [{name: 'alpha', description: 'do alpha'}]) {
    vi.spyOn(skillRegistry, 'getEnabled').mockReturnValue(
        entries.map(e => ({enabled: true, name: e.name, description: e.description ?? `desc-${e.name}`, source: 'user'})) as any,
    )
}

beforeEach(() => {
    mcpState.metas = [meta('m_github_create_issue', 'create_issue', ISSUE_SCHEMA)]
    injectSkills()
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('formatCompactSchema', () => {
    it('required 标 *，optional 标 ?，enum 内联取值', () => {
        expect(formatCompactSchema(ISSUE_SCHEMA as never))
            .toBe('{repo:string*, title:string*, body:string?, labels:array?, state:string(open|closed)?}')
    })

    it('空/缺失 schema → 空对象字面量（不抛错）', () => {
        expect(formatCompactSchema(undefined)).toBe('{}')
        expect(formatCompactSchema({type: 'object'} as never)).toBe('{}')
    })

    it('超长 schema 截断并追加省略号', () => {
        const big = {
            type: 'object',
            properties: Object.fromEntries(
                Array.from({length: 60}, (_, i) => [`field_with_long_name_${i}`, {type: 'string'}]),
            ),
        }
        const out = formatCompactSchema(big as never)
        expect(out.endsWith('…')).toBe(true)
        expect(out.length).toBeLessThanOrEqual(301)
    })
})

describe('renderMcpCatalogContent', () => {
    const entries = [
        {name: 'm_github_create_issue', type: 'mcp' as const, description: 'create_issue args: {repo:string*}'},
    ]

    it('first: 含 <available_mcp_tools>、条目行与 call_mcp_tool 引导', () => {
        const c = renderMcpCatalogContent(entries, 'first')
        expect(c).toContain('<system-reminder>')
        expect(c).toContain('<available_mcp_tools>')
        expect(c).toContain('- m_github_create_issue: create_issue args: {repo:string*}')
        expect(c).toContain('call_mcp_tool({name:')
        expect(c).toContain('do not call MCP tool names directly')
        expect(c).not.toContain('available_skills')
    })

    it('replacement: 声明取代语义', () => {
        expect(renderMcpCatalogContent(entries, 'replacement')).toContain('replaces every earlier MCP tool list')
    })

    it('empty: 声明不得使用早期 MCP 工具名', () => {
        const c = renderMcpCatalogContent([], 'empty')
        expect(c).toContain('No MCP tools are currently available')
        expect(c).toContain('Do not use MCP tool names from earlier catalogs')
    })
})

describe('computeMcpDigest', () => {
    const base = [{name: 'm_a', type: 'mcp' as const, description: 'd'}]

    it('对 name / description（含 schema 文本）敏感', () => {
        expect(computeMcpDigest(base)).not.toBe(computeMcpDigest([{...base[0], description: 'e'}]))
        expect(computeMcpDigest(base)).not.toBe(computeMcpDigest([{...base[0], name: 'm_b'}]))
    })

    it('与 skills digest 域隔离（同输入不撞车）', () => {
        expect(computeMcpDigest(base as never)).not.toBe(computeDigest({mode: 'names', entries: base as never}))
    })
})

describe('collectCatalogSnapshot 两源', () => {
    it('单次收集同时产出 skills 与 mcpTools 两源', () => {
        const snap = collectCatalogSnapshot()
        expect(snap.skills).toHaveLength(1)
        expect(snap.mcpTools).toHaveLength(1)
        expect(snap.complete).toBe(true)
    })

    it('mcpTools 带 type=mcp 与紧凑 schema', () => {
        const snap = collectCatalogSnapshot()
        expect(snap.mcpTools).toHaveLength(1)
        expect(snap.mcpTools[0].type).toBe('mcp')
        expect(snap.mcpTools[0].name).toBe('m_github_create_issue')
        expect(snap.mcpTools[0].description).toContain('args: {repo:string*')
    })

    it('★ 条目说明取 MCP 侧真实 description（而非 rawToolName），后接紧凑 schema', () => {
        mcpState.metas = [meta('m_github_create_issue', 'create_issue', ISSUE_SCHEMA, 'plugin:github', 'Create an issue.')]
        const snap = collectCatalogSnapshot()
        const desc = snap.mcpTools[0].description
        expect(desc.startsWith('Create an issue.')).toBe(true)
        expect(desc).toContain('args: {repo:string*')
        // 不得退化成 rawToolName 作说明
        expect(desc.startsWith('create_issue args')).toBe(false)
    })

    it('description 缺失 → 回退 rawToolName（不出现空说明）', () => {
        const snap = collectCatalogSnapshot()
        expect(snap.mcpTools[0].description.startsWith('create_issue args')).toBe(true)
    })
})

describe('decideMcpPublish', () => {
    const snapOf = (mcpTools: any[], complete = true) => ({skills: [], mcpTools, complete})

    it('未发布且无 MCP 工具 → none（不发空目录）', () => {
        expect(decideMcpPublish(snapOf([]), undefined, false, 0).decision.action).toBe('none')
    })

    it('首次发布 → publish + catalogKind=mcp', () => {
        const e = [{name: 'm_a', type: 'mcp' as const, description: 'd'}]
        const r = decideMcpPublish(snapOf(e), undefined, false, 0)
        expect(r.decision.action).toBe('publish')
        expect(r.decision.metadata!.catalogKind).toBe('mcp')
        expect(r.decision.content).toContain('<available_mcp_tools>')
    })

    it('digest 相同且有已发布 → none', () => {
        const e = [{name: 'm_a', type: 'mcp' as const, description: 'd'}]
        const d = computeMcpDigest(e)
        expect(decideMcpPublish(snapOf(e), d, true, 0).decision.action).toBe('none')
    })

    it('工具集变化 → replacement 文案', () => {
        const e = [{name: 'm_a', type: 'mcp' as const, description: 'd'}]
        const r = decideMcpPublish(
            snapOf([...e, {name: 'm_b', type: 'mcp' as const, description: 'x'}]),
            computeMcpDigest(e), true, 0,
        )
        expect(r.decision.action).toBe('publish')
        expect(r.decision.content).toContain('replaces every earlier MCP tool list')
    })
})

describe('runCatalogPreStep 两源独立发布', () => {
    it('首轮 → 两条 catalog 消息（skills + mcp）', () => {
        const {state} = runCatalogPreStep(createLoopState([]), {incompleteStreak: 0}, null, undefined, false)
        const cats = state.messages.filter(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG)
        expect(cats).toHaveLength(2)
        const kinds = cats.map(m => (m.metadata as any).catalogKind)
        expect(kinds).toEqual(['skills', 'mcp'])
    })

    it('无 MCP 工具 → 仅 skills 一条（不发空 MCP 目录）', () => {
        mcpState.metas = []
        const {state} = runCatalogPreStep(createLoopState([]), {incompleteStreak: 0}, null, undefined, false)
        const cats = state.messages.filter(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG)
        expect(cats).toHaveLength(1)
        expect((cats[0].metadata as any).catalogKind).toBe('skills')
    })

    it('★ call_mcp_tool 未下发（受限 agent）→ 不发布 MCP 目录；恢复可见后重新发布', () => {
        // 本轮 tools 里没有 call_mcp_tool：只发 skills，MCP 目录不出现
        const r1 = runCatalogPreStep(createLoopState([]), {incompleteStreak: 0}, null, undefined, false, false)
        let cats = r1.state.messages.filter(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG)
        expect(cats).toHaveLength(1)
        expect((cats[0].metadata as any).catalogKind).toBe('skills')

        // 恢复可见：同一会话再跑一轮 → 追加 mcp 目录（追加在尾部，不破坏前缀）
        const r2 = runCatalogPreStep(r1.state, r1.catalogState, null, undefined, false, true)
        cats = r2.state.messages.filter(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG)
        expect(cats).toHaveLength(2)
        expect((cats[1].metadata as any).catalogKind).toBe('mcp')
    })

    it('★ 已发布过 MCP 目录 → 未声明时跳过且不重发；恢复可见且工具集未变也不重复追加', () => {
        const state0 = createLoopState([])
        const r1 = runCatalogPreStep(state0, {incompleteStreak: 0}, null, undefined, false, true)
        const count = (s: typeof state0) =>
            s.messages.filter(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG).length
        expect(count(r1.state)).toBe(2)   // skills + mcp

        // 未声明：跳过发布，digest 保留 → 消息数不变
        const r2 = runCatalogPreStep(r1.state, r1.catalogState, null, undefined, false, false)
        expect(count(r2.state)).toBe(2)

        // 恢复可见 + 工具集未变 → digest 命中，仍不重复追加
        const r3 = runCatalogPreStep(r2.state, r2.catalogState, null, undefined, false, true)
        expect(count(r3.state)).toBe(2)
    })

    it('★ MCP 工具集变化 → 只追加 mcp 消息，技能目录不重发', () => {
        const r1 = runCatalogPreStep(createLoopState([]), {incompleteStreak: 0}, null, undefined, false)
        mcpState.metas = [
            meta('m_github_create_issue', 'create_issue', ISSUE_SCHEMA),
            meta('m_github_list_issues', 'list_issues', {type: 'object', properties: {repo: {type: 'string'}}, required: ['repo']}),
        ]
        const r2 = runCatalogPreStep(r1.state, r1.catalogState, null, undefined, false)
        const cats = r2.state.messages.filter(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG)
        expect(cats).toHaveLength(3)
        expect((cats[2].metadata as any).catalogKind).toBe('mcp')
        // 技能目录 digest 未变 → 不追加
        expect((cats[1].metadata as any).catalogKind).toBe('mcp')
    })

    it('★ MCP 目录不变 + 技能变化 → 只追加 skills 消息', () => {
        const r1 = runCatalogPreStep(createLoopState([]), {incompleteStreak: 0}, null, undefined, false)
        injectSkills([{name: 'alpha', description: 'do alpha'}, {name: 'beta', description: 'do beta'}])
        const r2 = runCatalogPreStep(r1.state, r1.catalogState, null, undefined, false)
        const cats = r2.state.messages.filter(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG)
        expect(cats).toHaveLength(3)
        expect((cats[2].metadata as any).catalogKind).toBe('skills')
    })
})

describe('restoreCatalogState 按 kind 分别还原', () => {
    it('两源各自取最后一条 digest', () => {
        const st = restoreCatalogState([
            {id: 'a', role: 'user', content: 's1', metadata: {sourceKind: SOURCE_KIND_CATALOG, catalogKind: 'skills', catalogDigest: 'ds1'}},
            {id: 'b', role: 'user', content: 'm1', metadata: {sourceKind: SOURCE_KIND_CATALOG, catalogKind: 'mcp', catalogDigest: 'dm1'}},
            {id: 'c', role: 'user', content: 's2', metadata: {sourceKind: SOURCE_KIND_CATALOG, catalogKind: 'skills', catalogDigest: 'ds2'}},
        ] as never)
        expect(st.lastSkillDigest).toBe('ds2')
        expect(st.lastMcpDigest).toBe('dm1')
    })

    it('旧数据兼容：无 catalogKind 视为 skills（升级后不重复发布）', () => {
        const st = restoreCatalogState([
            {id: 'a', role: 'user', content: 'legacy', metadata: {sourceKind: SOURCE_KIND_CATALOG, catalogDigest: 'd-old'}},
        ] as never)
        expect(st.lastSkillDigest).toBe('d-old')
        expect(st.lastMcpDigest).toBeUndefined()
    })

    it('端到端：两源发布 → 还原 → 再跑一轮零追加', () => {
        const r1 = runCatalogPreStep(createLoopState([]), {incompleteStreak: 0}, null, undefined, false)
        const restored: CatalogState = restoreCatalogState(r1.state.messages)
        const r2 = runCatalogPreStep(r1.state, restored, null, undefined, false)
        expect(r2.state.messages).toHaveLength(r1.state.messages.length)
    })
})

describe('catalogKind 元数据往返（§4.4 白名单收拢）', () => {
    it('DB 读回顶层展开的 catalogKind 被收拢回 metadata', async () => {
        const rebuilt = await convertUserHistoryMessage({
            id: 'm1',
            role: 'user',
            content: '<system-reminder>mcp</system-reminder>',
            sourceKind: SOURCE_KIND_CATALOG,
            catalogDigest: 'd1',
            catalogKind: 'mcp',
        } as never)
        expect(rebuilt[0].metadata?.catalogKind).toBe('mcp')
        expect(restoreCatalogState(rebuilt as never).lastMcpDigest).toBe('d1')
    })
})
