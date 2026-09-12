/**
 * tools 变动确认门测试。
 *
 * 背景：tools 变动确认门与 ask_user 门同构——无限等待用户决策，不设任何自动放行
 * 超时。用户未应答则 worker 永久阻塞，唯一在线兜底是 abort/worker 退出（cancelAll）。
 * 刷新恢复由主进程内存快照 + 渲染端播种保证弹窗重现。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

vi.mock('../../../src/main/agent/logger', () => ({
    logger: {warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn()},
}))

import {ToolsChangeConfirmer} from '../../../src/main/agent/toolsChangeConfirm'
import {logger} from '../../../src/main/agent/logger'

/** Confirmer.post 投递的请求消息结构（与 ToolsChangeConfirmerOptions.post 入参一致） */
interface PostedMsg {
    type: string
    conversationId: string
    requestId: string
    added: string[]
    removed: string[]
}

function makeConfirmer(opts: {aborted?: boolean; posts?: PostedMsg[]} = {}) {
    const posts = opts.posts ?? []
    const confirmer = new ToolsChangeConfirmer({
        post: (msg) => posts.push(msg),
        messageType: 'tools-change-confirm',
        conversationId: 'conv-1',
        isAborted: () => opts.aborted === true,
    })
    return {confirmer, posts}
}

describe('ToolsChangeConfirmer', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.clearAllMocks()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('正常路径：settle 回传决策并投递请求', async () => {
        const {confirmer, posts} = makeConfirmer()
        const p = confirmer.request({added: ['write_file'], removed: []})
        expect(posts).toHaveLength(1)
        expect(posts[0]).toMatchObject({
            type: 'tools-change-confirm',
            conversationId: 'conv-1',
            added: ['write_file'],
            removed: [],
        })

        confirmer.settle(posts[0].requestId, 'cancel')
        await expect(p).resolves.toBe('cancel')
    })

    it('无限等待：长时间推进假定时器也不会自动 settle（无自动放行）', async () => {
        const {confirmer, posts} = makeConfirmer()
        let settled: string | null = null
        const p = confirmer.request({added: ['write_file'], removed: []}).then((d) => {
            settled = d
            return d
        })

        // 推进远超旧 120s 上限的时长：仍不应结算
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
        expect(settled).toBeNull()
        expect(logger.warn).not.toHaveBeenCalled()

        // 只有用户决策能结算
        confirmer.settle(posts[0].requestId, 'continue')
        await expect(p).resolves.toBe('continue')
    })

    it('已 abort → 不发送请求，直接按 cancel 结束', async () => {
        const {confirmer, posts} = makeConfirmer({aborted: true})
        await expect(confirmer.request({added: [], removed: []})).resolves.toBe('cancel')
        expect(posts).toHaveLength(0)
    })

    it('cancelAll：所有待处理请求按 cancel 结束（中止/worker 退出时调用）', async () => {
        const {confirmer} = makeConfirmer()
        const p1 = confirmer.request({added: [], removed: []})
        const p2 = confirmer.request({added: [], removed: []})

        confirmer.cancelAll()
        await expect(p1).resolves.toBe('cancel')
        await expect(p2).resolves.toBe('cancel')
        // cancelAll 后再 settle 旧 requestId 不应抛错（幂等）
        expect(() => confirmer.settle('stale', 'continue')).not.toThrow()
    })

    it('settle 未知 requestId → 静默忽略', () => {
        const {confirmer} = makeConfirmer()
        expect(() => confirmer.settle('nope', 'continue')).not.toThrow()
    })
})
