/**
 * ChannelMessageQueue 单元测试
 *
 * 覆盖：
 * - enqueue：空闲直接处理 / 忙时入队 + notifyQueued
 * - dequeueAndProcess：FIFO 弹出、processing 释放、异常清空
 * - getQueueSize / getTotalQueued / clear
 * - 多会话隔离、notifyQueued 异常不阻塞
 *
 * 说明：被测模块仅依赖 console logger，无需 mock；全部走真实逻辑。
 */
import {describe, expect, it, vi} from 'vitest'
import {ChannelMessageQueue} from '@/main/channel/ChannelMessageQueue'
import type {IncomingMessage} from '@/main/channel/types'
import type {QueueCallbacks} from '@/main/channel/ChannelMessageQueue'

function makeMsg(conversationId: string, text = 'hi'): IncomingMessage {
    return {channelId: 'ch', userId: 'u1', text, conversationId}
}

function makeCallbacks(overrides: Partial<QueueCallbacks> = {}): QueueCallbacks {
    return {
        processNext: vi.fn().mockResolvedValue(undefined),
        notifyQueued: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    }
}

describe('ChannelMessageQueue — enqueue', () => {
    it('空闲会话 enqueue → false（直接处理），并标记 processing', () => {
        const q = new ChannelMessageQueue()
        const callbacks = makeCallbacks()

        const result = q.enqueue(makeMsg('conv-a', 'msg1'), callbacks)

        expect(result).toBe(false)
        // 直接处理 → 不入队
        expect(q.getQueueSize('conv-a')).toBe(0)
        // processing 已标记 → 后续消息会被排队
        expect(q.enqueue(makeMsg('conv-a', 'msg2'), callbacks)).toBe(true)
        expect(callbacks.notifyQueued).toHaveBeenCalledTimes(1)
    })

    it('忙会话 enqueue → true，notifyQueued 收到位置 1', async () => {
        const q = new ChannelMessageQueue()
        const callbacks = makeCallbacks()

        q.enqueue(makeMsg('conv-a', 'first'), callbacks)
        const result = q.enqueue(makeMsg('conv-a', 'second'), callbacks)

        expect(result).toBe(true)
        await vi.waitFor(() => {
            expect(callbacks.notifyQueued).toHaveBeenCalledTimes(1)
        })
        expect(callbacks.notifyQueued).toHaveBeenCalledWith(
            expect.objectContaining({text: 'second'}),
            1,
        )
    })

    it('连续 3 条排队 → 位置 1/2/3', async () => {
        const q = new ChannelMessageQueue()
        const callbacks = makeCallbacks()

        q.enqueue(makeMsg('conv-a', 'first'), callbacks)
        q.enqueue(makeMsg('conv-a', 'q1'), callbacks)
        q.enqueue(makeMsg('conv-a', 'q2'), callbacks)
        q.enqueue(makeMsg('conv-a', 'q3'), callbacks)

        await vi.waitFor(() => {
            expect(callbacks.notifyQueued).toHaveBeenCalledTimes(3)
        })
        const positions = (callbacks.notifyQueued as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1])
        expect(positions).toEqual([1, 2, 3])
        expect(q.getQueueSize('conv-a')).toBe(3)
    })
})

describe('ChannelMessageQueue — dequeueAndProcess', () => {
    it('弹出队首 → processNext 收到最早消息（FIFO）', async () => {
        const q = new ChannelMessageQueue()
        const callbacks = makeCallbacks()

        q.enqueue(makeMsg('conv-a', 'first'), callbacks)
        q.enqueue(makeMsg('conv-a', 'q1'), callbacks)
        q.enqueue(makeMsg('conv-a', 'q2'), callbacks)

        q.dequeueAndProcess('conv-a', callbacks)

        await vi.waitFor(() => {
            expect(callbacks.processNext).toHaveBeenCalledTimes(1)
        })
        expect(callbacks.processNext).toHaveBeenCalledWith(
            expect.objectContaining({text: 'q1'}),
        )
        // 剩余仍在队列中
        expect(q.getQueueSize('conv-a')).toBe(1)
    })

    it('队列处理完 → processing 释放（再 enqueue 返回 false）', async () => {
        const q = new ChannelMessageQueue()
        const callbacks = makeCallbacks()

        q.enqueue(makeMsg('conv-a', 'first'), callbacks)
        q.enqueue(makeMsg('conv-a', 'q1'), callbacks)
        q.dequeueAndProcess('conv-a', callbacks)

        // 队列已空 → 标记空闲
        q.dequeueAndProcess('conv-a', callbacks)
        expect(q.getQueueSize('conv-a')).toBe(0)

        // processing 已释放 → 新消息直接处理
        expect(q.enqueue(makeMsg('conv-a', 'new'), callbacks)).toBe(false)
    })

    it('processNext 抛错 → 队列清空 + processing 释放（不卡死）', async () => {
        const q = new ChannelMessageQueue()
        const callbacks = makeCallbacks({
            processNext: vi.fn().mockRejectedValue(new Error('boom')),
        })

        q.enqueue(makeMsg('conv-a', 'first'), callbacks)
        q.enqueue(makeMsg('conv-a', 'q1'), callbacks)
        q.enqueue(makeMsg('conv-a', 'q2'), callbacks)

        q.dequeueAndProcess('conv-a', callbacks)

        await vi.waitFor(() => {
            expect(q.getQueueSize('conv-a')).toBe(0)
        })
        // processing 已释放 → 可重新直接处理
        expect(q.enqueue(makeMsg('conv-a', 'after'), callbacks)).toBe(false)
    })

    it('notifyQueued 抛错 → 不阻塞（.catch 内部处理）', async () => {
        const q = new ChannelMessageQueue()
        const callbacks = makeCallbacks({
            notifyQueued: vi.fn().mockRejectedValue(new Error('notify failed')),
        })

        q.enqueue(makeMsg('conv-a', 'first'), callbacks)
        // notifyQueued reject 不应抛出/阻塞，仍返回 true 并入队
        const result = q.enqueue(makeMsg('conv-a', 'q1'), callbacks)
        expect(result).toBe(true)
        expect(q.getQueueSize('conv-a')).toBe(1)

        // 额外 await 让 rejected promise 有机会被处理，避免 unhandled rejection
        await Promise.resolve()
    })
})

describe('ChannelMessageQueue — 多会话隔离 / 计数 / clear', () => {
    it('多会话隔离：convA 忙不影响 convB', () => {
        const q = new ChannelMessageQueue()
        const callbacks = makeCallbacks()

        q.enqueue(makeMsg('conv-a', 'a1'), callbacks)
        q.enqueue(makeMsg('conv-a', 'a2'), callbacks)

        // convB 空闲 → 直接处理
        expect(q.enqueue(makeMsg('conv-b', 'b1'), callbacks)).toBe(false)

        // convA 仍忙
        expect(q.enqueue(makeMsg('conv-a', 'a3'), callbacks)).toBe(true)
        expect(q.getQueueSize('conv-a')).toBe(2)
        expect(q.getQueueSize('conv-b')).toBe(0)
    })

    it('getQueueSize / getTotalQueued 计数正确', () => {
        const q = new ChannelMessageQueue()
        const callbacks = makeCallbacks()

        // a1 / b1 正在处理（不入队），仅排队消息计入队列
        q.enqueue(makeMsg('conv-a', 'a1'), callbacks)
        q.enqueue(makeMsg('conv-a', 'a2'), callbacks)
        q.enqueue(makeMsg('conv-b', 'b1'), callbacks)
        q.enqueue(makeMsg('conv-b', 'b2'), callbacks)
        q.enqueue(makeMsg('conv-b', 'b3'), callbacks)

        expect(q.getQueueSize('conv-a')).toBe(1)
        expect(q.getQueueSize('conv-b')).toBe(2)
        expect(q.getTotalQueued()).toBe(3)

        q.dequeueAndProcess('conv-a', callbacks)
        expect(q.getQueueSize('conv-a')).toBe(0)
        expect(q.getTotalQueued()).toBe(2)
    })

    it('clear 清空队列和 processing', () => {
        const q = new ChannelMessageQueue()
        const callbacks = makeCallbacks()

        q.enqueue(makeMsg('conv-a', 'a1'), callbacks)
        q.enqueue(makeMsg('conv-a', 'a2'), callbacks)

        q.clear('conv-a')
        expect(q.getQueueSize('conv-a')).toBe(0)
        expect(q.getTotalQueued()).toBe(0)

        // processing 已清除 → 新消息直接处理
        expect(q.enqueue(makeMsg('conv-a', 'new'), callbacks)).toBe(false)
    })
})
