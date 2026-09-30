import {describe, it, expect} from 'vitest'
import {resolveEffectiveTools, formatToolsNotice} from '@/main/agent/tools/builtin/agentToolTools'

const REG = ['glob', 'grep', 'file_read', 'file_write', 'file_edit', 'bash', 'web_fetch', 'agent', 'session_handoff', 'skill']

const base = {agentName: 'Explore Agent', disallowedTools: [] as string[], registryNames: REG}

describe('resolveEffectiveTools', () => {
    it('并集：默认白名单保留，additionalTools 追加', () => {
        const r = resolveEffectiveTools({baseTools: ['glob', 'grep'], additionalTools: ['web_fetch'], ...base})
        expect(r.tools).toEqual(['glob', 'grep', 'web_fetch'])
        expect(r.notices).toEqual([])
    })

    it('未限制（undefined）不被缩窄，且不提示', () => {
        const r = resolveEffectiveTools({baseTools: undefined, additionalTools: ['web_fetch'], ...base})
        expect(r.tools).toBeUndefined()
        expect(r.notices).toEqual([])
    })

    it('未限制（[] 与 ["*"]）同样保持不限制', () => {
        const empty = resolveEffectiveTools({baseTools: [], additionalTools: ['web_fetch'], ...base})
        expect(empty.tools).toEqual([])
        expect(empty.notices).toEqual([])
        const star = resolveEffectiveTools({baseTools: ['*'], additionalTools: ['web_fetch'], ...base})
        expect(star.tools).toEqual(['*'])
        expect(star.notices).toEqual([])
    })

    it('additionalTools 为空数组：与不传等价', () => {
        const a = resolveEffectiveTools({baseTools: ['glob'], additionalTools: [], ...base})
        expect(a.tools).toEqual(['glob'])
        expect(a.notices).toEqual([])
    })

    it('去重：与白名单重复 / 自身重复', () => {
        const r = resolveEffectiveTools({baseTools: ['glob'], additionalTools: ['glob', 'web_fetch', 'web_fetch'], ...base})
        expect(r.tools).toEqual(['glob', 'web_fetch'])
    })

    it('agent 级黑名单拦截：Explore 补 file_write 不生效', () => {
        const r = resolveEffectiveTools({baseTools: ['glob'], additionalTools: ['file_write'], ...base, disallowedTools: ['file_write', 'session_handoff']})
        expect(r.tools).toEqual(['glob'])
        expect(r.notices).toEqual(['file_write（被 Explore Agent 的黑名单拦截）'])
    })

    it('全局黑名单拦截：skill 不生效', () => {
        const r = resolveEffectiveTools({baseTools: ['glob'], additionalTools: ['skill'], ...base})
        expect(r.tools).toEqual(['glob'])
        expect(r.notices).toEqual(['skill（全局禁用）'])
    })

    it('session_handoff 作为显式黑名单项一并拦截', () => {
        const r = resolveEffectiveTools({baseTools: ['glob'], additionalTools: ['session_handoff'], ...base, disallowedTools: ['session_handoff']})
        expect(r.tools).toEqual(['glob'])
        expect(r.notices).toHaveLength(1)
    })

    it('未注册 → notice，不抛异常', () => {
        const r = resolveEffectiveTools({baseTools: ['glob'], additionalTools: ['webfetch2'], ...base})
        expect(r.tools).toEqual(['glob'])
        expect(r.notices).toEqual(['webfetch2（未注册或名称歧义）'])
    })

    it('名称歧义（Read 与 file_read 同时注册）→ 失败关闭 + notice', () => {
        const r = resolveEffectiveTools({
            baseTools: ['glob'], additionalTools: ['read'], agentName: 'Explore Agent',
            disallowedTools: [], registryNames: [...REG, 'Read'],
        })
        expect(r.tools).toEqual(['glob'])
        expect(r.notices).toEqual(['read（未注册或名称歧义）'])
    })

    it('别名解析：Read → file_read 生效', () => {
        const r = resolveEffectiveTools({baseTools: ['glob'], additionalTools: ['Read'], ...base})
        expect(r.tools).toEqual(['glob', 'file_read'])
        expect(r.notices).toEqual([])
    })
})

describe('formatToolsNotice', () => {
    it('空数组 → 空串', () => {
        expect(formatToolsNotice([])).toBe('')
    })

    it('非空 → 前缀 + 顿号连接', () => {
        const s = formatToolsNotice(['a（未注册或名称歧义）', 'b（被 X 的黑名单拦截）'])
        expect(s.startsWith('\n\n[工具集提示] additionalTools 未生效：')).toBe(true)
        expect(s).toContain('a（未注册或名称歧义）、b（被 X 的黑名单拦截）')
        expect(s.endsWith('其余工具已正常生效。')).toBe(true)
    })
})
