/**
 * 用量统计明细表过滤栏：服务商/模型下拉 + 合计 token 范围（单位 M）
 * 过滤仅作用于明细表行（KPI / 趋势保持全量口径），纯前端内存过滤
 */
import {type UsageBreakdown} from '@shared/types'
import ThemedSelect from '../ThemedSelect'
import {
    EMPTY_USAGE_FILTER,
    hasActiveFilter,
    modelOptions,
    providerOptions,
    type UsageFilterState,
} from './usageFilter'

export function UsageFilterBar({view, rows, filter, onChange}: {
    view: 'provider' | 'model'
    rows: UsageBreakdown[]
    filter: UsageFilterState
    onChange: (next: UsageFilterState) => void
}) {
    const providers = providerOptions(rows)
    const models = modelOptions(rows, filter.provider)
    const inputCls = 'w-16 rounded-md border border-gray-200 hover:border-gray-300 focus:border-brand-300 bg-[var(--surface)] px-1.5 py-1 text-[11px] text-[var(--text-primary)] tabular-nums outline-none transition-colors'
    const labelCls = 'text-[11px] text-[var(--text-muted)] shrink-0'
    return (
        <div className="flex items-center gap-2 flex-wrap" data-testid="usage-filter-bar">
            <span className={labelCls}>服务商</span>
            <div className="max-w-40 shrink-0" data-testid="filter-provider">
                <ThemedSelect
                    value={filter.provider}
                    onChange={(provider) => {
                        // 服务商切换后原模型可能不在联动范围内，重置模型选择
                        const nextModels = modelOptions(rows, provider)
                        const model = filter.model !== '' && !nextModels.includes(filter.model) ? '' : filter.model
                        onChange({...filter, provider, model})
                    }}
                    options={[{value: '', label: '全部'}, ...providers.map(p => ({value: p, label: p}))]}
                />
            </div>
            {view === 'model' && (
                <>
                    <span className={labelCls}>模型</span>
                    <div className="max-w-60 shrink-0" data-testid="filter-model">
                        <ThemedSelect
                            value={filter.model}
                            onChange={(model) => onChange({...filter, model})}
                            options={[{value: '', label: '全部'}, ...models.map(m => ({value: m, label: m}))]}
                        />
                    </div>
                </>
            )}
            <span className={labelCls}>合计 token</span>
            <input
                type="number" data-testid="filter-total-min" placeholder="最小" min="0" step="any"
                className={inputCls}
                value={filter.totalMinM}
                onChange={(e) => onChange({...filter, totalMinM: e.target.value})}
            />
            <span className={labelCls}>–</span>
            <input
                type="number" data-testid="filter-total-max" placeholder="最大" min="0" step="any"
                className={inputCls}
                value={filter.totalMaxM}
                onChange={(e) => onChange({...filter, totalMaxM: e.target.value})}
            />
            <span className={labelCls}>M</span>
            {hasActiveFilter(filter) && (
                <button
                    data-testid="filter-clear"
                    onClick={() => onChange({...EMPTY_USAGE_FILTER})}
                    className="px-1.5 py-0.5 text-[11px] rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors shrink-0"
                >
                    清除
                </button>
            )}
        </div>
    )
}
