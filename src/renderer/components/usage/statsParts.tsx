import {Info} from 'lucide-react'
import type {ReactNode} from 'react'
import {getUsdCnyRate, type Currency} from '../../lib/format'

/** 综合百万 Tokens 价格：总成本 / (综合总 tokens / 1_000_000)
 *  综合总 tokens = input + output + cacheRead + cacheWrite
 *  无数据 / 除零 → '—'
 *  单位随 currency 切换（USD 显示 $，CNY 显示 ¥，按实时汇率换算） */
export function formatPricePerMillionTokens(
    totalCostUsd: number,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheWriteTokens: number,
    currency: Currency = 'USD'
): string {
    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
    if (totalTokens === 0 || totalCostUsd <= 0) return '—'
    const priceUsd = totalCostUsd / (totalTokens / 1_000_000)
    const price = currency === 'CNY' ? priceUsd * getUsdCnyRate() : priceUsd
    const symbol = currency === 'CNY' ? '¥' : '$'
    return price < 0.00001 ? `<${symbol}0.00001` : `${symbol}${price.toFixed(5)}`
}

/** 简易 Toast 组件（成功/错误） */
export function Toast({message, type, onClose}: {message: string; type: 'success' | 'error'; onClose: () => void}) {
    return (
        <div
            className={`fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg text-sm font-medium transition-all animate-slide-up
                ${type === 'success'
                    ? 'bg-[var(--success)] text-white'
                    : 'bg-[var(--error)] text-white'}`}
            role="alert"
        >
            {message}
            <button
                onClick={onClose}
                className="ml-2 p-0.5 rounded text-white/80 hover:text-white transition-opacity"
                aria-label="关闭"
             data-name="stats-parts-button">
                ×
            </button>
        </div>
    )
}

/** 已知服务商类型的规范展示名（openai → OpenAI 等首字母缩写） */
const PROVIDER_DISPLAY: Record<string, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
    ollama: 'Ollama',
}

/** 服务商展示名：已知类型用规范名，未知类型回退首字母大写 */
export function providerDisplayName(key: string): string {
    return PROVIDER_DISPLAY[key] ?? (key.length > 0 ? key[0].toUpperCase() + key.slice(1) : key)
}

/** 统计行：标签左、数值右，等宽数字对齐；bordered 时带边框底（KPI 卡风格） */
export function StatRow({label, value, valueClass, bordered = false}: {label: string; value: string; valueClass?: string; bordered?: boolean}) {
    return (
        <div className={`flex items-center justify-between text-sm ${bordered
            ? 'rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 leading-none'
            : 'leading-6'}`}>
            <span className="text-[var(--text-secondary)]">{label}</span>
            <span className={`font-medium tabular-nums ${valueClass ?? 'text-[var(--text-primary)]'}`}>{value}</span>
        </div>
    )
}

/** KPI 指标卡：突出关键数字 */
export function KpiCard({label, value, accent}: {label: string; value: string; accent?: boolean}) {
    return (
        <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5">
            <div className="truncate text-[10px] text-[var(--text-muted)]">{label}</div>
            <div className={`mt-0.5 truncate text-base font-semibold tabular-nums ${accent ? 'text-[var(--brand-primary)]' : 'text-[var(--text-primary)]'}`}>
                {value}
            </div>
        </div>
    )
}

/** 分组标题 */
export function GroupTitle({children}: {children: ReactNode}) {
    return (
        <div className="pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)] first:pt-0">
            {children}
        </div>
    )
}

/** 美元 / 人民币切换（弹窗与独立窗口共用，口径一致）；size='sm' 为紧凑布局（弹窗） */
export function CurrencyToggle({currency, onChange, size = 'md'}: {
    currency: Currency
    onChange: (c: Currency) => void
    size?: 'md' | 'sm'
}) {
    const btnBase = size === 'sm'
        ? 'px-2 py-0.5 text-[11px] rounded-md transition-colors'
        : 'px-2.5 py-1 text-xs rounded-md transition-colors'
    const active = 'bg-[var(--surface-elevated)] shadow-sm text-[var(--text-primary)] font-medium'
    const inactive = 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
    return (
        <div className="flex gap-0.5 p-0.5 rounded-lg bg-[var(--surface-muted)] border border-[var(--border-muted)]">
            {(['USD', 'CNY'] as Currency[]).map((c, i) => (
                <button key={c} onClick={() => onChange(c)} data-testid={`currency-${c.toLowerCase()}`}
                        className={`${btnBase} ${currency === c ? active : inactive}`} data-name={`stats-parts-currency-${i}`}>
                    {c === 'USD' ? '$ 美元' : '¥ 人民币'}
                </button>
            ))}
        </div>
    )
}

/** 客户端侧统计口径提示（非服务商账单），弹窗与用量窗口共用 */
export function ClientStatsNotice({centered = false}: {centered?: boolean}) {
    return (
        <div className={`flex items-center gap-1.5 rounded-lg bg-[var(--surface-muted)] px-3 py-2 ${centered ? 'justify-center' : ''}`}>
            <Info className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]"/>
            <span className="text-[11px] text-[var(--text-muted)]">统计数据为客户端侧记录，仅供对照，实际用量以服务商官网为准</span>
        </div>
    )
}

/**
 * 预估成本口径说明（价格差异提示）
 * 成本按 OpenRouter 美元单价估算，与官方定价存在差异（缓存命中单价差异尤其显著），
 * 所有显示预估价格的场景统一引用此文案。
 * 人民币汇率：启动时从主进程同步实时汇率（currency-api），未同步时回退固定默认值。
 */
export function getCostDisclaimer(): string {
    return `成本按 OpenRouter 美元单价估算，可能与您使用的服务商价格存在差异；人民币按 1 USD ≈ ${getUsdCnyRate().toFixed(2)} CNY 实时汇率折算，实际费用请以服务商账单为准。`
}

/** 信息提示（圆圈问号 + hover tooltip），placement 控制展开方向（受限容器内用 top 向上展开） */
export function InfoTip({text, placement = 'bottom'}: {text: string; placement?: 'bottom' | 'top'}) {
    // 默认在触发点下方展开（top-full），top 模式改为上方展开（bottom-full）
    const positionClass = placement === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
    return (
        <div className="relative group shrink-0">
            <span
                role="img"
                aria-label="成本口径说明"
                className="w-4 h-4 rounded-full border border-[var(--border-emphasis)] text-[var(--text-muted)] flex items-center justify-center text-[10px] leading-none cursor-help select-none group-hover:text-[var(--text-secondary)] group-hover:border-[var(--text-secondary)] transition-colors"
            >
                ?
            </span>
            <div className={`absolute right-0 ${positionClass} w-72 rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] shadow-elevated px-3 py-2.5 text-[11px] leading-relaxed text-[var(--text-secondary)] opacity-0 pointer-events-none translate-y-0.5 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-150 z-50`}>
                {text}
            </div>
        </div>
    )
}
