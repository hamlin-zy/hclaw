import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {runEnvPreStep, restoreEnvState, renderEnvContent, type EnvState} from '@/main/agent/loop/envPublish'
import {SOURCE_KIND_SYSTEM_ENV} from '@shared/types/message'
import {createLoopState, type LoopState} from '@/main/agent/state'

function emptyLoop(): LoopState {
    return createLoopState([]) as unknown as LoopState
}

/** 固定"今天"为 2026-08-06（formatYmd 使用本地时区字段） */
function setDate(s: string): void {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(`${s}T12:00:00`))
}

beforeEach(() => {
    vi.useRealTimers()
})
afterEach(() => {
    vi.useRealTimers()
})

describe('runEnvPreStep（catalog 式环境快照追加）', () => {
    it('首次调用追加一条 system-env 消息，内容含日期且不含权限模式', () => {
        setDate('2026-08-06')
        const r = runEnvPreStep(emptyLoop(), {}, null, undefined)
        const envs = (r.state.messages as any[]).filter(m => m.metadata?.sourceKind === SOURCE_KIND_SYSTEM_ENV)
        expect(envs.length).toBe(1)
        expect(envs[0].content).toContain('2026-08-06')
        expect(envs[0].content).not.toContain('权限模式')
        expect(envs[0].content).not.toContain('safe')
        expect(r.envState.lastDigest).toBe('2026-08-06')
    })

    it('同一日期重复调用零追加', () => {
        setDate('2026-08-06')
        const r1 = runEnvPreStep(emptyLoop(), {}, null, undefined)
        const len = (r1.state.messages as any[]).length
        const r2 = runEnvPreStep(r1.state, r1.envState, null, undefined)
        expect((r2.state.messages as any[]).length).toBe(len)
        expect(r2.state).toBe(r1.state)
        expect(r2.envState).toBe(r1.envState)
    })

    it('日期变化时追加一条，前一条内容字节不变', () => {
        setDate('2026-08-06')
        const r1 = runEnvPreStep(emptyLoop(), {}, null, undefined)
        const first = (r1.state.messages as any[])[0]
        setDate('2026-08-07')
        const r2 = runEnvPreStep(r1.state, r1.envState, null, undefined)
        const envs = (r2.state.messages as any[]).filter(m => m.metadata?.sourceKind === SOURCE_KIND_SYSTEM_ENV)
        expect(envs.length).toBe(2)
        expect(envs[0].id).toBe(first.id)
        expect(envs[0].content).toBe(first.content) // 前部字节不动
        expect(envs[1].content).toBe(renderEnvContent('2026-08-07'))
    })

    it('restoreEnvState 还原最后一条 system-env 消息的 digest', () => {
        const msgs = [
            {id: 'a', role: 'user', content: '<system-reminder>old</system-reminder>',
             metadata: {sourceKind: SOURCE_KIND_SYSTEM_ENV, envDigest: '2026-08-05'}},
            {id: 'b', role: 'user', content: '<system-reminder>new</system-reminder>',
             metadata: {sourceKind: SOURCE_KIND_SYSTEM_ENV, envDigest: '2026-08-06'}},
        ]
        const st: EnvState = restoreEnvState(msgs as any)
        expect(st.lastDigest).toBe('2026-08-06')
        // 还原后当天重复发布被 digest 门控拦截
        setDate('2026-08-06')
        const r = runEnvPreStep(emptyLoop(), st, null, undefined)
        expect((r.state.messages as any[]).length).toBe(0)
    })
})
