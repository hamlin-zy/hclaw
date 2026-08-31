/**
 * 用量统计明细表过滤纯函数测试
 */
import {describe, expect, it} from 'vitest'
import {
    breakdownProviderLabel,
    EMPTY_USAGE_FILTER,
    filterBreakdown,
    hasActiveFilter,
    modelOptions,
    providerOptions,
    type UsageFilterState,
} from '../src/renderer/components/usage/usageFilter'
import type {UsageBreakdown} from '../src/shared/types/infra'

const row = (over: Partial<UsageBreakdown>): UsageBreakdown => ({
    key: 'gpt-4o',
    providerType: 'openai',
    requestCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    ...over,
})

const rows: UsageBreakdown[] = [
    row({key: 'gpt-4o', providerType: 'openai', providerName: 'OpenAI', totalTokens: 1_500_000}),
    row({key: 'gpt-4o-mini', providerType: 'openai', providerName: 'OpenAI', totalTokens: 500_000}),
    row({key: 'glm-4-plus', providerType: 'zhipu', providerName: '智谱', totalTokens: 3_000_000}),
    // 服务商视图行：providerName 缺失，回退 providerDisplayName(key)
    row({key: 'anthropic', providerType: undefined, providerName: undefined, totalTokens: 10_000_000}),
]

const f = (over: Partial<UsageFilterState>): UsageFilterState => ({...EMPTY_USAGE_FILTER, ...over})

describe('filterBreakdown', () => {
    it('空条件返回全部', () => {
        expect(filterBreakdown(rows, EMPTY_USAGE_FILTER)).toHaveLength(4)
    })

    it('按服务商过滤', () => {
        expect(filterBreakdown(rows, f({provider: '智谱'}))).toHaveLength(1)
        expect(filterBreakdown(rows, f({provider: '不存在'}))).toHaveLength(0)
    })

    it('按模型过滤', () => {
        expect(filterBreakdown(rows, f({model: 'gpt-4o'}))).toHaveLength(1)
    })

    it('服务商 + 模型组合过滤', () => {
        expect(filterBreakdown(rows, f({provider: 'OpenAI', model: 'gpt-4o'}))).toHaveLength(1)
        expect(filterBreakdown(rows, f({provider: 'OpenAI', model: 'glm-4-plus'}))).toHaveLength(0)
    })

    it('token 范围闭区间（单位 M 换算）', () => {
        // 0.5M ≤ total ≤ 1.5M：gpt-4o(1.5M) 与 gpt-4o-mini(0.5M) 均命中（含边界）
        expect(filterBreakdown(rows, f({totalMinM: '0.5', totalMaxM: '1.5'})).map(b => b.key))
            .toEqual(['gpt-4o', 'gpt-4o-mini'])
    })

    it('只有下限/上限', () => {
        expect(filterBreakdown(rows, f({totalMinM: '2'})).map(b => b.key)).toEqual(['glm-4-plus', 'anthropic'])
        expect(filterBreakdown(rows, f({totalMaxM: '0.6'})).map(b => b.key)).toEqual(['gpt-4o-mini'])
    })

    it('min > max 返回空数组', () => {
        expect(filterBreakdown(rows, f({totalMinM: '5', totalMaxM: '1'}))).toHaveLength(0)
    })

    it('非法数字视为不限', () => {
        expect(filterBreakdown(rows, f({totalMinM: 'abc', totalMaxM: 'xyz'}))).toHaveLength(4)
    })
})

describe('options', () => {
    it('服务商选项去重排序', () => {
        expect(providerOptions(rows)).toEqual(['智谱', 'OpenAI', 'Anthropic'].sort((a, b) => a.localeCompare(b)))
    })

    it('模型选项受服务商联动约束', () => {
        expect(modelOptions(rows, '')).toEqual(['anthropic', 'gpt-4o', 'gpt-4o-mini', 'glm-4-plus'].sort((a, b) => a.localeCompare(b)))
        expect(modelOptions(rows, 'OpenAI')).toEqual(['gpt-4o', 'gpt-4o-mini'])
    })
})

describe('hasActiveFilter', () => {
    it('空条件为 false，任一字段非空为 true', () => {
        expect(hasActiveFilter(EMPTY_USAGE_FILTER)).toBe(false)
        expect(hasActiveFilter(f({totalMaxM: '0'}))).toBe(true)
    })
})

describe('breakdownProviderLabel', () => {
    it('providerName 优先，缺失回退 providerDisplayName(key)', () => {
        expect(breakdownProviderLabel(rows[0])).toBe('OpenAI')
        expect(breakdownProviderLabel(rows[3])).toBe('Anthropic')
    })
})
