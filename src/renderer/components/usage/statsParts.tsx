import {Info} from 'lucide-react'
import type {ReactNode} from 'react'

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

/** 统计行：标签左、数值右，等宽数字对齐 */
export function StatRow({label, value, valueClass}: {label: string; value: string; valueClass?: string}) {
    return (
        <div className="flex items-center justify-between text-sm leading-6">
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
 */
export const COST_DISCLAIMER =
    '成本按 OpenRouter 美元单价估算，可能与您使用的服务商价格存在差异；人民币按固定汇率 7.2 折算，实际费用请以服务商账单为准。'

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
