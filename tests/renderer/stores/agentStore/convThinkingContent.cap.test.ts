// @vitest-environment jsdom
/**
 * R1：agentStore.updateConvData 的 thinkingContent 上限（内存优化批次 B2）
 *
 * 保护：thinkingContent 此前无上限，flushThinkingBatch 的 prevContent + batch 全量重拼
 * 在思考型长 loop 下无界增长。修复后沿用 streamBuffer 同款实现模式（flatString(...slice(-N))），
 * 只保留最近窗口且强制扁平复制。本测试锁定：
 *   ① 未超限 → 逐字保留（与旧行为完全一致，UI 可观测行为不变）
 *   ② 超限 → 保留尾部（最近思考），丢弃头部，长度 == 上限
 *   ③ 模拟 flushThinkingBatch 的连续累积 → 始终钳制在上限内且尾部为最新内容
 */
import {describe, it, expect, beforeEach} from 'vitest'
import {useAgentStore} from '@/renderer/stores/agentStore'

const CONV = 'cap-conv'
// 与实现常量保持一致（50_000）；此处硬编码以在常量被误改时第一时间暴露
const CAP = 50000

beforeEach(() => {
    useAgentStore.getState().updateConvData(CONV, {
        thinkingContent: null,
        streamBuffer: '',
        streamBlocks: [],
    })
})

describe('updateConvData thinkingContent 上限（R1）', () => {
    it('未超限：逐字保留原值（旧行为不变）', () => {
        const s = '思考片段'.repeat(20) // 80 字符
        useAgentStore.getState().updateConvData(CONV, {thinkingContent: s})
        expect(useAgentStore.getState().convAgentStates[CONV].thinkingContent).toBe(s)
    })

    it('超限：截断且保留尾部（最近内容），丢弃头部', () => {
        // 头部 'E' 应被丢弃，尾部 'Z' 必须保留
        const head = 'E'.repeat(100)
        const middle = 'L'.repeat(CAP + 100 - 100 - 1)
        const s = head + middle + 'Z'
        expect(s.length).toBeGreaterThan(CAP)

        useAgentStore.getState().updateConvData(CONV, {thinkingContent: s})
        const got = useAgentStore.getState().convAgentStates[CONV].thinkingContent!

        expect(got.length).toBe(CAP)
        expect(got.endsWith('Z')).toBe(true)      // 保留尾部
        expect(got.startsWith('E')).toBe(false)   // 丢弃头部
        // 逐字等于原串的末尾 CAP 个字符
        expect(got).toBe(s.slice(-CAP))
    })

    it('模拟 flushThinkingBatch 连续累积（prevContent + batch）→ 始终钳制在上限内，尾部为最新', () => {
        const chunk = 'x'.repeat(20000)
        for (let i = 0; i < 5; i++) {
            // 与 flushThinkingBatch 相同的累积语义：读当前值再拼 batch
            const prev = useAgentStore.getState().convAgentStates[CONV]?.thinkingContent || ''
            useAgentStore.getState().updateConvData(CONV, {thinkingContent: prev + chunk})
            const got = useAgentStore.getState().convAgentStates[CONV].thinkingContent!
            expect(got.length).toBeLessThanOrEqual(CAP)
        }
        const got = useAgentStore.getState().convAgentStates[CONV].thinkingContent!
        expect(got.length).toBe(CAP)
        // 尾部应为最新 chunk 的末段（全为 'x'，只断言长度与等值窗口）
        expect(got).toBe('x'.repeat(CAP))
    })

    it('恰好等于上限时不截断（边界：> 上限才钳制）', () => {
        const s = 'y'.repeat(CAP)
        useAgentStore.getState().updateConvData(CONV, {thinkingContent: s})
        expect(useAgentStore.getState().convAgentStates[CONV].thinkingContent).toBe(s)
    })
})
