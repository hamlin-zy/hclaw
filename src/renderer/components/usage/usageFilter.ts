/**
 * 用量统计明细表过滤（纯前端，仅作用于明细表行；KPI / 趋势保持全量口径）
 *
 * 过滤维度：
 * - 服务商（两视图均有）：按展示名（providerName 优先，回退 providerDisplayName）精确匹配
 * - 模型（仅模型视图）：按 breakdown.key（模型 ID）精确匹配
 * - 合计 token 范围：输入单位为 M（百万 token），内部 ×1_000_000 与 totalTokens 闭区间比较
 */
import type {UsageBreakdown} from '@shared/types'
import {providerDisplayName} from './statsParts'

/** 行的服务商展示名（与服务商视图首列 / 模型视图服务商列同口径） */
export function breakdownProviderLabel(b: UsageBreakdown): string {
    return b.providerName || providerDisplayName(b.providerType || b.key)
}

/** 明细表过滤条件（字符串均为空 = 不限） */
export interface UsageFilterState {
    /** 服务商展示名，'' = 全部 */
    provider: string
    /** 模型 ID（breakdown.key），'' = 全部；仅模型视图使用 */
    model: string
    /** 合计 token 下限（单位 M），'' = 不限 */
    totalMinM: string
    /** 合计 token 上限（单位 M），'' = 不限 */
    totalMaxM: string
}

export const EMPTY_USAGE_FILTER: UsageFilterState = {
    provider: '',
    model: '',
    totalMinM: '',
    totalMaxM: '',
}

/** 是否有任一过滤条件生效（用于 UI 显示"清除"按钮） */
export function hasActiveFilter(f: UsageFilterState): boolean {
    return f.provider !== '' || f.model !== '' || f.totalMinM !== '' || f.totalMaxM !== ''
}

/** M 字符串 → token 数；空串/非法数字返回 null（不限） */
function parseBoundM(s: string): number | null {
    if (s.trim() === '') return null
    const n = Number(s)
    if (!Number.isFinite(n)) return null
    return n * 1_000_000
}

/** 单行是否满足过滤条件 */
export function matchesFilter(b: UsageBreakdown, f: UsageFilterState): boolean {
    if (f.provider !== '' && breakdownProviderLabel(b) !== f.provider) return false
    if (f.model !== '' && b.key !== f.model) return false
    const min = parseBoundM(f.totalMinM)
    const max = parseBoundM(f.totalMaxM)
    if (min != null && b.totalTokens < min) return false
    if (max != null && b.totalTokens > max) return false
    return true
}

/** 过滤明细行；min > max 时返回空数组（无符合条件的数据） */
export function filterBreakdown(rows: UsageBreakdown[], f: UsageFilterState): UsageBreakdown[] {
    const min = parseBoundM(f.totalMinM)
    const max = parseBoundM(f.totalMaxM)
    if (min != null && max != null && min > max) return []
    return rows.filter(b => matchesFilter(b, f))
}

/** 服务商下拉选项（当前数据去重、排序） */
export function providerOptions(rows: UsageBreakdown[]): string[] {
    return [...new Set(rows.map(breakdownProviderLabel))].sort((a, b) => a.localeCompare(b))
}

/** 模型下拉选项；provider 非空时只列该服务商下的模型（联动） */
export function modelOptions(rows: UsageBreakdown[], provider: string): string[] {
    const scoped = provider === '' ? rows : rows.filter(b => breakdownProviderLabel(b) === provider)
    return [...new Set(scoped.map(b => b.key))].sort((a, b) => a.localeCompare(b))
}
