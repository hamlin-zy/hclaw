// @vitest-environment jsdom
/**
 * useMessageTokenStats hook 测试
 *
 * 保护：会话消息 token 统计（输入/输出/缓存 token 汇总）。
 * hook 是 useMemo 包裹纯函数 computeMessageTokenStats 的薄封装，
 * 数据来自 useConversationStore.loadedMessages，测试直接 setState 注入消息。
 *
 * 覆盖：
 * - 空消息 → 全零统计
 * - 多条 assistant 消息 llmStats 累计（请求数/输入/输出/缓存/解码时长）
 * - 当前值 = 遍历顺序中最后一条 llmStats
 * - 非 assistant 消息不统计
 * - ttftMs 缺失不计入 ttftCount
 * - 无 llmStats / llmStats 非数组安全处理
 * - toolCalls 计数
 * - loadedMessages 变更后统计重新计算
 */
import {describe, expect, it, afterEach} from 'vitest'
import {renderHook, act} from '@testing-library/react'
import {useMessageTokenStats} from '../../../src/renderer/hooks/useMessageTokenStats'
import {useConversationStore} from '../../../src/renderer/stores/conversationStore'
import type {Message} from '@shared/types'

function makeMessage(partial: Partial<Message>): Message {
    return {
        id: partial.id ?? `msg-${Math.random()}`,
        role: partial.role ?? 'assistant',
        content: partial.content ?? '',
        timestamp: partial.timestamp ?? 0,
        ...partial,
    }
}

function setLoadedMessages(messages: Message[]) {
    act(() => {
        useConversationStore.setState({loadedMessages: messages})
    })
}

describe('useMessageTokenStats', () => {
    afterEach(() => {
        setLoadedMessages([])
    })

    it('空消息 → 全零统计', () => {
        setLoadedMessages([])
        const {result} = renderHook(() => useMessageTokenStats())
        expect(result.current).toEqual({
            requestCount: 0,
            toolCallCount: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheReadTokens: 0,
            totalDecodeMs: 0,
            totalTtftMs: 0,
            ttftCount: 0,
            currentInputTokens: 0,
            currentOutputTokens: 0,
            currentCacheReadTokens: 0,
        })
    })

    it('多条 assistant 消息 llmStats 累计，当前值取最后一条', () => {
        setLoadedMessages([
            makeMessage({
                llmStats: [
                    {inputTokens: 100, outputTokens: 50, provider: 'p', model: 'm', duration: 1000, cacheReadTokens: 10, decodeMs: 200, ttftMs: 150},
                ],
            }),
            makeMessage({
                llmStats: [
                    {inputTokens: 20, outputTokens: 5, provider: 'p', model: 'm', duration: 500, cacheReadTokens: 2, decodeMs: 100},
                ],
            }),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        expect(result.current.requestCount).toBe(2)
        expect(result.current.totalInputTokens).toBe(120)
        expect(result.current.totalOutputTokens).toBe(55)
        expect(result.current.totalCacheReadTokens).toBe(12)
        expect(result.current.totalDecodeMs).toBe(300)
        expect(result.current.totalTtftMs).toBe(150)
        expect(result.current.ttftCount).toBe(1) // 第二条无 ttftMs 不计入
        // 当前值 = 遍历顺序最后一条 llmStats
        expect(result.current.currentInputTokens).toBe(20)
        expect(result.current.currentOutputTokens).toBe(5)
        expect(result.current.currentCacheReadTokens).toBe(2)
    })

    it('单条消息多条 llmStats：请求数累加，当前值取最后一条统计', () => {
        setLoadedMessages([
            makeMessage({
                llmStats: [
                    {inputTokens: 10, outputTokens: 1, provider: 'p', model: 'm', duration: 100},
                    {inputTokens: 30, outputTokens: 3, provider: 'p', model: 'm', duration: 200},
                ],
            }),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        expect(result.current.requestCount).toBe(2)
        expect(result.current.totalInputTokens).toBe(40)
        expect(result.current.totalOutputTokens).toBe(4)
        expect(result.current.currentInputTokens).toBe(30)
        expect(result.current.currentOutputTokens).toBe(3)
    })

    it('非 assistant 消息不统计', () => {
        setLoadedMessages([
            makeMessage({role: 'user', llmStats: [{inputTokens: 999, outputTokens: 999, provider: 'p', model: 'm', duration: 100}]}),
            makeMessage({role: 'system', llmStats: [{inputTokens: 999, outputTokens: 999, provider: 'p', model: 'm', duration: 100}]}),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        expect(result.current.requestCount).toBe(0)
        expect(result.current.totalInputTokens).toBe(0)
        expect(result.current.currentInputTokens).toBe(0)
    })

    it('llmStats 缺失 / 非数组 → 安全处理，不抛错', () => {
        setLoadedMessages([
            makeMessage({}), // 无 llmStats
            // @ts-expect-error 模拟脏数据：llmStats 非数组
            makeMessage({llmStats: 'bad-data'}),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        expect(result.current.requestCount).toBe(0)
        expect(result.current.totalInputTokens).toBe(0)
        expect(result.current.currentInputTokens).toBe(0)
    })

    it('字段缺失按 0 处理，ttftMs 为 0 仍计入 ttftCount', () => {
        setLoadedMessages([
            makeMessage({
                llmStats: [
                    // 省略可选字段，验证 undefined → 0
                    {inputTokens: 5, outputTokens: 2, provider: 'p', model: 'm', duration: 0},
                ],
            }),
            makeMessage({
                llmStats: [
                    {inputTokens: 1, outputTokens: 1, provider: 'p', model: 'm', duration: 0, ttftMs: 0},
                ],
            }),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        expect(result.current.totalInputTokens).toBe(6)
        expect(result.current.totalOutputTokens).toBe(3)
        expect(result.current.totalCacheReadTokens).toBe(0)
        expect(result.current.totalDecodeMs).toBe(0)
        expect(result.current.ttftCount).toBe(1)
        expect(result.current.totalTtftMs).toBe(0)
    })

    it('toolCalls 计数累计（仅统计 assistant 消息）', () => {
        setLoadedMessages([
            makeMessage({toolCalls: [{id: 'tc1', name: 'a', arguments: {}}]}),
            makeMessage({toolCalls: [
                {id: 'tc2', name: 'b', arguments: {}},
                {id: 'tc3', name: 'c', arguments: {}},
            ]}),
            makeMessage({role: 'user', toolCalls: [{id: 'tc4', name: 'd', arguments: {}}]}),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        expect(result.current.toolCallCount).toBe(3)
    })

    it('loadedMessages 变更后统计重新计算（useMemo 依赖）', () => {
        setLoadedMessages([
            makeMessage({llmStats: [{inputTokens: 10, outputTokens: 1, provider: 'p', model: 'm', duration: 100}]}),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        expect(result.current.totalInputTokens).toBe(10)

        setLoadedMessages([
            makeMessage({llmStats: [{inputTokens: 50, outputTokens: 5, provider: 'p', model: 'm', duration: 200}]}),
        ])
        expect(result.current.totalInputTokens).toBe(50)
        expect(result.current.currentInputTokens).toBe(50)
    })
})
