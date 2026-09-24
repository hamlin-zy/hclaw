/**
 * 分页控制条（spec §5.4）：三枚图标同族 —— 展开下一页 / 收起一页 / 回到默认条数。
 * 落点由调用方决定（段末、子列表末、最近会话区标题右侧）。
 * 按需渲染：∨∨ 仅当还有下一页（count < total）；∧∧ 仅当已超出默认（count > defaultCount）；
 * ∧∧∧ 常显 —— 它同时是「当前不在默认视图」的指示器，无页可翻时置灰不可点。
 *
 * `only="reset"`（spec §5.6）：只渲染 ∧∧∧。用于最近会话区标题右侧 —— 那里是列表被裁切时
 * 仍常驻可及的一行，只需要「一键收起」，翻页两枚仍留在列表末尾（同一 count/total 入参）。
 */
/** 按钮盒高 16px（2026-09-24 用户反馈：控制条整体再压一档；原 18px 来自 demo .pbtn L106-110 的
    w24/h18）—— 原 p-0.5 的自撑 padding 会让条高 ≈22px，与行之间形成「断裂感」（回炉反馈 2） */
const BTN = 'flex h-[16px] w-6 shrink-0 items-center justify-center rounded text-[10px] leading-none text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent'

/* 三枚按钮内容为 SVG 图标（与 demo 定稿同形，笔画 1.6 / 圆角端点）；原为文字速记 ∨∨/∧∧/∧∧∧，
   文字速记仅是规格表的记号，不是视觉定稿 —— 图标才是真身，规格保留：几何仍走 16×16 笔画栅格 */
const PAGER_ICON_PROPS = {
    className: 'w-3.5 h-3.5',
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
}

/* 三枚按钮的作用文案：**单源定义**（`aria-label` 与 `title` 同值引用）。
   `title` 是可见提示的载体 —— 全局 TooltipPortal（App.tsx 挂载）接管文档内所有 [title]，
   渲染主题化浮层（接管时移走原生 title，避免双份提示）；契约与 IconButton 一致
   （label 同时作 aria-label 与 title）。2026-09-24 用户反馈：此前只有 aria-label，
   悬停看不到任何提示，用户认不出这三枚图标的作用。 */
const LABELS = {
    expand: '展开下一页',
    collapse: '收起一页',
    reset: '回到默认条数',
} as const

export interface PagerBarProps {
    listKey: 'section' | 'child' | 'recent'
    count: number
    defaultCount: number
    step: number
    total: number
    onChange: (next: number) => void
    align?: 'center' | 'left'
    /** 只渲染 ∧∧∧（标题行复用；缺省渲染三枚） */
    only?: 'reset'
    /** 追加到容器的类（调用方定缩进/间距，如子列表内与子行内容起点对齐）；
     *  容器自身不带水平 padding，避免与追加类冲突 */
    className?: string
}

export function PagerBar({listKey, count, defaultCount, step, total, onChange, align = 'center', only, className}: PagerBarProps) {
    return (
        <div data-name="pager-bar" data-pager-key={listKey}
             className={`flex items-center gap-[2px] py-[2px] ${align === 'center' ? 'justify-center' : 'justify-start'}${className ? ` ${className}` : ''}`}>
            {only !== 'reset' && count < total && (
                /* title 挂包裹层而非 button 本身：disabled 的 button 不再接收 mouseover，
                   提示会漏掉置灰态（∧∧∧ 在未翻页时恒为 disabled）。包裹层接住指针事件，
                   两态都能被全局 TooltipPortal 接管。 */
                <span className="inline-flex" title={LABELS.expand}>
                    <button type="button" data-name="pager-expand" aria-label={LABELS.expand}
                            className={BTN} onClick={() => onChange(count + step)}>
                        <svg {...PAGER_ICON_PROPS}>
                            <path d="M4 3.5 8 7l4-3.5"/><path d="M4 8.5 8 12l4-3.5"/>
                        </svg>
                    </button>
                </span>
            )}
            {only !== 'reset' && count > defaultCount && (
                <span className="inline-flex" title={LABELS.collapse}>
                    <button type="button" data-name="pager-collapse" aria-label={LABELS.collapse}
                            className={BTN} onClick={() => onChange(Math.max(defaultCount, count - step))}>
                        <svg {...PAGER_ICON_PROPS}>
                            <path d="M4 12.5 8 9l4 3.5"/><path d="M4 7.5 8 4l4 3.5"/>
                        </svg>
                    </button>
                </span>
            )}
            <span className="inline-flex" title={LABELS.reset}>
                <button type="button" data-name="pager-reset" aria-label={LABELS.reset}
                        disabled={count === defaultCount || total === 0}
                        className={BTN} onClick={() => onChange(defaultCount)}>
                    <svg {...PAGER_ICON_PROPS}>
                        <path d="M4 14 8 11.2l4 2.8"/><path d="M4 9.6 8 6.8l4 2.8"/><path d="M4 5.2 8 2.4l4 2.8"/>
                    </svg>
                </button>
            </span>
        </div>
    )
}
