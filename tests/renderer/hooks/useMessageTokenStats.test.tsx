// @vitest-environment jsdom
/**
 * useMessageTokenStats hook 测试
 *
 * 保护：会话消息 token 统计（输入/输出/缓存 token 汇总）。
 * hook 是 useMemo 包裹纯函数 computeMessageTokenStats / computeMessageTokenStatsByModel 的
 * 薄封装，返回 { stats, byModel }：
 * - stats：全局口径（所有模型汇总）
 * - byModel：按「服务商 + 模型」分组的完整统计，按末次使用时间倒序（含末次使用时间）
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
 * - byModel 分组 / 排序 / providerName 回退 / 同名模型区分
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
        expect(result.current.stats).toEqual({
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
            currentDecodeMs: 0,
            currentHasTtft: false,
            lastTimedStats: null,
        })
        expect(result.current.byModel).toEqual([])
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
        expect(result.current.stats.requestCount).toBe(2)
        expect(result.current.stats.totalInputTokens).toBe(120)
        expect(result.current.stats.totalOutputTokens).toBe(55)
        expect(result.current.stats.totalCacheReadTokens).toBe(12)
        expect(result.current.stats.totalDecodeMs).toBe(300)
        expect(result.current.stats.totalTtftMs).toBe(150)
        expect(result.current.stats.ttftCount).toBe(1) // 第二条无 ttftMs 不计入
        // 当前值 = 遍历顺序最后一条 llmStats
        expect(result.current.stats.currentInputTokens).toBe(20)
        expect(result.current.stats.currentOutputTokens).toBe(5)
        expect(result.current.stats.currentCacheReadTokens).toBe(2)
        // 末次时序 = 最后一条 llmStats 的时序字段
        expect(result.current.stats.currentDecodeMs).toBe(100)
        expect(result.current.stats.currentHasTtft).toBe(false)
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
        expect(result.current.stats.requestCount).toBe(2)
        expect(result.current.stats.totalInputTokens).toBe(40)
        expect(result.current.stats.totalOutputTokens).toBe(4)
        expect(result.current.stats.currentInputTokens).toBe(30)
        expect(result.current.stats.currentOutputTokens).toBe(3)
    })

    it('非 assistant 消息不统计', () => {
        setLoadedMessages([
            makeMessage({role: 'user', llmStats: [{inputTokens: 999, outputTokens: 999, provider: 'p', model: 'm', duration: 100}]}),
            makeMessage({role: 'system', llmStats: [{inputTokens: 999, outputTokens: 999, provider: 'p', model: 'm', duration: 100}]}),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        expect(result.current.stats.requestCount).toBe(0)
        expect(result.current.stats.totalInputTokens).toBe(0)
        expect(result.current.stats.currentInputTokens).toBe(0)
    })

    it('llmStats 缺失 / 非数组 → 安全处理，不抛错', () => {
        setLoadedMessages([
            makeMessage({}), // 无 llmStats
            // @ts-expect-error 模拟脏数据：llmStats 非数组
            makeMessage({llmStats: 'bad-data'}),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        expect(result.current.stats.requestCount).toBe(0)
        expect(result.current.stats.totalInputTokens).toBe(0)
        expect(result.current.stats.currentInputTokens).toBe(0)
        expect(result.current.byModel).toEqual([])
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
        expect(result.current.stats.totalInputTokens).toBe(6)
        expect(result.current.stats.totalOutputTokens).toBe(3)
        expect(result.current.stats.totalCacheReadTokens).toBe(0)
        expect(result.current.stats.totalDecodeMs).toBe(0)
        expect(result.current.stats.ttftCount).toBe(1)
        expect(result.current.stats.totalTtftMs).toBe(0)
    })

    it('末次时序字段：最后一条 llmStats 的 decodeMs/ttftMs/ttft 存在性', () => {
        setLoadedMessages([
            makeMessage({
                llmStats: [
                    {inputTokens: 10, outputTokens: 1, provider: 'p', model: 'm', duration: 100, decodeMs: 50, ttftMs: 300},
                ],
            }),
            makeMessage({
                llmStats: [
                    {inputTokens: 30, outputTokens: 3, provider: 'p', model: 'm', duration: 200, decodeMs: 120, ttftMs: 400},
                ],
            }),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        // 末次请求 = 最后一条 llmStats（第二条消息）
        expect(result.current.stats.currentDecodeMs).toBe(120)
        expect(result.current.stats.currentHasTtft).toBe(true)
        // 累计不受影响
        expect(result.current.stats.totalDecodeMs).toBe(170)
        expect(result.current.stats.totalTtftMs).toBe(700)
        expect(result.current.stats.ttftCount).toBe(2)
    })

    it('末次请求无 ttftMs：currentHasTtft 为 false', () => {
        setLoadedMessages([
            makeMessage({
                llmStats: [
                    {inputTokens: 5, outputTokens: 2, provider: 'p', model: 'm', duration: 0, decodeMs: 30},
                ],
            }),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        expect(result.current.stats.currentDecodeMs).toBe(30)
        expect(result.current.stats.currentHasTtft).toBe(false)
    })

    it('末次为纯工具轮次（无 ttftMs）：lastTimedStats 回退到上一个文本轮次', () => {
        setLoadedMessages([
            makeMessage({
                llmStats: [
                    {inputTokens: 100, outputTokens: 20, provider: 'p', model: 'm', duration: 1000, cacheReadTokens: 50, decodeMs: 800, ttftMs: 400},
                ],
            }),
            // 纯工具调用轮次：仅 tool_use，无文本解码（ttftMs/decodeMs 缺失）
            makeMessage({
                llmStats: [
                    {inputTokens: 200, outputTokens: 12, provider: 'p', model: 'm', duration: 100, cacheReadTokens: 30},
                ],
                toolCalls: [{id: 't1', name: 'bash', arguments: {}, status: 'pending'}],
            }),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        // current* 保持"最后一条 llmStats"语义
        expect(result.current.stats.currentInputTokens).toBe(200)
        expect(result.current.stats.currentHasTtft).toBe(false)
        // 末次吞吐口径回退（t/s 徽章不消失）
        expect(result.current.stats.lastTimedStats).toEqual({outputTokens: 20, decodeMs: 800})
    })

    it('toolCalls 计数累计（仅统计 assistant 消息）', () => {
        setLoadedMessages([
            makeMessage({toolCalls: [{id: 'tc1', name: 'a', arguments: {}, status: 'pending'}]}),
            makeMessage({toolCalls: [
                {id: 'tc2', name: 'b', arguments: {}, status: 'pending'},
                {id: 'tc3', name: 'c', arguments: {}, status: 'pending'},
            ]}),
            makeMessage({role: 'user', toolCalls: [{id: 'tc4', name: 'd', arguments: {}, status: 'pending'}]}),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        expect(result.current.stats.toolCallCount).toBe(3)
    })

    it('loadedMessages 变更后统计重新计算（useMemo 依赖）', () => {
        setLoadedMessages([
            makeMessage({llmStats: [{inputTokens: 10, outputTokens: 1, provider: 'p', model: 'm', duration: 100}]}),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        expect(result.current.stats.totalInputTokens).toBe(10)

        setLoadedMessages([
            makeMessage({llmStats: [{inputTokens: 50, outputTokens: 5, provider: 'p', model: 'm', duration: 200}]}),
        ])
        expect(result.current.stats.totalInputTokens).toBe(50)
        expect(result.current.stats.currentInputTokens).toBe(50)
    })

    it('byModel：多模型混合消息分组，条目含 key/lastUsedAt/providerName/model/stats', () => {
        setLoadedMessages([
            makeMessage({
                timestamp: 100,
                llmStats: [
                    {inputTokens: 100, outputTokens: 20, provider: 'p1', providerName: 'Provider A', model: 'model-a', duration: 1000},
                ],
            }),
            makeMessage({
                timestamp: 200,
                llmStats: [
                    {inputTokens: 200, outputTokens: 40, provider: 'p2', providerName: 'Provider B', model: 'model-b', duration: 2000},
                ],
            }),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        expect(result.current.byModel).toHaveLength(2)

        const a = result.current.byModel.find(g => g.providerName === 'Provider A')!
        const b = result.current.byModel.find(g => g.providerName === 'Provider B')!
        // byModel 条目形状：key / lastUsedAt / providerName / model / stats
        expect(Object.keys(a).sort()).toEqual(['key', 'lastUsedAt', 'model', 'providerName', 'stats'])
        expect(a.key).toBe('Provider A\u0000model-a')
        expect(a.model).toBe('model-a')
        expect(a.stats.requestCount).toBe(1)
        expect(a.stats.totalInputTokens).toBe(100)
        expect(b.stats.totalInputTokens).toBe(200)
        // 末次使用时间 = 所属消息 timestamp 最大值
        expect(a.lastUsedAt).toBe(100)
    })

    it('byModel 按末次使用时间倒序', () => {
        setLoadedMessages([
            makeMessage({
                timestamp: 300,
                llmStats: [{inputTokens: 1, outputTokens: 1, provider: 'p', model: 'model-a', duration: 1}],
            }),
            makeMessage({
                timestamp: 100,
                llmStats: [{inputTokens: 1, outputTokens: 1, provider: 'p', model: 'model-b', duration: 1}],
            }),
            makeMessage({
                timestamp: 200,
                llmStats: [{inputTokens: 1, outputTokens: 1, provider: 'p', model: 'model-c', duration: 1}],
            }),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        expect(result.current.byModel.map(g => g.model)).toEqual(['model-a', 'model-c', 'model-b'])
    })

    it('byModel：providerName 缺失回退 provider 类型名；同名模型不同服务商区分', () => {
        setLoadedMessages([
            // providerName 缺失 → 分组按 provider 类型名 'custom'
            makeMessage({
                timestamp: 100,
                llmStats: [{inputTokens: 10, outputTokens: 1, provider: 'custom', model: 'gpt-5', duration: 100}],
            }),
            // 同名模型，不同服务商（有 providerName）
            makeMessage({
                timestamp: 200,
                llmStats: [{inputTokens: 20, outputTokens: 2, provider: 'openai', providerName: 'OpenAI', model: 'gpt-5', duration: 100}],
            }),
        ])
        const {result} = renderHook(() => useMessageTokenStats())
        expect(result.current.byModel).toHaveLength(2)
        const legacy = result.current.byModel.find(g => g.providerName === 'custom')!
        const named = result.current.byModel.find(g => g.providerName === 'OpenAI')!
        expect(legacy.model).toBe('gpt-5')
        expect(named.model).toBe('gpt-5')
        expect(legacy.key).toBe('custom\u0000gpt-5')
        expect(named.key).toBe('OpenAI\u0000gpt-5')
        expect(legacy.stats.totalInputTokens).toBe(10)
        expect(named.stats.totalInputTokens).toBe(20)
    })
})
