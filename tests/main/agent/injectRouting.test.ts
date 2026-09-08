/**
 * injectRouting — Worker 侧注入消息路由
 *
 * 覆盖 worker.ts INJECT_USER_MESSAGE 分支的两种目标：
 * - 本 Worker 会话 → 入 pendingInjectedMessages（Controller 每轮消费）
 * - 其他会话 → 动态导入 agentTool.injectChildMessage（父会话运行在本 Worker 中的子会话）
 */
import {describe, expect, it, vi} from 'vitest'

vi.mock('@/main/agent/tools/builtin/agentTool', () => ({
    injectChildMessage: vi.fn(() => true),
}))

import {routeInjectedUserMessage} from '@/main/agent/injectRouting'
import {injectChildMessage} from '@/main/agent/tools/builtin/agentTool'

const SELF = 'conv-self'

describe('routeInjectedUserMessage', () => {
    it('无 message 字段 → 忽略（防御：空消息不入队）', async () => {
        const queue: unknown[] = []
        await routeInjectedUserMessage({convId: SELF}, SELF, queue as never)
        expect(queue).toHaveLength(0)
        expect(injectChildMessage).not.toHaveBeenCalled()
    })

    it('目标为本会话（显式 convId）→ 入队本会话队列', async () => {
        const queue: {role: string; content: string; id: string}[] = []
        await routeInjectedUserMessage({convId: SELF, message: {content: '补充信息', id: 'inject-1'}}, SELF, queue as never)
        expect(queue).toEqual([{role: 'user', content: '补充信息', id: 'inject-1'}])
        expect(injectChildMessage).not.toHaveBeenCalled()
    })

    it('无 convId（旧协议，主进程未带 convId）→ 视为本会话', async () => {
        const queue: {role: string; content: string; id: string}[] = []
        await routeInjectedUserMessage({message: {content: 'legacy'}}, SELF, queue as never)
        expect(queue).toHaveLength(1)
        expect(queue[0].content).toBe('legacy')
        expect(queue[0].id).toMatch(/^inject-\d+-/)
    })

    it('目标是其他会话 → 转发 injectChildMessage（子会话路由）', async () => {
        const queue: unknown[] = []
        await routeInjectedUserMessage(
            {convId: 'conv-child', message: {content: '给子会话', id: 'inject-2'}},
            SELF,
            queue as never,
        )
        expect(queue).toHaveLength(0)
        expect(injectChildMessage).toHaveBeenCalledWith('conv-child', '给子会话', 'inject-2')
    })

    it('本会话目标但 content 为空 → 入队空内容消息（与原实现一致）', async () => {
        const queue: {content: string}[] = []
        await routeInjectedUserMessage({convId: SELF, message: {}}, SELF, queue as never)
        expect(queue).toHaveLength(1)
        expect(queue[0].content).toBe('')
    })
})
