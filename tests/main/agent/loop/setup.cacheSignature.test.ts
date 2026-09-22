import {describe, expect, it, vi} from 'vitest'

vi.mock('@/main/config', () => ({
    getHclawDir: () => '/tmp/hclaw-test',
}))
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

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

/**
 * P1-11：签名键集固化（controller.ts:252-263）。
 *
 * 现状（方案 A）：键集 = {workingDir, agentType, customInstructions}（无语言段时），
 * 有子会话语言段时 +languageSection。shell / Node 版本 / hclawDir / MCP 元数据
 * 均不入键 —— 这些字段只影响**构建时的字节**，签名一致即复用旧字节（前缀稳定）。
 * 若将来扩签名（方案 B），本文件与 systemPrompt.envStability.test.ts 的复用用例必须同改。
 */
describe('buildSystemSignature 键集（P1-11）', () => {
    it('workingDir 变化 → 签名不同（workspace 变更必须重建 system）', () => {
        const a = buildSystemSignature('/x', 'General', undefined, undefined)
        const b = buildSystemSignature('/y', 'General', undefined, undefined)
        expect(b).not.toBe(a)
    })

    it('键集固化：仅 workingDir / agentType / customInstructions（无语言段时）', () => {
        const sig = buildSystemSignature('/x', 'General', undefined, undefined)
        expect(Object.keys(JSON.parse(sig))).toEqual(['workingDir', 'agentType', 'customInstructions'])
    })

    it('键集固化：有子会话语言段时追加 languageSection', () => {
        const sig = buildSystemSignature('/x', 'General', undefined, undefined, '始终用简体中文')
        expect(Object.keys(JSON.parse(sig))).toEqual(['workingDir', 'agentType', 'customInstructions', 'languageSection'])
        expect(sig).toContain('始终用简体中文')
    })

    it('环境字段不在键内：同参重复调用恒等（shell / Node / hclawDir / MCP 无可入键通道）', () => {
        const a = buildSystemSignature('/x', 'General', undefined, undefined)
        const b = buildSystemSignature('/x', 'General', undefined, undefined)
        expect(a).toBe(b)
        // 结构保证：签名函数只接收上述 5 个参数，环境字段无任何入键通道
        expect(JSON.parse(a)).not.toHaveProperty('shell')
        expect(JSON.parse(a)).not.toHaveProperty('nodeVersion')
        expect(JSON.parse(a)).not.toHaveProperty('hclawDir')
        expect(JSON.parse(a)).not.toHaveProperty('mcp')
    })
})
