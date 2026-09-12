import {useEffect, useLayoutEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'

/** 周标题：周一为首日（与 Chromium zh-CN 一致） */
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
/** 弹层高度估算，用于上/下翻转判断（6 行日格 + 头部 + 底部按钮） */
const PANEL_MAX_H = 340
/** 一次渲染的日格数量（6 行 × 7 列，含相邻月置灰日期） */
const DAY_CELLS = 42
/** 年份网格一屏 12 年 */
const YEARS_PER_PAGE = 12

export interface DatePickerProps {
    /** '' 或 'yyyy-mm-dd' */
    value: string
    /** 清除时回调 '' */
    onChange(next: string): void
    ariaLabel: string
    disabled?: boolean
    placeholder?: string
    /** 可选下界（含），'yyyy-mm-dd'；非法值视为无约束 */
    min?: string
    /** 可选上界（含），'yyyy-mm-dd'；非法值视为无约束 */
    max?: string
    /** 供调用点适配尺寸（PM 过滤栏是小尺寸） */
    className?: string
}

type DateParts = { y: number; m: number; d: number }
type View = 'days' | 'months' | 'years'

/** 补零格式化 */
function pad2(n: number): string {
    return String(n).padStart(2, '0')
}

/** 手工格式化为 yyyy-mm-dd（禁止 new Date(string) 解析） */
function fmt(y: number, m: number, d: number): string {
    return `${y}-${pad2(m)}-${pad2(d)}`
}

/**
 * 解析 yyyy-mm-dd：既校验格式，也校验日期真实存在（拒绝 2026-02-30）。
 * 一律用 new Date(y, m-1, d) 本地构造 + 回读比对，规避时区坑。
 */
function parseDate(s: string): DateParts | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
    const y = Number(s.slice(0, 4))
    const m = Number(s.slice(5, 7))
    const d = Number(s.slice(8, 10))
    if (m < 1 || m > 12 || d < 1 || d > 31) return null
    const dt = new Date(y, m - 1, d)
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null
    return {y, m, d}
}

/**
 * 通用日期选择器（受控）
 *
 * 替换原生 <input type="date">：原生弹层是 Chromium UI，不在页面 DOM 内，
 * 无法用主题 token 定制，只能靠 color-scheme 跟随暗色。
 *
 * 浮层范式复用 ThemedSelect：
 * - createPortal 挂到 body（脱离 backdrop-filter stacking context）
 * - useLayoutEffect + getBoundingClientRect 上/下翻转、右缘钳制
 * - 点击外部 / Esc 关闭，主题面板样式 --surface-elevated / --border / --shadow-overlay
 *
 * 支持手输（draft 态，非法不提交、blur 还原）、三级视图（日/月/年）、今天/清除。
 */
export default function DatePicker({
                                       value,
                                       onChange,
                                       ariaLabel,
                                       disabled = false,
                                       placeholder = 'yyyy-mm-dd',
                                       min,
                                       max,
                                       className = '',
                                   }: DatePickerProps) {
    const now = new Date()
    const today: DateParts = {y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate()}
    const parsedValue = parseDate(value)

    // min/max 归一化为 'yyyy-mm-dd'（定长零填充，可直接字典序比较）；非法值忽略
    const minParts = min ? parseDate(min) : null
    const maxParts = max ? parseDate(max) : null
    const minStr = minParts ? fmt(minParts.y, minParts.m, minParts.d) : null
    const maxStr = maxParts ? fmt(maxParts.y, maxParts.m, maxParts.d) : null
    /** 该日期是否被 min/max 排除（闭区间，超出即不可选） */
    const outOfRange = (y: number, m: number, d: number): boolean => {
        const s = fmt(y, m, d)
        return (minStr !== null && s < minStr) || (maxStr !== null && s > maxStr)
    }

    // 手输 draft：输入过程不提交，value 外部变化时同步
    const [draft, setDraft] = useState(value)
    useEffect(() => {
        setDraft(value)
    }, [value])

    // 提交未采纳回滚（F3）：提交时记下「提议值」，渲染后若 value 仍不等于它，说明父组件
    // 忽略 / 改写了本次提交（如 UsageWindow 的 `if (v) setCustomRange(...)` 忽略空值），
    // 此时把 draft 同步回 value，避免「显示与状态静默分叉」。
    // commitSeq 的作用：value 未变（父组件不采纳）时 [value] 不变、effect 不会重跑，
    // 故用自增计数器强制触发一次检查。这最多多渲染一次——检查完立即清空 ref，
    // 且 setDraft 不改变 [value, commitSeq]，所以不会形成无限循环。
    const pendingCommitRef = useRef<string | null>(null)
    const [commitSeq, setCommitSeq] = useState(0)
    useEffect(() => {
        const pending = pendingCommitRef.current
        if (pending === null) return
        pendingCommitRef.current = null
        if (value !== pending) setDraft(value)
    }, [value, commitSeq])

    const [open, setOpen] = useState(false)
    const [view, setView] = useState<View>('days')
    const [cursor, setCursor] = useState<{ y: number; m: number }>(() => ({
        y: parsedValue?.y ?? today.y,
        m: parsedValue?.m ?? today.m,
    }))
    const [yearBase, setYearBase] = useState(0)
    const [pos, setPos] = useState<{ top: number; left: number; width: number; dropUp: boolean } | null>(null)

    const wrapRef = useRef<HTMLDivElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)

    // 打开面板：以当前 value（或今天）为锚点，重置到日视图
    const openPanel = () => {
        if (disabled) return
        const anchor = parsedValue ?? today
        setCursor({y: anchor.y, m: anchor.m})
        setView('days')
        setOpen(true)
    }

    // 位置计算：默认向下，空间不足且上方更宽裕时向上翻转（照抄 ThemedSelect）
    useLayoutEffect(() => {
        if (!open || !wrapRef.current) return
        const rect = wrapRef.current.getBoundingClientRect()
        const dropUp = window.innerHeight - rect.bottom < PANEL_MAX_H && rect.top > PANEL_MAX_H
        setPos({top: dropUp ? rect.top - 6 : rect.bottom + 6, left: rect.left, width: rect.width, dropUp})
    }, [open])

    // 靠窗口右缘时实测宽度向左收拢，钳制在视口内
    useLayoutEffect(() => {
        if (!open || !pos || !panelRef.current) return
        const pw = panelRef.current.offsetWidth
        const maxLeft = window.innerWidth - pw - 8
        if (pos.left > maxLeft) {
            setPos(p => (p ? {...p, left: Math.max(8, maxLeft)} : p))
        }
    }, [open, pos])

    // 打开后把焦点移入面板，保证键盘可达（Tab 进入内部按钮）
    useEffect(() => {
        if (open) panelRef.current?.focus()
    }, [open])

    // 点击外部关闭 + Esc 逐级返回
    useEffect(() => {
        if (!open) return
        const handleOutside = (e: MouseEvent) => {
            const t = e.target as Node
            if (panelRef.current?.contains(t) || wrapRef.current?.contains(t)) return
            setOpen(false)
        }
        const handleKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return
            if (view === 'years') setView('months')
            else if (view === 'months') setView('days')
            else setOpen(false)
        }
        document.addEventListener('mousedown', handleOutside)
        document.addEventListener('keydown', handleKey)
        return () => {
            document.removeEventListener('mousedown', handleOutside)
            document.removeEventListener('keydown', handleKey)
        }
    }, [open, view])

    // Tab 离开整个组件（输入框 + 触发按钮 + portal 面板）时关闭
    const handleBlurCapture = (e: React.FocusEvent) => {
        const next = e.relatedTarget as Node | null
        if (!next) return
        if (wrapRef.current?.contains(next) || panelRef.current?.contains(next)) return
        setOpen(false)
    }

    // 所有提交都走 propose：记录提议值 → 触发父组件。父组件若未采纳（忽略或改写成别的值），
    // 上面的回滚 effect 会把 draft 同步回 value，杜绝显示与状态静默分叉。
    const propose = (next: string) => {
        pendingCommitRef.current = next
        setCommitSeq(s => s + 1)
        onChange(next)
    }

    /**
     * 提交 draft（Enter 与 blur 共用）：
     * - 空 → 等价「清除」（value 非空才回调）；
     * - 合法且在 min/max 范围内 → 提交（仅在归一化值与 value 不同才回调，避免重复回调）。
     * - 非法 / 超范围 → 不提交并返回 false（blur 据此把显示还原为 value）。
     */
    const commitDraft = (): boolean => {
        if (draft.trim() === '') {
            if (value !== '') propose('')
            return true
        }
        const p = parseDate(draft)
        if (!p || outOfRange(p.y, p.m, p.d)) return false
        const normalized = fmt(p.y, p.m, p.d)
        if (normalized !== value) propose(normalized)
        return true
    }

    const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            commitDraft()
        } else if (e.key === 'Escape') {
            setDraft(value)
        }
    }

    // blur：合法则提交（与原生 <input type="date"> 失焦即提交对齐）；非法 / 超范围则还原为 value
    // （不静默清空、不提交越界值）。
    const handleInputBlur = () => {
        if (!commitDraft()) setDraft(value)
    }

    const pickDate = (y: number, m: number, d: number) => {
        // 防御：超范围日期不可选（日格已 disabled，此处兜底手输/程序化触发）
        if (outOfRange(y, m, d)) return
        setCursor({y, m})
        setView('days')
        propose(fmt(y, m, d))
        setOpen(false)
    }

    const enterMonths = () => setView('months')
    const enterYears = () => {
        setYearBase(Math.floor(cursor.y / YEARS_PER_PAGE) * YEARS_PER_PAGE)
        setView('years')
    }

    // 日格数据：以周一为首日，从当月 1 号前推 offset 天，共 42 格
    const firstWeekday = (new Date(cursor.y, cursor.m - 1, 1).getDay() + 6) % 7
    const firstCell = new Date(cursor.y, cursor.m - 1, 1 - firstWeekday)
    const dayCells = Array.from({length: DAY_CELLS}, (_, i) => {
        const dt = new Date(firstCell.getFullYear(), firstCell.getMonth(), firstCell.getDate() + i)
        const y = dt.getFullYear()
        const m = dt.getMonth() + 1
        const d = dt.getDate()
        return {
            y, m, d,
            inMonth: m === cursor.m && y === cursor.y,
            isToday: y === today.y && m === today.m && d === today.d,
            isSelected: !!parsedValue && y === parsedValue.y && m === parsedValue.m && d === parsedValue.d,
            outOfRange: outOfRange(y, m, d),
        }
    })

    // "今天"按钮：今天超出 min/max 时禁用（不收敛到边界，避免静默选中用户未点的日期）
    const todayOutOfRange = outOfRange(today.y, today.m, today.d)

    return (
        <div ref={wrapRef} className="dp-root" onBlur={handleBlurCapture} data-name="datepicker">
            <input
                type="text"
                inputMode="numeric"
                value={draft}
                disabled={disabled}
                placeholder={placeholder}
                aria-label={ariaLabel}
                onChange={(e) => setDraft(e.target.value)}
                onMouseDown={openPanel}
                onFocus={openPanel}
                onKeyDown={handleInputKeyDown}
                onBlur={handleInputBlur}
                className={`dp-input ${className}`}
                data-name="datepicker-input"
            />
            <button
                type="button"
                disabled={disabled}
                aria-label={`${ariaLabel}，打开日历`}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => (open ? setOpen(false) : openPanel())}
                className="dp-trigger"
                data-name="datepicker-trigger"
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="18" rx="2"/>
                    <line x1="16" y1="2" x2="16" y2="6"/>
                    <line x1="8" y1="2" x2="8" y2="6"/>
                    <line x1="3" y1="10" x2="21" y2="10"/>
                </svg>
            </button>

            {open && createPortal(
                <div
                    ref={panelRef}
                    role="dialog"
                    aria-label={`${ariaLabel}日期选择`}
                    tabIndex={-1}
                    onBlur={handleBlurCapture}
                    style={{
                        position: 'fixed',
                        top: pos?.dropUp ? undefined : pos?.top,
                        bottom: pos?.dropUp ? window.innerHeight - (pos?.top ?? 0) : undefined,
                        left: pos?.left,
                        minWidth: pos?.width,
                    }}
                    className="dp-panel animate-context-menu-enter"
                    data-name="datepicker-panel"
                >
                    {view === 'days' && (
                        <>
                            <div className="dp-topnav">
                                <button type="button" className="dp-icon-btn" aria-label="下一年"
                                        onClick={() => setCursor(c => ({...c, y: c.y + 1}))}>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                        <polyline points="18 15 12 9 6 15"/>
                                    </svg>
                                </button>
                                <button type="button" className="dp-icon-btn" aria-label="上一年"
                                        onClick={() => setCursor(c => ({...c, y: c.y - 1}))}>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                        <polyline points="6 9 12 15 18 9"/>
                                    </svg>
                                </button>
                            </div>
                            <div className="dp-header">
                                <button type="button" className="dp-icon-btn" aria-label="上一个月"
                                        onClick={() => setCursor(c => c.m === 1 ? {y: c.y - 1, m: 12} : {y: c.y, m: c.m - 1})}>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                        <polyline points="15 18 9 12 15 6"/>
                                    </svg>
                                </button>
                                <button type="button" className="dp-title" data-testid="datepicker-month-title"
                                        aria-label="选择月份，当前年月" onClick={enterMonths}>
                                    {cursor.y}年{pad2(cursor.m)}月
                                </button>
                                <button type="button" className="dp-icon-btn" aria-label="下一个月"
                                        onClick={() => setCursor(c => c.m === 12 ? {y: c.y + 1, m: 1} : {y: c.y, m: c.m + 1})}>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                        <polyline points="9 18 15 12 9 6"/>
                                    </svg>
                                </button>
                            </div>
                            <div className="dp-grid dp-weekdays" aria-hidden="true">
                                {WEEKDAYS.map(w => <span key={w} className="dp-weekday">{w}</span>)}
                            </div>
                            <div className="dp-grid dp-days">
                                {dayCells.map((c, i) => (
                                    <button
                                        key={i}
                                        type="button"
                                        aria-label={`${c.y}年${pad2(c.m)}月${pad2(c.d)}日`}
                                        aria-selected={c.isSelected}
                                        aria-current={c.isToday ? 'date' : undefined}
                                        disabled={c.outOfRange}
                                        onClick={() => pickDate(c.y, c.m, c.d)}
                                        className={`dp-day${c.inMonth ? '' : ' dp-day--muted'}${c.isToday ? ' dp-day--today' : ''}${c.isSelected ? ' dp-day--selected' : ''}${c.outOfRange ? ' opacity-35 cursor-not-allowed disabled:hover:bg-transparent' : ''}`}
                                        data-name={`datepicker-day-${c.y}-${pad2(c.m)}-${pad2(c.d)}`}
                                    >
                                        {c.d}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}

                    {view === 'months' && (
                        <>
                            <div className="dp-header">
                                <button type="button" className="dp-icon-btn" aria-label="上一年"
                                        onClick={() => setCursor(c => ({...c, y: c.y - 1}))}>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                        <polyline points="15 18 9 12 15 6"/>
                                    </svg>
                                </button>
                                <button type="button" className="dp-title" data-testid="datepicker-year-title"
                                        aria-label="选择年份" onClick={enterYears}>
                                    {cursor.y}年
                                </button>
                                <button type="button" className="dp-icon-btn" aria-label="下一年"
                                        onClick={() => setCursor(c => ({...c, y: c.y + 1}))}>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                        <polyline points="9 18 15 12 9 6"/>
                                    </svg>
                                </button>
                            </div>
                            <div className="dp-grid dp-months">
                                {Array.from({length: 12}, (_, i) => {
                                    const m = i + 1
                                    const active = !!parsedValue && parsedValue.y === cursor.y && parsedValue.m === m
                                    const isThisMonth = today.y === cursor.y && today.m === m
                                    return (
                                        <button
                                            key={m}
                                            type="button"
                                            aria-label={`${cursor.y}年${pad2(m)}月`}
                                            aria-selected={active}
                                            aria-current={isThisMonth ? 'date' : undefined}
                                            onClick={() => {
                                                setCursor(c => ({...c, m}))
                                                setView('days')
                                            }}
                                            className={`dp-cell${active ? ' dp-cell--selected' : ''}${isThisMonth ? ' dp-cell--today' : ''}`}
                                            data-name={`datepicker-month-${m}`}
                                        >
                                            {m}月
                                        </button>
                                    )
                                })}
                            </div>
                        </>
                    )}

                    {view === 'years' && (
                        <>
                            <div className="dp-header">
                                <button type="button" className="dp-icon-btn" aria-label="上一页"
                                        onClick={() => setYearBase(b => b - YEARS_PER_PAGE)}>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                        <polyline points="15 18 9 12 15 6"/>
                                    </svg>
                                </button>
                                <span className="dp-title dp-title--static" data-testid="datepicker-years-range">
                                    {yearBase}年 - {yearBase + YEARS_PER_PAGE - 1}年
                                </span>
                                <button type="button" className="dp-icon-btn" aria-label="下一页"
                                        onClick={() => setYearBase(b => b + YEARS_PER_PAGE)}>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                        <polyline points="9 18 15 12 9 6"/>
                                    </svg>
                                </button>
                            </div>
                            <div className="dp-grid dp-years">
                                {Array.from({length: YEARS_PER_PAGE}, (_, i) => {
                                    const y = yearBase + i
                                    const active = !!parsedValue && parsedValue.y === y
                                    const isThisYear = today.y === y
                                    return (
                                        <button
                                            key={y}
                                            type="button"
                                            aria-label={`${y}年`}
                                            aria-selected={active}
                                            aria-current={isThisYear ? 'date' : undefined}
                                            onClick={() => {
                                                setCursor(c => ({...c, y}))
                                                setView('months')
                                            }}
                                            className={`dp-cell${active ? ' dp-cell--selected' : ''}${isThisYear ? ' dp-cell--today' : ''}`}
                                            data-name={`datepicker-year-${y}`}
                                        >
                                            {y}
                                        </button>
                                    )
                                })}
                            </div>
                        </>
                    )}

                    <div className="dp-footer">
                        <button type="button" className="dp-footer-btn"
                                onClick={() => {
                                    propose('')
                                    setOpen(false)
                                }}>
                            清除
                        </button>
                        <button type="button"
                                className="dp-footer-btn dp-footer-btn--primary disabled:opacity-40 disabled:cursor-not-allowed"
                                disabled={todayOutOfRange}
                                onClick={() => pickDate(today.y, today.m, today.d)}>
                            今天
                        </button>
                    </div>
                </div>,
                document.body,
            )}
        </div>
    )
}