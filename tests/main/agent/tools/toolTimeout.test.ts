/**
 * withToolTimeout 超时取消传播测试
 *
 * 覆盖：超时时触发 onTimeout 回调（供 executor 向工具传播 AbortSignal），
 * 成功/快速返回时不触发；超时结果仍为 ToolTimeoutError。
 */
import {describe, expect, it} from 'vitest'
import {ToolTimeoutError, withToolTimeout} from '../../../../src/main/agent/tools/toolTimeout'
import type {ToolResult} from '../../../../src/main/agent/tools/types'

const okResult: ToolResult<string> = {success: true, output: 'ok'}

/** 永不 settle 的 promise（模拟挂起的工具执行） */
function neverSettles(): Promise<ToolResult<string>> {
    return new Promise<ToolResult<string>>(() => { /* never settles */ })
}

describe('withToolTimeout（超时取消传播）', () => {
    it('超时：触发 onTimeout 回调，并以 ToolTimeoutError 拒绝', async () => {
        let cancellations = 0

        await expect(
            withToolTimeout(neverSettles(), 'probe', 10, () => { cancellations++ }),
        ).rejects.toBeInstanceOf(ToolTimeoutError)

        expect(cancellations).toBe(1)
    })

    it('未超时：不触发 onTimeout 回调，正常返回结果', async () => {
        let cancellations = 0
        const result = await withToolTimeout(
            Promise.resolve(okResult),
            'probe',
            1000,
            () => { cancellations++ },
        )

        expect(result).toBe(okResult)
        expect(cancellations).toBe(0)
    })

    it('未传 onTimeout 时不报错（向后兼容）', async () => {
        await expect(withToolTimeout(neverSettles(), 'probe', 10)).rejects.toBeInstanceOf(ToolTimeoutError)
    })

    it('onTimeout 抛错不影响超时结果', async () => {
        await expect(
            withToolTimeout(neverSettles(), 'probe', 10, () => { throw new Error('abort failed') }),
        ).rejects.toBeInstanceOf(ToolTimeoutError)
    })

    /**
     * 核心不变量：超时判定先于取消传播。
     * 探针在 abort 监听器里**同步** resolve 自身结果 —— 若实现改回「先 abort 后 reject」，
     * race 会被工具结果抢先，本用例即失败（提供回归鉴别力）。
     */
    it('先判定超时再取消：工具在 abort 时同步返回也不会抢走超时结果', async () => {
        const toolAbort = new AbortController()
        const toolSettlesOnAbort = new Promise<ToolResult<string>>((resolve) => {
            toolAbort.signal.addEventListener(
                'abort',
                () => resolve({success: true, output: 'partial'}),
                {once: true},
            )
        })

        await expect(
            withToolTimeout(toolSettlesOnAbort, 'probe', 10, () => toolAbort.abort()),
        ).rejects.toBeInstanceOf(ToolTimeoutError)
    })
})
