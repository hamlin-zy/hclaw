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
 * - 命中率口径 = 生效模型组末次请求（currentCacheRead / (currentInput + currentCacheRead)）
 *   （徽章口径固定为会话生效模型，不跟随卡片切换视图）
 * - 生效模型无历史数据 → 徽章占位（—）但保留 hover 卡片入口，卡片空态提示 + 历史模型可切换
 * - 卡片模型切换器：默认选中生效模型，切换后核心指标跟随所选模型统计
 *
 * 生效模型解析依赖 useAgentStore.modelOverride（providerName/modelId），测试直接 setState 注入，
 * 与消息 llmStats 的 provider（类型名）/model（模型名）匹配。
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {render, screen, cleanup, fireEvent, act, waitFor} from '@testing-library/react'
import CacheRateTooltip from '../../../src/renderer/components/CacheRateTooltip'
import {useConversationStore} from '../../../src/renderer/stores/conversationStore'
import {useAgentStore} from '../../../src/renderer/stores/agentStore'
import {useLLMStore} from '../../../src/renderer/stores/llmStore'
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

/** 注入会话生效模型（override；providers 未配置时按 providerName/modelId 残值匹配历史分组） */
const setActiveModel = (providerName: string, modelId: string) => {
    useAgentStore.setState({modelOverride: {endpointId: providerName, modelId, providerName}})
}

beforeEach(() => {
    // 重置 stores：清空消息 + 生效模型（避免用例间串扰）
    useConversationStore.setState({loadedMessages: []})
    useAgentStore.setState({modelOverride: null})
})

afterEach(() => {
    cleanup()
    useAgentStore.setState({modelOverride: null})
})

describe('CacheRateTooltip 真实渲染（无 mock 链路）', () => {
    it('无 LLM 统计时不渲染任何徽章（requestCount=0 短路）', () => {
        const {container} = render(<CacheRateTooltip/>)
        expect(container.childNodes.length).toBe(0)
        expect(screen.queryByText(/缓存/)).toBeNull()
        expect(screen.queryByText(/窗口/)).toBeNull()
    })

    it('注入 llmStats 后渲染缓存/窗口/吞吐三个徽章，命中率取生效模型末次请求口径', () => {
        useConversationStore.setState({
            loadedMessages: [llmMessage()],
        })
        setActiveModel('openrouter', 'deepseek-v3')
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

        // 每个 MetricBadge 胶囊（外层 group）都有 shrink-0 + whitespace-nowrap
        const badges = [...container.querySelectorAll<HTMLElement>('span.group.relative.inline-flex')]
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
        setActiveModel('openrouter', 'deepseek-v3')
        const {container} = render(<CacheRateTooltip/>)

        // 末次命中率 = 800 / (200 + 800) = 80%
        expect(screen.getByText('缓存 80%')).toBeTruthy()
        expect(screen.queryByText(/缓存 9[0-9]%/)).toBeNull()

        // 末次窗口占用 = 200 + 800 = 1.0k
        expect(screen.getByText(/窗口/)).toBeTruthy()

        const badges = [...container.querySelectorAll<HTMLElement>('span.group.relative.inline-flex')]
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
        setActiveModel('openrouter', 'deepseek-v3')
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
        setActiveModel('deepseek', 'deepseek-v4-flash')
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

describe('CacheRateTooltip 生效模型无数据 + 卡片模型切换器', () => {
    it('生效模型无历史数据：徽章占位（—）但保留卡片入口，卡片空态提示且可切换历史模型', () => {
        // 会话仅有 Provider B 的数据；生效模型（override → Provider A 服务商）无任何请求
        useConversationStore.setState({
            loadedMessages: [
                llmMessage({
                    id: 'm1',
                    llmStats: [
                        {
                            inputTokens: 1000,
                            outputTokens: 500,
                            provider: 'provider-b',
                            providerName: 'Provider B',
                            model: 'model-b',
                            duration: 12000,
                            cacheReadTokens: 9000,
                            decodeMs: 10000,
                            ttftMs: 800,
                        },
                    ],
                }),
            ],
        })
        useAgentStore.setState({
            modelOverride: {endpointId: 'prov-a', modelId: 'model-a', providerName: 'Provider A'},
        })
        // 配置服务商解析：生效模型显示「Provider A: model-a」
        useLLMStore.setState({
            providers: [
                {id: 'prov-a', name: 'Provider A', type: 'custom', enabled: true, models: [{id: 'model-a', name: 'model-a', enabled: true}]},
            ],
        })
        try {
            render(<CacheRateTooltip/>)

            // 徽章占位（不显示数值），但触发容器仍在 → 保留 hover 卡片入口
            expect(screen.getByText('缓存 —')).toBeTruthy()
            expect(screen.getByText('窗口 —')).toBeTruthy()
            expect(screen.queryByText(/t\/s/)).toBeNull()

            // hover 打开卡片 → 默认选中生效模型（无数据）→ 空态提示
            const trigger = document.querySelector('[data-name="input-toolbar-cache-rate"]')!
            fireEvent.mouseEnter(trigger)
            expect(screen.getByText('该模型暂无请求数据')).toBeTruthy()
            expect(screen.getByText('Provider A: model-a')).toBeTruthy()

            // 切换器展开 → 历史模型列表 → 选择 Provider B: model-b
            const switcher = document.querySelector('[data-name="cache-rate-model-switcher"]')!
            fireEvent.click(switcher)
            fireEvent.click(screen.getByText('Provider B: model-b'))

            // 卡片切换为该模型统计：累计命中率 = 9000 / (1000 + 9000) = 90%
            expect(screen.getByText('90%')).toBeTruthy()
            expect(screen.queryByText('该模型暂无请求数据')).toBeNull()
            // 徽章不跟随卡片切换：生效模型仍无数据 → 占位保持不变
            expect(screen.getByText('缓存 —')).toBeTruthy()
            expect(screen.getByText('窗口 —')).toBeTruthy()
        } finally {
            // 还原服务商（避免串扰后续用例）；组件仍挂载 → act 包裹，避免 store 变更
            // 在断言后触发未包裹的 re-render 产生 "not wrapped in act(...)" 警告
            act(() => {
                useLLMStore.setState({providers: []})
            })
        }
    })

    it('卡片默认选中生效模型，切换历史模型后核心指标跟随切换（徽章不跟随）', () => {
        useConversationStore.setState({
            loadedMessages: [
                llmMessage({ // 生效模型 deepseek-v3：累计命中率 90%
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
                llmMessage({ // 历史模型 other-model：累计命中率 80%
                    id: 'm2',
                    llmStats: [
                        {
                            inputTokens: 200,
                            outputTokens: 50,
                            provider: 'openrouter',
                            model: 'other-model',
                            duration: 3000,
                            cacheReadTokens: 800,
                            decodeMs: 2000,
                            ttftMs: 400,
                        },
                    ],
                }),
            ],
        })
        setActiveModel('openrouter', 'deepseek-v3')
        render(<CacheRateTooltip/>)

        const trigger = document.querySelector('[data-name="input-toolbar-cache-rate"]')!
        fireEvent.mouseEnter(trigger)

        // 默认选中生效模型 → 卡片显示其统计（平均命中率 90%）
        expect(screen.getByText('90%')).toBeTruthy()

        // 切换器展开 → 历史模型列表 → 选择 other-model
        const switcher = document.querySelector('[data-name="cache-rate-model-switcher"]')!
        fireEvent.click(switcher)
        fireEvent.click(screen.getByText('openrouter: other-model'))

        // 卡片指标切换为该模型（80%），生效模型统计数值不再显示
        expect(screen.getByText('80%')).toBeTruthy()
        expect(screen.queryByText('90%')).toBeNull()
        // 徽章不跟随切换：仍显示生效模型（deepseek-v3）的末次命中率 90%
        expect(screen.getByText('缓存 90%')).toBeTruthy()
    })

    it('卡片关闭后重置模型选择：再次打开默认回到生效模型', async () => {
        useConversationStore.setState({
            loadedMessages: [
                llmMessage({ // 生效模型 deepseek-v3：累计命中率 90%
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
                llmMessage({ // 历史模型 other-model：累计命中率 80%
                    id: 'm2',
                    llmStats: [
                        {
                            inputTokens: 200,
                            outputTokens: 50,
                            provider: 'openrouter',
                            model: 'other-model',
                            duration: 3000,
                            cacheReadTokens: 800,
                            decodeMs: 2000,
                            ttftMs: 400,
                        },
                    ],
                }),
            ],
        })
        setActiveModel('openrouter', 'deepseek-v3')
        render(<CacheRateTooltip/>)

        const trigger = document.querySelector('[data-name="input-toolbar-cache-rate"]')!
        fireEvent.mouseEnter(trigger)

        // 默认选中生效模型
        expect(screen.getByText('90%')).toBeTruthy()

        // 切换到历史模型 other-model
        const switcher = document.querySelector('[data-name="cache-rate-model-switcher"]')!
        fireEvent.click(switcher)
        fireEvent.click(screen.getByText('openrouter: other-model'))
        expect(screen.getByText('80%')).toBeTruthy()

        // 关闭卡片（移出触发区 → 100ms 隐藏定时器）
        fireEvent.mouseLeave(trigger)
        await waitFor(() => expect(screen.queryByText('80%')).toBeNull())

        // 再次打开 → 选择重置为默认生效模型（90%），不再停留在上次选择
        fireEvent.mouseEnter(trigger)
        expect(screen.getByText('90%')).toBeTruthy()
        expect(screen.queryByText('80%')).toBeNull()
    })

    it('下拉按模型名去重：同模型 providerName 有/缺失不出现重复条目（保留末次使用标签）', () => {
        // 同模型 deepseek-v3 两条历史：较早一条 providerName 缺失（按类型名 deepseek 分组），
        // 较晚一条 providerName=DeepSeek → 分组键不同拆成两组；下拉应合并为一条（末次使用的 DeepSeek）
        useConversationStore.setState({
            loadedMessages: [
                llmMessage({
                    id: 'm1',
                    llmStats: [
                        {
                            inputTokens: 100,
                            outputTokens: 50,
                            provider: 'deepseek',
                            model: 'deepseek-v3',
                            duration: 3000,
                            cacheReadTokens: 800,
                            decodeMs: 2000,
                            ttftMs: 400,
                        },
                    ],
                }),
                llmMessage({
                    id: 'm2',
                    timestamp: Date.now() + 1000, // 较晚消息 → 该组 lastUsedAt 更大，排序靠前
                    llmStats: [
                        {
                            inputTokens: 200,
                            outputTokens: 50,
                            provider: 'deepseek',
                            providerName: 'DeepSeek',
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
        setActiveModel('deepseek', 'deepseek-v3')
        render(<CacheRateTooltip/>)

        const trigger = document.querySelector('[data-name="input-toolbar-cache-rate"]')!
        fireEvent.mouseEnter(trigger)
        const switcher = document.querySelector('[data-name="cache-rate-model-switcher"]')!
        fireEvent.click(switcher)

        // 下拉中 deepseek-v3 只出现一条，且保留末次使用的「DeepSeek」标签
        const dropdownItems = [...document.querySelectorAll<HTMLElement>(
            '[data-name="cache-rate-model-switcher"] + div button',
        )]
        const matched = dropdownItems.filter(b => b.textContent?.includes('deepseek-v3'))
        expect(matched.length).toBe(1)
        expect(matched[0]!.textContent).toContain('DeepSeek: deepseek-v3')
    })
})
