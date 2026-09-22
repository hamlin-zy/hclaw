/**
 * 语言守卫 pre-step（追加式，与 catalog/env/memory 三个 pre-step 同构）
 *
 * 目标：模型输出（正文/思考）从用户母语漂移成英文时，追加一条"对用户不可见、
 * 对 LLM 可见"的纠正 user 消息，让后续回复回到母语。
 *
 * 缓存安全铁律（spec §3）：
 * - 只追加不改：无 update-by-id、无 tombstone（与 catalogPublish 同铁律）；
 * - 本 pre-step 永不落 system prompt（**注意**：子会话另有 system 侧常驻语言段，
 *   由 controller 装配、与本注入机制相互独立且不共享状态，见 resolveSubagentLanguageSection）；
 * - **注入只允许发生在每个 run 的首次迭代**（controller 用 isLanguageGuardIteration
 *   守卫调用点）。原因：DB 层"一次用户发言 = 一条 assistant 行"，run 内内存态
 *   "一次 LLM 调用 = 一条 assistant 消息"；在 iteration ≥2 追加会让重建序列在注入点
 *   分叉（[u,a1,t1,INJ,a2] vs [u,apply(...),INJ]），注入点之后的前缀缓存全失效。
 *   代价（已接受）：iteration ≥2 检测到的漂移，纠正推迟到用户下次发言。
 *
 * 状态随注入消息自己的 metadata 走（零新增存储），依赖 userContentBuilder 的
 * metadata 白名单收拢 —— 否则 DB→worker 重建时两字段被静默丢弃 → 重启后重复 seed、
 * 配额重置。
 *
 * 整个 pre-step 包裹在 try-catch 内：语言守卫失败绝不阻断主循环。
 */

import {randomUUID} from 'crypto'
import type {ChatMessage, LoopState} from '../state'
import {addMessage} from '../state'
import type {IConversationRepository} from '../../repositories/interfaces'
import type {Message, SystemSettings} from '@shared/types'
import {SOURCE_KIND_LANGUAGE_GUARD} from '@shared/types/message'
import {localeDisplayName} from '@shared/localeNames'
import {LANGUAGE_DEFAULTS} from '@shared/settingsDefaults'
import {extractTextContent} from '../utils/contentUtils'
import {logger} from '../logger'

/** 判定常量：样本下限与汉字占比阈值（文件内常量，不暴露配置） */
const DRIFT_MIN_SAMPLE = 30
const DRIFT_RATIO_THRESHOLD = 0.15

/**
 * 剥离规则（冻结，spec §5.6）：被剥离部分不计入语言统计。
 * 顺序即优先级 —— 围栏代码块必须先于行内代码，URL 必须先于路径规则。
 */
const STRIP_RULES: RegExp[] = [
    /```[\s\S]*?```/g,                    // 围栏代码块（含语言标注行）
    /`[^`\n]*`/g,                         // 行内代码
    /https?:\/\/\S+/g,                    // URL
    /[A-Za-z]:\\[^\s"'`）)]*/g,           // Windows 路径
    /(?:^|\s)\/(?:usr|home|var|etc|tmp|opt|bin)\/[^\s"'`）)]*/g,   // Unix 路径
    /\b[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*|_[A-Za-z0-9_]+|\.[a-z]{2,5})\b/g,  // 标识符（snake/::/扩展名）
    /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g,       // 驼峰标识符
]

/** CJK 汉字（基本区 + 扩展 A 区） */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/g
/** 拉丁字母 */
const LATIN_RE = /[A-Za-z]/g

/**
 * 英文意图豁免（冻结，spec §5.5）：交替分支之间**不得含空格** ——
 * 写成 `英文 | English` 会让空格成为字面量，"用英文写"（英文后无空格）就不命中。
 * ★ 不得加 /g：带 /g 的 test() 会因 lastIndex 残留变成有状态，同一输入两次调用结果不同。
 */
const EXEMPTION_RE = /英文|英语|English|翻译|translate\s+(?:in)?to\s+English|in\s+English/i

/**
 * 判定器（纯函数，spec §5.6）。
 * ★ 调用方必须对正文与思考**分别**调用，禁止拼接后判定 —— 拼接会稀释比例：
 *   "正文纯中文 H=200 + 思考纯英文 L=300" 拼接后 ≈0.4 会被判正常，漏掉英文思考。
 */
export function detectDrift(text: string): boolean {
    if (!text) return false
    let stripped = text
    for (const rule of STRIP_RULES) stripped = stripped.replace(rule, ' ')
    stripped = stripped.replace(/\s+/g, ' ').trim()
    const cjk = stripped.match(CJK_RE)?.length ?? 0
    const latin = stripped.match(LATIN_RE)?.length ?? 0
    if (cjk + latin < DRIFT_MIN_SAMPLE) return false   // 样本不足：防纯代码/纯 JSON 回复误判
    return cjk / (cjk + latin) < DRIFT_RATIO_THRESHOLD
}

/** 英文意图豁免（纯函数，spec §5.5）：入参由调用方归一为纯文本（多模态取 text part） */
export function matchLanguageExemption(userText: string): boolean {
    return EXEMPTION_RE.test(userText)
}

/** 注入正文（纯函数产物：相同母语 → 相同字节；禁止时间戳/轮次/计数） */
export function renderLanguageGuardContent(localeName: string): string {
    return `<system-reminder>
无论何时都必须使用${localeName}书写，包括面向用户的回复、你的思考过程（reasoning）和工具调用规划。
这条要求覆盖此前上下文中的任何语言习惯。
</system-reminder>`
}

/**
 * 子会话常驻语言段正文（system 版，纯函数产物：相同母语 → 相同字节；
 * 禁止时间戳/轮次/计数）。
 *
 * ★ 与 renderLanguageGuardContent（user 版）文案同源但**包裹不同**：本函数不带
 *   `<system-reminder>`（system 段落直接以 Markdown 标题起始）。
 */
export function renderLanguageSystemSection(localeName: string): string {
    return `## 语言要求

无论何时都必须使用${localeName}书写，包括面向用户的回复、你的思考过程（reasoning）和工具调用规划。
这条要求覆盖此前上下文中的任何语言习惯。`
}

/**
 * 仅子会话注入常驻语言段：主会话的 system 必须字节稳定
 * （anthropicAdapter 唯一 cache_control 断点落在 system 上）。
 *
 * 本函数只产出**文案**；装配点在 controller（判定结果 + 签名入键）与 setup（透传）。
 * user 版注入机制（runLanguageGuardPreStep）完全不受影响：本段是"双保险 + 权威常驻"。
 */
export function resolveSubagentLanguageSection(
    isSubagentContext: boolean,
    settings: SystemSettings | undefined,
): string | null {
    if (!isSubagentContext) return null
    const cfg = settings?.language
    if (!cfg || cfg.strategy === 'off') return null
    const nativeLocale = cfg.nativeLocale
    const localeName = localeDisplayName(nativeLocale)
    if (!nativeLocale || !localeName) return null
    return renderLanguageSystemSection(localeName)
}

/** 语言守卫跨轮状态（真相是消息 metadata；本对象是 run 内对照缓存） */
export interface LanguageGuardState {
    /** 本母语下是否已做过首次预防注入（会话首次注入的关键判据） */
    seeded: boolean
    /** 截至当前累计注入次数（含首次预防注入） */
    injectedCount: number
    /** 上次注入时的母语标识；与当前配置不一致即视为母语变更 → 重置计数 */
    localeDigest?: string
}

/**
 * §3.2 硬约束的实现载体：注入只允许发生在每个 run 的首次迭代。
 * controller 用本函数守卫 runLanguageGuardPreStep 的调用点（**controller 自己的局部**
 * turnCount 在循环体内自增，=== 1 即本 run 首次迭代；注意这与 LoopState.turnCount
 * 无关 —— 后者由 createLoopState 初始化 0 后全仓无任何自增点）；iteration ≥2 直接不调用
 * → 零副作用。
 */
export function isLanguageGuardIteration(turnCount: number): boolean {
    return turnCount === 1
}

/**
 * 从消息流恢复状态（spec §5.2）：倒序取最后一条 language-guard 消息。
 *
 * 「母语变更检测」不在此处 —— 本函数拿不到 settings（冻结签名无 settings 参数），
 * 由 pre-step 用 `state.localeDigest` 与当前 nativeLocale 比较后重置。
 */
export function restoreLanguageGuardState(messages: ReadonlyArray<ChatMessage>): LanguageGuardState {
    for (let i = messages.length - 1; i >= 0; i--) {
        const meta = messages[i].metadata as Record<string, unknown> | undefined
        if (meta?.sourceKind === SOURCE_KIND_LANGUAGE_GUARD) {
            return {
                seeded: true,
                injectedCount: typeof meta.languageGuardCount === 'number' ? meta.languageGuardCount : 1,
                localeDigest: typeof meta.languageGuardDigest === 'string' ? meta.languageGuardDigest : undefined,
            }
        }
    }
    return {seeded: false, injectedCount: 0}
}

/** 倒序首条 assistant（spec §5.4 检测输入） */
function findLastAssistant(messages: ReadonlyArray<ChatMessage>): ChatMessage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') return messages[i]
    }
    return undefined
}

/**
 * 倒序首条**真实**用户消息（spec §5.5）。
 * 必须排除内部注入消息（catalog / system-env / memory / command-task / language-guard），
 * 否则注入后就地重读会读到注入消息本身，使判定结果依赖注入历史。
 */
function findLastRealUserMessage(messages: ReadonlyArray<ChatMessage>): ChatMessage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role !== 'user') continue
        const meta = msg.metadata as Record<string, unknown> | undefined
        if (meta?.sourceKind) continue
        return msg
    }
    return undefined
}

/** 追加一条纠正消息（追加式；sessionId 空时仅内存态） */
function injectLanguageGuard(
    currentState: LoopState,
    conversationRepo: IConversationRepository | null,
    sessionId: string | undefined,
    localeName: string,
    nativeLocale: string,
    count: number,
): {state: LoopState; languageGuardState: LanguageGuardState} {
    const created: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        content: renderLanguageGuardContent(localeName),
        metadata: {
            sourceKind: SOURCE_KIND_LANGUAGE_GUARD,
            languageGuardCount: count,
            languageGuardDigest: nativeLocale,
        },
    }
    const state = addMessage(currentState, created)
    if (conversationRepo && sessionId) {
        try {
            // ChatMessage 无 timestamp 字段；落库 Message 需要，此处补齐（与 envPublish 同款）
            conversationRepo.writeMessagesDelta(sessionId, {...created, timestamp: Date.now()} as unknown as Message)
        } catch (err) {
            logger.debug('[AgentLoop] language guard message persist failed', {error: String(err)})
        }
    } else {
        logger.debug('[AgentLoop] no session, language guard message kept in memory only')
    }
    logger.info('[AgentLoop] language guard injected', {count, locale: nativeLocale})
    return {state, languageGuardState: {seeded: true, injectedCount: count, localeDigest: nativeLocale}}
}

/**
 * 执行语言守卫 pre-step。
 *
 * 调用方（controller）必须用 isLanguageGuardIteration(turnCount) 守卫调用点（spec §3.2）。
 *
 * @returns 更新后的 LoopState 与 LanguageGuardState（无需注入时原样返回入参引用）
 */
export function runLanguageGuardPreStep(
    currentState: LoopState,
    lgState: LanguageGuardState,
    conversationRepo: IConversationRepository | null,
    sessionId: string | undefined,
    settings: SystemSettings | undefined,
): {state: LoopState; languageGuardState: LanguageGuardState} {
    /** 跳过本轮的统一返回体（state 与 lgState 均原样返回：零副作用，保持引用相等） */
    const unchanged = {state: currentState, languageGuardState: lgState}
    try {
        const cfg = settings?.language
        const strategy = cfg?.strategy ?? LANGUAGE_DEFAULTS.strategy
        // 前置条件 1：策略关闭 → 只停新注入（历史注入消息仍常驻，无法撤销）
        if (strategy === 'off') return unchanged

        // 前置条件 2：母语不可用 → 跳过而非猜测（worker 拿不到 app.getLocale()，
        // 兜底由启动侧 ensureDefaultLocale 写入）。宁可不注入，也不注入
        // "Reply to the user in undefined"。
        const nativeLocale = cfg?.nativeLocale
        const localeName = localeDisplayName(nativeLocale)
        if (!nativeLocale || !localeName) return unchanged

        // 母语变更 → seed 与配额一并重置（spec §5.2 第 4 条：口径为"每个母语"）
        const sameLocale = lgState.localeDigest === nativeLocale
        const next: LanguageGuardState = sameLocale
            ? lgState
            : {seeded: false, injectedCount: 0, localeDigest: nativeLocale}

        const limit = cfg?.correctionLimit ?? LANGUAGE_DEFAULTS.correctionLimit
        const withinLimit = limit === 'always' || next.injectedCount < limit
        /** 跳过本轮：state 与 lgState 均原样返回（零副作用，保持引用相等） */
        const keep = {state: currentState, languageGuardState: next}

        // ── 预防性首次注入（seed）：与检测结果相互独立（spec §5.3）──
        if (!next.seeded) {
            if (!withinLimit) {
                // 退化配置（如 limit=0）：不注入，但登记母语，避免每轮重复判定
                return {state: currentState, languageGuardState: {seeded: true, injectedCount: 0, localeDigest: nativeLocale}}
            }
            // 本迭代注入 seed 后直接返回：每个 run 至多注入一次（§5.3 注）。
            // 漂移若同时成立，其纠正顺延到用户下次发言的首次迭代。
            return injectLanguageGuard(
                currentState, conversationRepo, sessionId, localeName, nativeLocale, next.injectedCount + 1)
        }

        // ── 策略 first-only：seed 之后不再注入 ──
        if (strategy === 'first-only') return keep

        // ── 漂移检测：四道前置门，顺序固定（spec §5.4）──
        // 门 1：无检测输入（不存在 assistant；或正文与思考皆空 —— 纯 tool_calls 轮）
        // 这是一处**廉价早退**：删掉它行为不变（detectDrift('') === false，门 4 同样拦住空文本），
        // 它存在的唯一意义是让"无 assistant"路径不依赖外层 try-catch（lastAssistant 为 undefined
        // 时继续取 content/thinking 会抛）。因此**没有 pre-step 级别的断言能区分门 1**。
        const lastAssistant = findLastAssistant(currentState.messages)
        if (!lastAssistant) return keep
        const answerText = extractTextContent(lastAssistant.content)
        const thinkingText = lastAssistant.thinking ?? lastAssistant.reasoningContent ?? ''
        if (!answerText && !thinkingText) return keep

        // 门 2：英文意图豁免（只读本轮最近的**真实**用户消息）
        const lastUser = findLastRealUserMessage(currentState.messages)
        if (lastUser && matchLanguageExemption(extractTextContent(lastUser.content))) return keep

        // 门 3：熔断（累计注入达上限）
        if (!withinLimit) return keep

        // 门 4：判定器 —— 正文与思考**分别**判定，禁止拼接（拼接会稀释比例，漏判英文思考）
        if (!detectDrift(answerText) && !detectDrift(thinkingText)) return keep

        return injectLanguageGuard(
            currentState, conversationRepo, sessionId, localeName, nativeLocale, next.injectedCount + 1)
    } catch (err) {
        // 语言守卫失败不阻断主循环
        logger.debug('[AgentLoop] language guard pre-step skipped', {error: String(err)})
        return unchanged
    }
}
