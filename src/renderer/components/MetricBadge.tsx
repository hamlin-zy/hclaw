import {memo, type ReactNode} from 'react'

/**
 * 指标徽章 — inputArea 底部状态栏的胶囊形统计徽章
 *
 * - children：徽章文字内容
 * - pct：0-100 可选；提供时渲染 conic-gradient 进度边框环，缺省 accent 按 pct 分级
 *   （<50 健康绿、50-80 提醒黄、>=80 危险红，复用主题 token 自动适配四主题）
 * - accent：边框颜色；覆盖分级规则。不传 pct 时渲染纯色静态边框（供吞吐等非百分比指标使用，
 *   填充 100% 即整环同色）
 *
 * 进度环实现：conic-gradient 按 pct 填充 + mask 只留 1.5px 边框环。
 * 文字层需保留足够垂直内边距（py-1），避免顶部进度弧压字（CJK 字形渲染上溢）。
 */
const MetricBadge = memo(function MetricBadge({
    children,
    pct,
    accent,
}: {
    children: ReactNode
    pct?: number
    accent?: string
}) {
    const resolvedAccent =
        accent ??
        (pct == null ? undefined : pct >= 80 ? 'var(--error)' : pct >= 50 ? 'var(--warning)' : 'var(--success)')

    return (
        <span className="relative inline-flex items-center align-middle">
            {/* 边框环层：pct 提供时按比例填充，否则 100% 纯色静态边框 */}
            <span
                aria-hidden
                className="absolute inset-0 rounded-full pointer-events-none"
                style={{
                    padding: '1.5px',
                    background: `conic-gradient(${resolvedAccent ?? 'var(--border)'} ${pct ?? 100}%, var(--border) 0)`,
                    WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
                    WebkitMaskComposite: 'xor',
                    mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
                    maskComposite: 'exclude',
                }}
            />
            {/* 文字层：py-1 保证顶部留白 ≥ 进度环宽度（1.5px）+ CJK 字形上溢，避免进度弧压字 */}
            <span
                className="relative px-2 py-1 text-sm tabular-nums leading-none"
                style={pct == null && resolvedAccent ? {color: resolvedAccent} : undefined}
            >
                {children}
            </span>
        </span>
    )
})

export default MetricBadge
