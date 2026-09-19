/**
 * scheduleCron — 定时任务 cron 配置模型（ui-08）
 *
 * 从 `ScheduleUtils.ts` 整体搬出的 `// ─── Cron 配置模型 ───` 段（纯数据 / 纯函数，无 JSX、无配色）。
 * 拆出的动机有二：
 *   1. 与并行改动的 ScheduleUtils 状态/标签函数解耦，避免同文件冲突；
 *   2. 让「频率保真」这条性质（`configToCron(cronToConfig(e)) ≡ e`，≡ = 归一化后相等）有一个可独立断言的归属地。
 *
 * 硬约束——频率保真：任何一条已有表达式读出再写回必须完全等价（语义等价；写法差异如
 * `7`↔`0`、`MON`↔`1`、多余空白不算失真）。旧实现解构时丢弃第 4 段（月份）、
 * 对日字段用 `parseInt('1,15') = 1`，往返必然失真。现改为「解析候选 config → 用 configToCron
 * 反向自检」，比对前先归一化；写不回者退回高级模式并**逐字节保留原文**。
 */

export type CronMode = 'daily' | 'weekly' | 'monthly' | 'interval' | 'custom'

/**
 * 「退回高级模式」的两类原因（I-3）：文案必须与事实相符，故两类分开表达。
 *  - `unparsed`：表达式不是标准五段格式（段数不对、含非数字），谈不上「套用四种说法」；
 *  - `not-writable`：语义上可归类，但字面量写不回原文（日列表 `1,15`、乱序周 `3,1`、指定月份段…）。
 */
export type CustomReason = 'unparsed' | 'not-writable'

export interface CronConfig {
    mode: CronMode
    dailyHour: number
    dailyMin: number
    weeklyDays: boolean[]
    weeklyHour: number
    weeklyMin: number
    monthlyDate: number
    monthlyHour: number
    monthlyMin: number
    intervalValue: number
    intervalUnit: 'minutes' | 'hours'
    customExpr: string
    /**
     * 仅由 `cronToConfig` 在「表达式退回高级模式」时置真。
     * 用于让界面**显式告知**用户（用户故事 32），而不是隐式地把它当成某个近似说法。
     * 用户一旦主动切换模式或改动表达式即清零（见 useScheduleFormState.updateCron）。
     */
    unrecognized: boolean
    /** `unrecognized` 为真时的细分原因（措辞区分）；未退高级时为 null。 */
    customReason: CustomReason | null
}

export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']
/** 每月可选的「几号」。cron 日字段取值 1-31，故扩到 31（原为 1-28，选不到 29/30/31）。 */
export const MONTHLY_DATES = Array.from({length: 31}, (_, i) => i + 1)

export function makeDefaultConfig(overrides: Partial<CronConfig> = {}): CronConfig {
    return {
        mode: 'daily',
        dailyHour: 9, dailyMin: 0,
        weeklyDays: [false, true, true, true, true, true, false],
        weeklyHour: 9, weeklyMin: 0,
        monthlyDate: 1, monthlyHour: 9, monthlyMin: 0,
        intervalValue: 30, intervalUnit: 'minutes',
        customExpr: '0 9 * * *',
        unrecognized: false,
        customReason: null,
        ...overrides,
    }
}

/** 严格整数字段解析：仅接受纯数字且落在 [lo, hi] 内，否则返回 null（不静默截断 `1,15` 这类多值）。 */
function parseField(spec: string, lo: number, hi: number): number | null {
    if (!/^\d+$/.test(spec)) return null
    const n = parseInt(spec, 10)
    return n >= lo && n <= hi ? n : null
}

/** 解析周字段（`1-5` / `1,3` / `0` / `*`），返回长度 7 的布尔数组。异常的段（如 `6-0` 反向区间、非数字）不产生任何位。 */
function parseWeekdays(spec: string): boolean[] {
    const days = [false, false, false, false, false, false, false]
    for (const part of spec.split(',')) {
        const range = part.split('-')
        if (range.length === 2) {
            const [s, e] = range.map(n => (/^\d+$/.test(n) ? parseInt(n, 10) : NaN))
            for (let i = s; i <= e; i++) if (i >= 0 && i <= 6) days[i] = true
        } else {
            const d = parseField(part, 0, 6)
            if (d !== null) days[d] = true
        }
    }
    return days
}

// ─── 归一化（I-3）───────────────────────────────

/** 命名的星期（大小写不敏感）→ 数字。cron 里 `MON` 与 `1` 同义。 */
const WEEKDAY_NAMES: Record<string, number> = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

/**
 * 单个周字段片段（数字 / 命名星期 / `*`）→ 规范数字串；无法归一返回 null。
 * `7` 等价 `0`（周日），但 **仅限单值位置**：区间端点必须传 `allowSeven=false`，
 * 理由见 `normalizeWeekdayField`。
 */
function normalizeWeekdayPart(part: string, allowSeven = true): string | null {
    const t = part.trim().toLowerCase()
    if (t === '*') return '*'
    if (/^\d+$/.test(t)) {
        const n = parseInt(t, 10)
        if (n === 7) return allowSeven ? '0' : null
        return n >= 0 && n <= 6 ? String(n) : null
    }
    return WEEKDAY_NAMES[t] !== undefined ? String(WEEKDAY_NAMES[t]) : null
}

/**
 * 周字段归一：单值 `7`→`0`、命名星期→数字；任一片段无法归一则整段原样返回
 * （不会被误判为可归类）。
 *
 * 区间端点**不做** `7→0`：`7` 作为区间**起点**在后端是非法的（`7-1` 即 `min(7) > max(1)`，
 * cron-parser 直接抛错，该任务永不触发）。若把它归一成 `0-1`，就等于把一条非法降序区间
 * 伪装成合法升序区间——反向自检通过、`unrecognized=false`、无告警，保存即被静默改写成
 * 另一个频率（`7-6` 甚至从「永不触发」变成「每天触发」）。归一后仍是 `7-k`，候选 weekly
 * 填不出周集、回写真不回，于是诚实地落高级模式并告警。
 */
function normalizeWeekdayField(spec: string): string {
    const out: string[] = []
    for (const part of spec.split(',')) {
        const range = part.split('-')
        if (range.length === 2) {
            const s = normalizeWeekdayPart(range[0], false)
            const e = normalizeWeekdayPart(range[1], false)
            if (s === null || e === null || s === '*' || e === '*') return spec
            out.push(`${s}-${e}`)
        } else {
            const v = normalizeWeekdayPart(part)
            if (v === null) return spec
            out.push(v)
        }
    }
    return out.join(',')
}

/**
 * 把表达式规整成可比较的规范形：字段间多余空白折叠、周字段**单值** `7`→`0`、
 * 命名星期（`MON`/`sun`，大小写不敏感）→数字；区间端点不映射 `7`（见 `normalizeWeekdayField`）。
 *
 * 判「可归类」用的是**归一化后的比对**：`0 9 * * 7` 与 `0 9 * * 0` 语义等价，
 * 不该因为写法不同被断言「无法套用四种说法」（I-3）。段数不为 5 时只折叠空白。
 */
export function normalizeCron(cron: string): string {
    const parts = cron.trim().split(/\s+/)
    if (parts.length !== 5) return cron.trim().replace(/\s+/g, ' ')
    return [parts[0], parts[1], parts[2], parts[3], normalizeWeekdayField(parts[4])].join(' ')
}

// ─── 从自由表达式尽力提取各字段（I-1 播种用）────────

/** 从一条（未必可归类的）表达式里尽力抽出的 分/时/日/周 四段值；抽不出为 null。 */
export interface CronFieldSeeds {
    minute: number | null
    hour: number | null
    /** 日字段能解析出的日期集（1..31）；含范围或 `*` 时为 null。 */
    dates: number[] | null
    /** 周字段能解析出的星期集（长度 7，下标 0=周日）；`*` 或不可解析时为 null。 */
    weekdays: boolean[] | null
}

/** 逗号分隔的纯数字列表（不认范围/步长），越界即整段作废——宁可 null 也不猜。 */
function parseNumberList(spec: string, lo: number, hi: number): number[] | null {
    const out: number[] = []
    for (const part of spec.split(',')) {
        if (!/^\d+$/.test(part)) return null
        const n = parseInt(part, 10)
        if (n < lo || n > hi) return null
        out.push(n)
    }
    return out.length > 0 ? out : null
}

/**
 * 尽力从表达式里抽出可用于播种目标模式的值。
 * 抽不出就留 null（由调用方保留该模式的既有值，而非用 9:00 凭空生成）。
 */
export function extractCronFields(cron: string): CronFieldSeeds {
    const parts = normalizeCron(cron).split(' ')
    if (parts.length !== 5) return {minute: null, hour: null, dates: null, weekdays: null}
    const [minS, hourS, dayS, , weekdayS] = parts
    return {
        minute: parseField(minS, 0, 59),
        hour: parseField(hourS, 0, 23),
        dates: dayS === '*' ? null : parseNumberList(dayS, 1, 31),
        weekdays: weekdayS === '*' ? null : parseWeekdays(weekdayS),
    }
}

/**
 * 从「高级」里的原表达式派生目标模式的各字段（I-1）。
 * 场景：用户打开一条落高级的任务 → 点「每天」——各字段应从原表达式派生，
 * 而不是让 `makeDefaultConfig` 的 9:00 凭空覆盖掉原频率（那会静默丢掉用户原意）。
 * 派生不出的字段返回缺省（调用方合并时保留原值）。
 */
export function seedFromCustomExpr(expr: string, mode: CronMode): Partial<CronConfig> {
    const f = extractCronFields(expr)
    switch (mode) {
        case 'daily': {
            const out: Partial<CronConfig> = {}
            if (f.hour !== null) out.dailyHour = f.hour
            if (f.minute !== null) out.dailyMin = f.minute
            return out
        }
        case 'weekly': {
            const out: Partial<CronConfig> = {}
            if (f.hour !== null) out.weeklyHour = f.hour
            if (f.minute !== null) out.weeklyMin = f.minute
            if (f.weekdays) out.weeklyDays = f.weekdays
            return out
        }
        case 'monthly': {
            const out: Partial<CronConfig> = {}
            if (f.hour !== null) out.monthlyHour = f.hour
            if (f.minute !== null) out.monthlyMin = f.minute
            // 每月 UI 只承载单个日期，取解析出的日期集中第一个（多日期请用高级表达式）
            if (f.dates && f.dates.length > 0) out.monthlyDate = f.dates[0]
            return out
        }
        case 'interval': {
            const parts = normalizeCron(expr).split(' ')
            if (parts.length !== 5) return {}
            if (INTERVAL_STEP.test(parts[0])) return {intervalUnit: 'minutes', intervalValue: parseInt(parts[0].slice(2), 10)}
            if (parts[0] === '0' && INTERVAL_STEP.test(parts[1])) return {intervalUnit: 'hours', intervalValue: parseInt(parts[1].slice(2), 10)}
            return {}
        }
        default:
            return {}
    }
}

// 间隔步长：`*/` + N，**N 必须 ≥ 1**（正写作 `*/0` 会提前闭合块注释，故此段用行注释）。
//
// 步长 0 的表达式在后端（`cron-parser`，与 `SchedulerEngine` 同一库）直接抛
// `Constraint error, cannot repeat at every 0 time` —— 该任务**永不触发**。
// 若把它归入 `interval`，界面会渲染出「每 0 分钟」这种具体而荒谬的频率，
// 与 I-3 修掉的谎报同类；且 ui-06 后该摘要已可见于**列表行**，故必须落高级模式并告警。
// 注意只拒 0：步长 60（`*/60 * * * *`）在 cron-parser 下合法（每小时第 0 分），不得顺手判非法。
const INTERVAL_STEP = /^\*\/[1-9]\d*$/

/** 对一条合法 5 段表达式给出「最接近四种说法」的候选 config（是否真的能写回由 cronToConfig 自检）。 */
function buildCandidate(cron: string, parts: string[]): CronConfig {
    const [minS, hourS, dayS, , weekdayS] = parts
    const min = parseField(minS, 0, 59)
    const hour = parseField(hourS, 0, 23)

    // 间隔（分钟）：*/N * * * *（步长 <1 不归此支，见 INTERVAL_STEP）
    if (INTERVAL_STEP.test(minS)) {
        return makeDefaultConfig({mode: 'interval', intervalValue: parseInt(minS.slice(2), 10), intervalUnit: 'minutes', customExpr: cron})
    }
    // 间隔（小时）：0 */N * * *
    if (minS === '0' && INTERVAL_STEP.test(hourS)) {
        return makeDefaultConfig({mode: 'interval', intervalValue: parseInt(hourS.slice(2), 10), intervalUnit: 'hours', customExpr: cron})
    }
    // 每周：周字段非 *
    if (weekdayS !== '*') {
        return makeDefaultConfig({mode: 'weekly', weeklyDays: parseWeekdays(weekdayS), weeklyHour: hour ?? 9, weeklyMin: min ?? 0, customExpr: cron})
    }
    // 每月：日字段非 *（月字段非 * 时反向自检会拒绝，落高级）
    if (dayS !== '*') {
        const date = parseField(dayS, 1, 31)
        return makeDefaultConfig({mode: 'monthly', monthlyDate: date ?? 1, monthlyHour: hour ?? 9, monthlyMin: min ?? 0, customExpr: cron})
    }
    // 每天
    return makeDefaultConfig({mode: 'daily', dailyHour: hour ?? 9, dailyMin: min ?? 0, customExpr: cron})
}

/**
 * 把 cron 表达式读成 config。
 * 关键：候选 config 必须能被 `configToCron` **按归一化后的写法**写回；写不回才退回高级模式。
 * 比对前先归一化（空白/`7`↔`0`/命名星期），否则 `0 9 * * 7`、`0 9 * * MON` 这类
 * 语义明确的标准写法会被误报「无法套用四种说法」（I-3）——判定与文案都对不上事实。
 * 退回高级时 `customExpr` 保留**原文**（未被归一化），保存时逐字节写回。
 */
export function cronToConfig(cron: string): CronConfig {
    const normalized = normalizeCron(cron)
    const parts = normalized.split(' ')
    if (parts.length !== 5) {
        return makeDefaultConfig({mode: 'custom', customExpr: cron, unrecognized: true, customReason: 'unparsed'})
    }
    const candidate = buildCandidate(normalized, parts)
    if (normalizeCron(configToCron(candidate)) !== normalized) {
        return makeDefaultConfig({mode: 'custom', customExpr: cron, unrecognized: true, customReason: 'not-writable'})
    }
    // 候选是把归一化后的写法读出来的；原文仍由 customExpr 承载（点回「高级」可见）
    return {...candidate, customExpr: cron}
}

export function configToCron(c: CronConfig): string {
    switch (c.mode) {
        case 'daily':
            return `${c.dailyMin} ${c.dailyHour} * * *`
        case 'weekly': {
            const days = c.weeklyDays.map((v, i) => v ? i : -1).filter(i => i >= 0)
            if (days.length === 0) return `${c.weeklyMin} ${c.weeklyHour} * * *`
            if (days.length >= 2 && days.every((d, i) => i === 0 || d === days[i - 1] + 1))
                return `${c.weeklyMin} ${c.weeklyHour} * * ${days[0]}-${days[days.length - 1]}`
            return `${c.weeklyMin} ${c.weeklyHour} * * ${days.join(',')}`
        }
        case 'monthly':
            return `${c.monthlyMin} ${c.monthlyHour} ${c.monthlyDate} * *`
        case 'interval':
            return c.intervalUnit === 'minutes' ? `*/${c.intervalValue} * * * *` : `0 */${c.intervalValue} * * *`
        case 'custom':
            // 不再兜底成 `0 9 * * *`（II-5）：那会把「清空后保存」静默写成别的频率。
            // 空表达式原样返回——由 useScheduleFormState.handleSave 拒存并给出校验错误。
            return c.customExpr
    }
}

/**
 * 人话摘要（几点、周几、几号）。
 * custom 分支回显 cron 表达式（2026-09-19 用户拍板：高级模式的任务应在列表/摘要里
 * 直接看到表达式，而不是一句「高级表达式」的遮掩；原契约 H3「行内不得出现表达式」就此作废）。
 * 空表达式（II-5 拒存路径）给一句中性说明，避免渲染出「自定义 」这样的残句。
 */
export function cronToHuman(c: CronConfig): string {
    switch (c.mode) {
        case 'daily':
            return `每天 ${String(c.dailyHour).padStart(2, '0')}:${String(c.dailyMin).padStart(2, '0')}`
        case 'weekly': {
            const days = c.weeklyDays.map((v, i) => v ? WEEKDAY_LABELS[i] : null).filter(Boolean) as string[]
            const dayStr = days.length === 7 ? '每天' : days.length === 5 && !c.weeklyDays[0] && !c.weeklyDays[6] ? '每工作日' : `每周${days.join('、周')}`
            return `${dayStr} ${String(c.weeklyHour).padStart(2, '0')}:${String(c.weeklyMin).padStart(2, '0')}`
        }
        case 'monthly':
            return `每月 ${c.monthlyDate} 日 ${String(c.monthlyHour).padStart(2, '0')}:${String(c.monthlyMin).padStart(2, '0')}`
        case 'interval':
            return `每 ${c.intervalValue} ${c.intervalUnit === 'minutes' ? '分钟' : '小时'}`
        case 'custom':
            return c.customExpr ? `自定义 ${c.customExpr}` : '自定义（高级表达式）'
    }
}

/**
 * 人话频率摘要（直接吃表达式）。
 *
 * 列表行、编辑弹窗折叠摘要共用同一份 `cronToHuman`，措辞永远一致。
 * custom 分支回显表达式原文（含无法归类的写法——那正是用户需要看到的信息）。
 */
export function describeCron(cron: string): string {
    return cronToHuman(cronToConfig(cron))
}
