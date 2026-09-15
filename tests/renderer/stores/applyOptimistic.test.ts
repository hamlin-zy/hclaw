/**
 * applyOptimistic 测试
 *
 * 覆盖：成功（先 mutate 后 persist、data 透传）、persist reject 回滚、
 * persist resolve {ok:false} 回滚、错误信息规范化、回滚发生在 persist 之后。
 */
import {describe, it, expect, vi} from 'vitest'
import {applyOptimistic, toErrorMessage} from '@/renderer/stores/applyOptimistic'

/** 最小内存替身：mutate/snapshot 操作同一个 value */
function makeTarget(initial: number) {
    const state = {value: initial}
    const log: string[] = []
    return {
        state,
        log,
        mutate: () => {
            log.push('mutate')
            state.value = state.value + 1
        },
        snapshot: () => {
            log.push('snapshot')
            state.value = initial
            return state.value
        },
    }
}

describe('applyOptimistic', () => {
    it('成功：先 mutate 再 persist，persist 结果作为 data 返回，不回滚', async () => {
        const t = makeTarget(1)
        const persist = vi.fn(async () => {
            t.log.push('persist')
            return 'saved'
        })

        const res = await applyOptimistic<string>({
            snapshot: t.snapshot,
            mutate: t.mutate,
            persist,
        })

        expect(res).toEqual({ok: true, data: 'saved'})
        expect(t.state.value).toBe(2)
        expect(t.log).toEqual(['mutate', 'persist'])
    })

    it('persist reject：回滚到快照值，错误为 Error.message', async () => {
        const t = makeTarget(1)

        const res = await applyOptimistic<void>({
            snapshot: t.snapshot,
            mutate: t.mutate,
            persist: async () => {
                throw new Error('网络不可达')
            },
        })

        expect(res).toEqual({ok: false, error: '网络不可达'})
        expect(t.state.value).toBe(1)
        expect(t.log).toEqual(['mutate', 'snapshot'])
    })

    it('persist resolve {ok:false,error}：按失败处理并回滚', async () => {
        const t = makeTarget(5)

        const res = await applyOptimistic<{ok: boolean; error?: string}>({
            snapshot: t.snapshot,
            mutate: t.mutate,
            persist: async () => ({ok: false, error: '写入被拒绝'}),
        })

        expect(res).toEqual({ok: false, error: '写入被拒绝'})
        expect(t.state.value).toBe(5)
    })

    it('persist resolve {ok:false} 缺 error：使用默认文案', async () => {
        const t = makeTarget(0)

        const res = await applyOptimistic<{ok: boolean; error?: string}>({
            snapshot: t.snapshot,
            mutate: t.mutate,
            persist: async () => ({ok: false}),
        })

        expect(res.ok).toBe(false)
        expect(res.ok === false && res.error).toBe('持久化失败')
        expect(t.state.value).toBe(0)
    })

    it('persist resolve {success:false,error}：同样按失败处理并回滚（主进程 IPC 约定）', async () => {
        const t = makeTarget(7)

        const res = await applyOptimistic<{success: boolean; error?: string}>({
            snapshot: t.snapshot,
            mutate: t.mutate,
            persist: async () => ({success: false, error: 'agents:update 失败'}),
        })

        expect(res).toEqual({ok: false, error: 'agents:update 失败'})
        expect(t.state.value).toBe(7)
    })

    it('persist resolve {success:true,...}：视为成功', async () => {
        const t = makeTarget(1)

        const res = await applyOptimistic<{success: boolean}>({
            snapshot: t.snapshot,
            mutate: t.mutate,
            persist: async () => ({success: true}),
        })

        expect(res.ok).toBe(true)
        expect(t.state.value).toBe(2)
    })

    it('persist resolve {ok:true,...}：视为成功', async () => {
        const t = makeTarget(3)

        const res = await applyOptimistic<{ok: boolean; data?: string}>({
            snapshot: t.snapshot,
            mutate: t.mutate,
            persist: async () => ({ok: true, data: 'x'}),
        })

        expect(res).toEqual({ok: true, data: {ok: true, data: 'x'}})
        expect(t.state.value).toBe(4)
    })

    it('持久化抛非 Error：错误信息规范化', async () => {
        const t = makeTarget(1)

        const res = await applyOptimistic<void>({
            snapshot: t.snapshot,
            mutate: t.mutate,
            persist: async () => {
                throw 'plain string failure'
            },
        })

        expect(res).toEqual({ok: false, error: 'plain string failure'})
        expect(t.state.value).toBe(1)
    })
})

describe('toErrorMessage', () => {
    it.each([
        [new Error('boom'), 'boom'],
        ['raw', 'raw'],
        [{message: 'obj-message'}, 'obj-message'],
        [{error: 'obj-error'}, 'obj-error'],
        [{message: '', error: 'fallback'}, 'fallback'],
        [123, '123'],
        [null, 'null'],
    ])('%j → %s', (input, expected) => {
        expect(toErrorMessage(input)).toBe(expected)
    })
})
