import {describe, expect, it} from 'vitest'
import {
    classifyMcpToolWrite,
    evaluateReadOnlyMcpAccess,
    tokenizeToolName,
} from '@/main/agent/mcp/writeClassify'

describe('classifyMcpToolWrite 优先级（配置 > 标注 > 名字）', () => {
    it('writeTools 命中 → write（压过 annotations 的只读声明）', () => {
        expect(classifyMcpToolWrite({
            rawToolName: 'explore',
            annotations: {readOnlyHint: true},
            override: {writeTools: ['explore']},
        })).toBe('write')
    })

    it('readOnlyTools 命中 → read（无 annotations 也放行）', () => {
        expect(classifyMcpToolWrite({
            rawToolName: 'danger_thing',
            override: {readOnlyTools: ['danger_thing']},
        })).toBe('read')
    })

    it('writeTools 与 readOnlyTools 同时命中 → write（保守）', () => {
        expect(classifyMcpToolWrite({
            rawToolName: 'x',
            override: {readOnlyTools: ['x'], writeTools: ['x']},
        })).toBe('write')
    })

    it('annotations.readOnlyHint=true → read', () => {
        expect(classifyMcpToolWrite({rawToolName: 'zzz', annotations: {readOnlyHint: true}})).toBe('read')
    })

    it('annotations 存在但 readOnlyHint 非 true → write', () => {
        expect(classifyMcpToolWrite({rawToolName: 'zzz', annotations: {}})).toBe('write')
    })

    it('destructiveHint=true 且无 readOnlyHint → write', () => {
        expect(classifyMcpToolWrite({rawToolName: 'zzz', annotations: {destructiveHint: true}})).toBe('write')
    })
})

describe('classifyMcpToolWrite 名字启发式（分段匹配，不用子串）', () => {
    it('codegraph_explore → read（命中 explore，G1 关键路径）', () => {
        expect(classifyMcpToolWrite({rawToolName: 'codegraph_explore'})).toBe('read')
    })

    it('get_settings → read（命中 get，不因 settings 误判 write）', () => {
        expect(classifyMcpToolWrite({rawToolName: 'get_settings'})).toBe('read')
    })

    it('reset_state → unknown（不误判 write）', () => {
        expect(classifyMcpToolWrite({rawToolName: 'reset_state'})).toBe('unknown')
    })

    it('target_file → unknown（子串匹配会把 target 误判成 get 的 read）', () => {
        expect(classifyMcpToolWrite({rawToolName: 'target_file'})).toBe('unknown')
    })

    it('set_description → write（命中 set）', () => {
        expect(classifyMcpToolWrite({rawToolName: 'set_description'})).toBe('write')
    })

    it('triggerBuild → write（camelCase 切分命中 trigger/build）', () => {
        expect(classifyMcpToolWrite({rawToolName: 'triggerBuild'})).toBe('write')
    })

    it('get_and_set → write（读写同命中取 write）', () => {
        expect(classifyMcpToolWrite({rawToolName: 'get_and_set'})).toBe('write')
    })

    it('create_readme → write（readme 不是读词 read）', () => {
        expect(classifyMcpToolWrite({rawToolName: 'create_readme'})).toBe('write')
    })

    it('无词表命中 → unknown', () => {
        expect(classifyMcpToolWrite({rawToolName: 'frobnicate'})).toBe('unknown')
    })
})

describe('tokenizeToolName', () => {
    it('按 _ / - / . 与 camelCase 边界切词并小写化', () => {
        expect(tokenizeToolName('codegraph_explore')).toEqual(['codegraph', 'explore'])
        expect(tokenizeToolName('triggerBuild')).toEqual(['trigger', 'build'])
        expect(tokenizeToolName('get-HTTP.Status')).toEqual(['get', 'http', 'status'])
    })
})

describe('evaluateReadOnlyMcpAccess（消费 unknownPolicy + 二因分列文案）', () => {
    it('read → 放行', () => {
        expect(evaluateReadOnlyMcpAccess({rawToolName: 'codegraph_explore'}).allowed).toBe(true)
    })

    it('write → 拒绝，文案为写操作因', () => {
        const r = evaluateReadOnlyMcpAccess({rawToolName: 'set_description'})
        expect(r.allowed).toBe(false)
        expect(r.error).toContain('被判定为写操作')
        expect(r.error).toContain('set_description')
    })

    it('unknown 且 unknownPolicy 缺省 → 拒绝，文案为无法判定因', () => {
        const r = evaluateReadOnlyMcpAccess({rawToolName: 'frobnicate'})
        expect(r.allowed).toBe(false)
        expect(r.error).toContain('无法判定')
        expect(r.error).toContain('readOnlyTools')
    })

    it('unknown 且 unknownPolicy=allow → 放行', () => {
        expect(evaluateReadOnlyMcpAccess({
            rawToolName: 'frobnicate',
            override: {unknownPolicy: 'allow'},
        }).allowed).toBe(true)
    })

    it('unknown 且 unknownPolicy=deny → 拒绝', () => {
        expect(evaluateReadOnlyMcpAccess({
            rawToolName: 'frobnicate',
            override: {unknownPolicy: 'deny'},
        }).allowed).toBe(false)
    })
})
