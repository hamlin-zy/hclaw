import {describe, expect, it, vi} from 'vitest'

vi.mock('../../../src/main/config', () => ({
    getHclawDir: () => '/tmp/hclaw-test',
}))

import {buildSystemPrompt} from '../../../src/main/agent/systemPrompt'

/**
 * 缓存稳定化回归：system 不得包含权限模式与动态日期。
 * anthropicAdapter 以 system 为唯一 cache_control 断点，这两项变化即前缀缓存全失效；
 * 且权限模式属安全决策——完全不下发模型。
 */
describe('systemPrompt 环境段稳定化', () => {
    const baseCtx = {
        workingDir: '/x',
        tools: [],
        permissionMode: 'safe',
        agentType: 'General' as const,
    }

    it('不含权限模式行与权限模式值', async () => {
        const p = await buildSystemPrompt(baseCtx)
        expect(p).not.toContain('权限模式')
        expect(p).not.toContain('safe')
        expect(p).not.toContain('auto')
    })

    it('不含当前日期行（yyyy-MM-dd 模式）', async () => {
        const p = await buildSystemPrompt(baseCtx)
        expect(p).not.toContain('当前日期')
        expect(p).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    })

    it('不同权限模式 / 不同日期的上下文输出 byte-equal', async () => {
        const a = await buildSystemPrompt({...baseCtx, permissionMode: 'safe'})
        const b = await buildSystemPrompt({...baseCtx, permissionMode: 'auto'})
        expect(a).toBe(b)
    })

    it('保留稳定环境项：平台/终端/操作系统/Node/工作目录', async () => {
        const p = await buildSystemPrompt(baseCtx)
        expect(p).toContain('**平台**')
        expect(p).toContain('**终端**')
        expect(p).toContain('**操作系统**')
        expect(p).toContain('**Node.js**')
        expect(p).toContain('**工作目录**: /x')
    })
})
