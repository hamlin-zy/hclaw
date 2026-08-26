// Task 5：catalogPublish 状态机改造（mode 接线 + incompleteStreak + tombstone）
import {describe, it, expect, vi, afterEach} from 'vitest'
import {runCatalogPreStep, restoreCatalogState, type CatalogState} from '@/main/agent/loop/catalogPublish'
import {skillRegistry} from '@/main/agent/skills/registry'
import {createLoopState, type LoopState} from '@/main/agent/state'

function emptyLoop(): LoopState {
    return createLoopState([]) as unknown as LoopState
}

function injectSkills(n = 1): void {
    vi.spyOn(skillRegistry, 'getEnabled').mockReturnValue(
        Array.from({length: n}, (_, i) => ({
            enabled: true,
            name: `skill-${i}`,
            description: `desc-${i}`,
            source: 'user',
        })) as any,
    )
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe('runCatalogPreStep state machine', () => {
    it('I1: mode 变化触发 replace 且内容为对应格式', () => {
        injectSkills(2)
        const cs: CatalogState = {incompleteStreak: 0}
        const r1 = runCatalogPreStep(emptyLoop(), cs, null, undefined, false)
        expect(r1.state.messages.length).toBeGreaterThan(0) // 首次发布
        // 切换开关后再跑一轮：digest 含 mode 必然变化 → 原地替换
        const msgId = r1.catalogState.publishedMessageId!
        const r2 = runCatalogPreStep(r1.state, r1.catalogState, null, undefined, true)
        const replaced = (r2.state.messages as any[]).find(m => m.id === msgId)
        expect(replaced).toBeDefined()
        expect(replaced.content).toContain('- [skill]')
    })

    it('I2: replace 后消息 id 不变、长度不变', () => {
        injectSkills()
        const cs: CatalogState = {incompleteStreak: 0}
        const r1 = runCatalogPreStep(emptyLoop(), cs, null, undefined, false)
        const len = (r1.state.messages as any[]).length
        const r2 = runCatalogPreStep(r1.state, r1.catalogState, null, undefined, false)
        expect((r2.state.messages as any[]).length).toBe(len)
    })

    it('I3: tombstone——目标悬空时旧消息标记 superseded 并追加新消息', () => {
        // 构造悬空 publishedMessageId
        injectSkills()
        const cs: CatalogState = {lastDigest: 'stale', publishedMessageId: 'ghost-id', incompleteStreak: 0}
        const stateWithOtherMsgs = emptyLoop()
        const r = runCatalogPreStep(stateWithOtherMsgs, cs, null, undefined, false)
        const appended = (r.state.messages as any[]).filter(m => m.metadata?.sourceKind === 'capability-catalog')
        expect(appended.length).toBeGreaterThanOrEqual(1)
        // 悬空分支不得 throw，且 publishedMessageId 更新为新消息
        expect(r.catalogState.publishedMessageId).toBe(appended[appended.length - 1].id)
    })

    it('I4/I6: restore 重置 incompleteStreak 且跳过 superseded', () => {
        const msgs = [
            {id: 'a', role: 'user', content: '<system-reminder>old</system-reminder>',
             metadata: {sourceKind: 'capability-catalog', catalogSuperseded: true, catalogDigest: 'd1'}},
            {id: 'b', role: 'user', content: '<system-reminder>new</system-reminder>',
             metadata: {sourceKind: 'capability-catalog', catalogDigest: 'd2'}},
        ]
        const st = restoreCatalogState(msgs as any)
        expect(st.publishedMessageId).toBe('b')
        expect(st.lastDigest).toBe('d2')
        expect(st.incompleteStreak).toBe(0)
    })

    it('I5: incomplete 快照在 streak < 3 时不发布', () => {
        vi.spyOn(skillRegistry, 'getEnabled').mockImplementation(() => {
            throw new Error('boom')
        })
        const cs: CatalogState = {incompleteStreak: 0}
        const r = runCatalogPreStep(emptyLoop(), cs, null, undefined, false)
        expect(r.state.messages.length).toBe(0)
        expect(r.catalogState.incompleteStreak).toBe(1)
        expect(r.catalogState.lastDigest).toBeUndefined()
    })
})
