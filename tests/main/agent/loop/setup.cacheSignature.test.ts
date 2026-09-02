import {describe, expect, it, vi} from 'vitest'

vi.mock('@/main/config', () => ({
    getHclawDir: () => '/tmp/hclaw-test',
}))

import {buildSystemPrompt} from '@/main/agent/loop/setup'
import {buildSystemSignature} from '@/main/agent/loop/controller'

const baseParams = {
    commandContext: null,
    agentDefinition: undefined,
    workingDir: '/x',
    availableToolDefinitions: [],
    currentPermissionMode: 'auto' as const,
    customInstructions: undefined,
    agentType: 'General',
    agentTemplates: undefined,
}

/** 缓存复用守卫：签名一致才复用，agentType/customInstructions 变化必须重建 */
describe('buildSystemPrompt 签名守卫', () => {
    it('签名一致 → 原样复用缓存（不重新构建）', async () => {
        const fresh = await buildSystemPrompt({...baseParams, cachedSystemPrompt: null, cacheSignature: null})
        const sig = buildSystemSignature('/x', 'General', undefined, undefined)
        const reused = await buildSystemPrompt({
            ...baseParams,
            cachedSystemPrompt: fresh,
            cacheSignature: sig,
            cachedSignature: sig,
        })
        expect(reused).toBe(fresh)
    })

    it('agentType 变化 → 不复用旧缓存，重建后包含新 agent 模板差异', async () => {
        const cached = 'OLD-CACHED-SYSTEM-PROMPT'
        const sigGeneral = buildSystemSignature('/x', 'General', undefined, undefined)
        const sigOther = buildSystemSignature('/x', 'Plan', undefined, undefined)
        const p = await buildSystemPrompt({
            ...baseParams,
            cachedSystemPrompt: cached,
            cacheSignature: sigOther,
            cachedSignature: sigGeneral,
        })
        expect(p).not.toBe(cached)
    })

    it('customInstructions 变化 → 重建且新文本包含指令', async () => {
        const cached = 'OLD-CACHED-SYSTEM-PROMPT'
        const sigNoCi = buildSystemSignature('/x', 'General', undefined, undefined)
        const sigCi = buildSystemSignature('/x', 'General', undefined, '总是用中文回复')
        const p = await buildSystemPrompt({
            ...baseParams,
            customInstructions: '总是用中文回复',
            cachedSystemPrompt: cached,
            cacheSignature: sigCi,
            cachedSignature: sigNoCi,
        })
        expect(p).not.toBe(cached)
        expect(p).toContain('总是用中文回复')
    })

    it('旧缓存无签名字段（cachedSignature 缺失）→ 强制重建（向后兼容迁移）', async () => {
        const p = await buildSystemPrompt({
            ...baseParams,
            cachedSystemPrompt: 'OLD-LEGACY',
            cacheSignature: buildSystemSignature('/x', 'General', undefined, undefined),
            cachedSignature: null,
        })
        expect(p).not.toBe('OLD-LEGACY')
    })

    it('签名不含日期与权限模式（跨天/权限切换可复用）', () => {
        const a = buildSystemSignature('/x', 'General', undefined, undefined)
        expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}/)
        expect(a).not.toContain('auto')
        expect(a).not.toContain('safe')
    })

    it('方案 A：agentDefinition 存在/变化不影响签名（system 已不依赖 agent 模板）', () => {
        const def = {agentType: 'plan', systemPromptTemplate: 'v1'}
        const noDef = buildSystemSignature('/x', 'General', undefined, undefined)
        const withDef = buildSystemSignature('/x', 'General', def, undefined)
        const changed = buildSystemSignature('/x', 'General', {...def, systemPromptTemplate: 'v2'}, undefined)
        expect(withDef).toBe(noDef)
        expect(changed).toBe(noDef)
    })
})
