// @vitest-environment jsdom
/**
 * CacheRateTooltip — 统计徽章真实渲染 + 窄窗口保护契约
 *
 * 覆盖 InputToolbar.overflow.test.tsx 无法触达的链路：
 * useMessageTokenStats(conversationStore) → computeMessageTokenStats → CacheRateTooltip
 * → MetricBadge 徽章（缓存命中率 / 窗口占用 / 吞吐）真实渲染 DOM。
 *
 * 验证点：
 * - 无 LLM 统计时不渲染徽章（requestCount === 0 短路）
 * - 注入 llmStats 后 3 个徽章全部渲染（缓存 X% / 窗口 Y / Z t/s）
 * - 徽章容器 span 带 whitespace-nowrap（统计文字不折行）
 * - 命中率口径 = 末次请求（currentCacheRead / (currentInput + currentCacheRead)）
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {render, screen, cleanup} from '@testing-library/react'
import CacheRateTooltip from '../../../src/renderer/components/CacheRateTooltip'
import {useConversationStore} from '../../../src/renderer/stores/conversationStore'
import type {Message} from '../../../src/shared/types'

const llmMessage = (over: Partial<Message> = {}): Message => ({
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    llmStats: [
        {
            inputTokens: 1000,
            outputTokens: 500,
            provider: 'openrouter',
            model: 'deepseek-v3',
            duration: 12000,
            cacheReadTokens: 9000,
            decodeMs: 10000,
            ttftMs: 800,
        },
    ],
    ...over,
})

beforeEach(() => {
    // 重置 conversationStore：清空消息（避免用例间串扰）
    useConversationStore.setState({loadedMessages: []})
})

afterEach(() => {
    cleanup()
})

describe('CacheRateTooltip 真实渲染（无 mock 链路）', () => {
    it('无 LLM 统计时不渲染任何徽章（requestCount=0 短路）', () => {
        const {container} = render(<CacheRateTooltip/>)
        expect(container.childNodes.length).toBe(0)
        expect(screen.queryByText(/缓存/)).toBeNull()
        expect(screen.queryByText(/窗口/)).toBeNull()
    })

    it('注入 llmStats 后渲染缓存/窗口/吞吐三个徽章，命中率取末次请求口径', () => {
        useConversationStore.setState({
            loadedMessages: [llmMessage()],
        })
        const {container} = render(<CacheRateTooltip/>)

        // 命中率 = 9000 / (1000 + 9000) = 90%
        const cacheBadge = screen.getByText('缓存 90%')
        expect(cacheBadge).toBeTruthy()

        // 窗口占用 = 末次 input + 末次 cacheRead = 1000 + 9000 = 10.0k
        expect(screen.getByText(/窗口/)).toBeTruthy()

        // 末次吞吐 = 500 / 10s = 50 t/s（rounded）
        const tps = screen.getByText(/t\/s/)
        expect(tps).toBeTruthy()

        // 徽章容器 span 带 whitespace-nowrap 保护（本修复的核心契约）
        const trigger = container.querySelector<HTMLElement>('[data-name="input-toolbar-cache-rate"]')
        expect(trigger).not.toBeNull()
        expect(trigger!.className).toContain('whitespace-nowrap')

        // 每个 MetricBadge 胶囊都有 shrink-0 + whitespace-nowrap
        const badges = [...container.querySelectorAll<HTMLElement>('span.relative.inline-flex')]
        expect(badges.length).toBeGreaterThanOrEqual(3)
        for (const b of badges) {
            expect(b.className).toContain('shrink-0')
            expect(b.className).toContain('whitespace-nowrap')
        }
    })

    it('多轮请求时累计/当前口径正确（末次值覆盖当前列）', () => {
        useConversationStore.setState({
            loadedMessages: [
                llmMessage({
                    llmStats: [
                        {
                            inputTokens: 1000,
                            outputTokens: 500,
                            provider: 'openrouter',
                            model: 'deepseek-v3',
                            duration: 12000,
                            cacheReadTokens: 9000,
                            decodeMs: 10000,
                            ttftMs: 800,
                        },
                    ],
                }),
                llmMessage({
                    id: 'm2',
                    llmStats: [
                        {
                            inputTokens: 200,
                            outputTokens: 50,
                            provider: 'openrouter',
                            model: 'deepseek-v3',
                            duration: 3000,
                            cacheReadTokens: 800,
                            decodeMs: 2000,
                            ttftMs: 400,
                        },
                    ],
                }),
            ],
        })
        const {container} = render(<CacheRateTooltip/>)

        // 末次命中率 = 800 / (200 + 800) = 80%
        expect(screen.getByText('缓存 80%')).toBeTruthy()
        expect(screen.queryByText(/缓存 9[0-9]%/)).toBeNull()

        // 末次窗口占用 = 200 + 800 = 1.0k
        expect(screen.getByText(/窗口/)).toBeTruthy()

        const badges = [...container.querySelectorAll<HTMLElement>('span.relative.inline-flex')]
        expect(badges.length).toBeGreaterThanOrEqual(2)
        for (const b of badges) {
            expect(b.className).toContain('shrink-0')
        }
    })

    it('无 decodeMs/ttftMs 的旧数据：吞吐徽章隐藏，不渲染 t/s', () => {
        useConversationStore.setState({
            loadedMessages: [
                llmMessage({
                    llmStats: [
                        {
                            inputTokens: 100,
                            outputTokens: 30,
                            provider: 'openrouter',
                            model: 'deepseek-v3',
                            duration: 5000,
                            cacheReadTokens: 900,
                            // 无 decodeMs → currentHasTtft=false → 末次吞吐为 null → 徽章隐藏
                        },
                    ],
                }),
            ],
        })
        render(<CacheRateTooltip/>)
        expect(screen.queryByText(/t\/s/)).toBeNull()
        expect(screen.getByText(/缓存/)).toBeTruthy()
        expect(screen.getByText(/窗口/)).toBeTruthy()
    })

    it('decodeMs=1 的历史坏数据：吞吐按 500ms 下限计算，徽章显示 1518 t/s 而非 759000', () => {
        // 真实 DB 数据：usage_msg-1786907041554-q5auap_69，decode_ms=1 + output_tokens=759
        // 旧逻辑 → 759000 t/s 爆表；修复后 → 759/0.5s = 1518 t/s
        useConversationStore.setState({
            loadedMessages: [
                llmMessage({
                    llmStats: [
                        {
                            inputTokens: 674,
                            outputTokens: 759,
                            provider: 'deepseek',
                            model: 'deepseek-v4-flash',
                            duration: 4573,
                            cacheReadTokens: 0,
                            decodeMs: 1,
                            ttftMs: 4572,
                        },
                    ],
                }),
            ],
        })
        render(<CacheRateTooltip/>)
        // 徽章显示修正后的值
        expect(screen.getByText('1518 t/s')).toBeTruthy()
        // 爆表值绝不出现
        expect(screen.queryByText(/759000/)).toBeNull()
        expect(screen.queryByText(/190000/)).toBeNull()
        // tooltip 平均吞吐同口径（累计 = 末次，因为只有一条 stats）
        expect(screen.queryByText(/1518 t\/s/)).toBeTruthy()
    })
})
