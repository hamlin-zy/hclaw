/**
 * AskUser 工具 — 向用户提问并等待回答
 *
 * 当 Agent 需要澄清用户意图或获取额外信息时使用。
 *
 * 执行流程：
 * 1. Agent 调用 ask_user，发送问题（和可选的选项列表）
 * 2. 工具阻塞等待，直到用户选择选项或输入内容
 * 3. 将用户回答作为上下文告知 LLM
 */
import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'

/**
 * ── 弱模型容错：参数归一化（2026-08-06 spec） ──
 * schema 宽进后，畸形参数在此清洗为干净数据。
 * 所有函数绝不抛异常：任何输入都收敛为可用值或安全降级。
 */

/** 强分隔符：换行、竖线 —— 选项文本内部极少出现，误拆风险低（v2 防误拆新增） */
const STRONG_SPLIT_RE = /\n|\|/

/** 弱分隔符：英文逗号、中文逗号、顿号、分号 —— 仅整串无强分隔符时使用 */
const WEAK_SPLIT_RE = /[,，、;；]+/

/** 成对括号（含中文全角）：括号内分隔符不参与弱拆分，防 "（彻底重构、改动最大）" 被顿号拦腰拆断 */
const PAIRED_BRACKET_RE = /[（(【\[「][^）)】\]」]*[）)】\]」]/g

/** 括号保护占位符（NUL 不出现在正常文本，不参与拆分/trim） */
const BRACKET_PLACEHOLDER = '\u0000'

/** 弱分隔符拆分：先把括号内容占位保护，拆分后再还原（括号内顿号/逗号永不充当选项分隔符） */
function splitByWeakSeparators(raw: string): string[] {
    const segments: string[] = []
    const masked = raw.replace(PAIRED_BRACKET_RE, (m) => {
        segments.push(m)
        return `${BRACKET_PLACEHOLDER}${segments.length - 1}${BRACKET_PLACEHOLDER}`
    })
    return masked.split(WEAK_SPLIT_RE).map((part) =>
        part.replace(
            new RegExp(`${BRACKET_PLACEHOLDER}(\\d+)${BRACKET_PLACEHOLDER}`, 'g'),
            (_, idx: string) => segments[Number(idx)] ?? ''
        )
    )
}

/** 序号模式：数字/字母/中文数字后跟 . ) 、（识别与拆分共用同一模式，避免两处失同步） */
const SEQUENCE_PATTERN = '\\d+[.)、]|[A-Za-z][.)、]|[一二三四五六七八九十]+[、.]'
/** 识别：字符串以序号开头 */
const SEQUENCE_RE = new RegExp(`^\\s*(?:${SEQUENCE_PATTERN})`)
/** 拆分：在每个序号前切分（lookahead，不消费字符） */
const SEQUENCE_SPLIT_RE = new RegExp(`(?=${SEQUENCE_PATTERN})`)

/** 选项原始类型（schema 宽进后可能出现的形态） */
export type RawOption = string | number | boolean | Record<string, unknown>

/** question 归一化结果：成功携带清洗后的问题，失败携带给 LLM 的中文错误 */
export type NormalizedQuestion = {ok: true; value: string} | {ok: false; error: string}

const MAX_QUESTION_LEN = 500
const MAX_OPTIONS = 10
const MAX_OPTION_LEN = 60

export function normalizeQuestion(raw: string | number): NormalizedQuestion {
    const value = typeof raw === 'number' ? String(raw) : raw
    const trimmed = value.trim()
    if (!trimmed) {
        return {
            ok: false,
            error:
                'question 不能为空。正确用法: ask_user({question: "要问的问题", options: ["选项A", "选项B"]})',
        }
    }
    return {ok: true, value: trimmed.length > MAX_QUESTION_LEN ? trimmed.slice(0, MAX_QUESTION_LEN) : trimmed}
}

/** 单个选项元素 → 字符串；无有效内容返回 null（丢弃） */
function optionToString(opt: RawOption): string | null {
    if (typeof opt === 'string') return opt
    if (typeof opt === 'number' || typeof opt === 'boolean') return String(opt)
    if (opt !== null && typeof opt === 'object') {
        for (const key of ['label', 'name', 'value', 'text']) {
            const v = (opt as Record<string, unknown>)[key]
            if (typeof v === 'string' && v.trim()) return v
            if (typeof v === 'number') return String(v)
        }
        return null // 无有效字段 → 丢弃，防止 "[object Object]"
    }
    return null
}

export function normalizeOptions(raw: string | RawOption[] | undefined): string[] | undefined {
    if (raw === undefined || raw === null) return undefined

    // ── 拆分成原始字符串列表 ──
    let items: string[]
    if (typeof raw === 'string') {
        // 含序号时优先按序号拆（spec: 避免 "一、苹果 二、香蕉" 被 `、` 当分隔符提前拆分）
        if (SEQUENCE_RE.test(raw)) {
            // 整串带序号（如 "1. 跑步 2. 游泳" / "一、苹果 二、香蕉"）：按序号 lookahead 拆分后去序号
            const seqSplit = raw.split(SEQUENCE_SPLIT_RE)
            const seqItems = seqSplit.map(s => s.replace(SEQUENCE_RE, ''))
            // 真正序号列表去前缀后应剩 ≥2 个非空段（如 "1. 跑步 2. 游泳" → 跑步/游泳/打球）；
            // "A、B、C" 被字母序号模式误判时去前缀后仅剩 1 段（如 'A、'→''、'B、C'→'C'）→ 降级弱拆分兜底
            const validSeqCount = seqItems.filter(s => s.trim().length > 0).length
            items = validSeqCount >= 2 ? seqItems : splitByWeakSeparators(raw)
        } else if (STRONG_SPLIT_RE.test(raw)) {
            // 强分隔符（换行/竖线）优先：选项文本内部极少出现，顿号/逗号不参与，避免误拆
            items = raw.split(STRONG_SPLIT_RE)
        } else {
            // 弱分隔符（顿号/逗号/分号）兜底：括号保护后拆分，防选项内部并列短语被拦腰拆断
            items = splitByWeakSeparators(raw)
        }
    } else {
        items = raw.map(optionToString).filter((s): s is string => s !== null)
    }

    // ── 统一清洗：trim + 过滤空串/纯空白 ──
    items = items.map(s => s.trim()).filter(s => s.length > 0)

    // ── 单选项超长截断（UI 有 CSS ellipsis 兜底，这里防撑爆） ──
    if (items.some(s => s.length > MAX_OPTION_LEN)) {
        console.warn(`[askUserTool] 部分选项超过 ${MAX_OPTION_LEN} 字符，已截断`)
        items = items.map(s => (s.length > MAX_OPTION_LEN ? s.slice(0, MAX_OPTION_LEN) : s))
    }

    // ── 选项数量上限 ──
    if (items.length > MAX_OPTIONS) {
        console.warn(`[askUserTool] 选项数量超过 ${MAX_OPTIONS} 个，已截断`)
        items = items.slice(0, MAX_OPTIONS)
    }

    // ── 全部被过滤 → undefined（弹窗降级为自由输入，不渲染按钮） ──
    return items.length > 0 ? items : undefined
}

const MULTI_SELECT_TRUE = new Set(['true', 'yes', 'y', '1', 'on'])
const MULTI_SELECT_FALSE = new Set(['false', 'no', '0', 'off'])

export function normalizeMultiSelect(raw: boolean | string | number | undefined): boolean {
    if (raw === true || raw === 1) return true
    if (raw === false || raw === 0) return false
    if (typeof raw === 'string') {
        const lower = raw.trim().toLowerCase()
        if (MULTI_SELECT_TRUE.has(lower)) return true
        if (MULTI_SELECT_FALSE.has(lower)) return false
    }
    return false // 未知值/缺省 → 宽松默认 false
}

const inputSchema = z.object({
    question: z.union([z.string(), z.number()]).describe('向用户提出的问题'),
    /** 可选的选项列表：字符串数组、元素可为对象（自动取 label/name/value/text），或分隔字符串（自动拆分） */
    options: z
        .union([
            z.array(z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown())])),
            z.string(),
        ])
        .optional()
        .describe('可选的选项列表，字符串数组或分隔字符串（自动拆分）'),
    /** 是否允许多选，默认单选；接受布尔变体字符串（"true"/"yes"/"1" 等） */
    multiSelect: z
        .union([z.boolean(), z.string(), z.number()])
        .optional()
        .describe('是否允许多选，默认单选'),
})

type AskUserInput = z.infer<typeof inputSchema>

export const askUserTool: Tool<AskUserInput, string> = {
    name: 'ask_user',
    description:
        '向用户提问并等待回答。用于澄清意图或获取额外信息。工具会阻塞直到用户选择选项或输入内容。\n' +
        '- question 必填：简洁明确的问题，一次只问一个问题\n' +
        '- options 可选：字符串数组 ["A","B"] 或分隔字符串 "A、B"（自动拆分）\n' +
        '- multiSelect 可选：true/false\n' +
        '若已有足够信息或能自行推理，不要调用本工具。',
    inputSchema,
    requiredPermissions: [],
    isDestructive: false,

    async execute(args: AskUserInput, context: ToolContext): Promise<ToolResult<string>> {
        // 检查是否有 askUserQuestion 方法（由 worker.ts 注入）
        if (!context.askUserQuestion) {
            return {
                success: false,
                output: '',
                error: 'askUserQuestion not available',
            }
        }

        // ── 归一化：畸形参数清洗为干净数据（绝不抛异常） ──
        const q = normalizeQuestion(args.question)
        if (!q.ok) {
            return {success: false, output: '', error: q.error}
        }
        const options = normalizeOptions(args.options)
        const multiSelect = normalizeMultiSelect(args.multiSelect)

        try {
            // 调用 askUserQuestion，会阻塞直到用户回答
            const answer = await context.askUserQuestion(q.value, options, multiSelect)

            // 构建包含原始问题和用户回答的完整上下文
            const optionsText = options && options.length > 0 ? `\n选项: ${options.join('、')}` : ''

            return {
                success: true,
                output: `问题: ${q.value}${optionsText}\n用户回答: ${answer}`,
            }
        } catch (err) {
            return {
                success: false,
                output: '',
                error: err instanceof Error ? err.message : 'Unknown error',
            }
        }
    },
}
