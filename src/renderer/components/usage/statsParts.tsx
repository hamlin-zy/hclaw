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
