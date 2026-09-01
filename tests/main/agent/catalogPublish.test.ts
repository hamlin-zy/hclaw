// Task 3：catalogPublish 追加式改造（digest 门控 + 追加新消息，无原地替换）
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

describe('runCatalogPreStep state machine（追加式）', () => {
    it('I1: mode 变化触发追加新消息（第二条 catalog，第一条内容不变）', () => {
        injectSkills(2)
        const cs: CatalogState = {incompleteStreak: 0}
        const r1 = runCatalogPreStep(emptyLoop(), cs, null, undefined, false)
        const first = (r1.state.messages as any[]).find(m => m.metadata?.sourceKind === 'capability-catalog')
        const firstContent = first.content
        // 切换开关后再跑一轮：digest 含 mode 必然变化 → 追加新消息
        const r2 = runCatalogPreStep(r1.state, r1.catalogState, null, undefined, true)
        const catalogs = (r2.state.messages as any[]).filter(m => m.metadata?.sourceKind === 'capability-catalog')
        expect(catalogs.length).toBe(2)
        // 旧消息字节不变
        expect(catalogs[0].id).toBe(first.id)
        expect(catalogs[0].content).toBe(firstContent)
        // 新消息为 full 格式
        expect(catalogs[1].id).not.toBe(first.id)
        expect(catalogs[1].content).toContain('- [skill]')
    })

    it('I2: digest 未变时不追加', () => {
        injectSkills()
        const cs: CatalogState = {incompleteStreak: 0}
        const r1 = runCatalogPreStep(emptyLoop(), cs, null, undefined, false)
        const len = (r1.state.messages as any[]).length
        const r2 = runCatalogPreStep(r1.state, r1.catalogState, null, undefined, false)
        expect((r2.state.messages as any[]).length).toBe(len)
    })

    it('I4/I6: restore 还原最后一条 catalog 消息的 digest 并重置 incompleteStreak', () => {
        const msgs = [
            {id: 'a', role: 'user', content: '<system-reminder>old</system-reminder>',
             metadata: {sourceKind: 'capability-catalog', catalogDigest: 'd1'}},
            {id: 'b', role: 'user', content: '<system-reminder>new</system-reminder>',
             metadata: {sourceKind: 'capability-catalog', catalogDigest: 'd2'}},
        ]
        const st = restoreCatalogState(msgs as any)
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
