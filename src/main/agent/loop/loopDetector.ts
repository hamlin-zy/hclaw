import {createHash} from 'crypto'

export interface TurnToolCall { name: string; args: Record<string, unknown>; resultPreview: string }
export interface LoopVerdict {
    kind: 'consecutive' | 'period2'
    fingerprint: string          // 触发模式的指纹（静默名单键）
    repeatCount: number          // 当前模式累计签名轮数
    detail: Array<{ toolName: string; argsPreview: string; turnNo: number }>
}

const MAX_VALUE_LEN = 2000

/** 纯元信息参数：仅向用户解释执行意图，不影响工具行为。
 *  必须从签名中剔除——HClaw 工具 schema 鼓励模型传 reason（如 bashTool），
 *  模型每次会用不同措辞描述同一命令，导致精确签名永远不同，循环检测失效 */
const META_PARAM_KEYS = new Set(['reason'])

/** 归一化：参数键排序 + 剔除元信息参数 + 长值截断，序列化后取哈希 */
function callSignature(c: TurnToolCall): string {
    const keys = Object.keys(c.args ?? {}).filter(k => !META_PARAM_KEYS.has(k)).sort()
    const normalized = keys.map(k => `${k}=${JSON.stringify(c.args[k])?.slice(0, MAX_VALUE_LEN) ?? ''}`).join('&')
    return createHash('sha1').update(`${c.name}|${normalized}|${(c.resultPreview ?? '').slice(0, MAX_VALUE_LEN)}`).digest('hex')
}

/** 模块级静默名单：sessionId -> Set<fingerprint>（进程内存，不落库）。
 *  仅在同线程内有效（worker 内 pause 档"本会话不再提示"使用）；
 *  渲染端静默走 LOOP_SILENCE 消息，不经过此 Map */
const silencedPatterns = new Map<string, Set<string>>()
export function silenceLoopPattern(sessionId: string, fingerprint: string): void {
    if (!silencedPatterns.has(sessionId)) silencedPatterns.set(sessionId, new Set())
    silencedPatterns.get(sessionId)!.add(fingerprint)
}
export function isLoopPatternSilenced(sessionId: string, fingerprint: string): boolean {
    return silencedPatterns.get(sessionId)?.has(fingerprint) ?? false
}

export class LoopDetector {
    private signatures: string[] = []                                  // 轮签名队列
    private turnNos: number[] = []                                     // 对应轮次号
    private turnCounter = 0
    private modeTurns = new Map<string, number>()                      // 模式指纹 -> 累计轮次
    private silencedSet = new Set<string>()
    // threshold 下限为 2（全局约束）
    constructor(private threshold = 3) { this.threshold = Math.max(2, threshold) }

    recordTurn(calls: TurnToolCall[]): LoopVerdict | null {
        if (!calls || calls.length === 0) return null
        this.turnCounter++
        const sig = calls.map(callSignature).join('>')
        this.signatures.push(sig); this.turnNos.push(this.turnCounter)
        if (this.signatures.length > 8) { this.signatures.shift(); this.turnNos.shift() }
        const n = this.signatures.length

        let fingerprint: string | null = null
        let kind: 'consecutive' | 'period2' | null = null
        let repeatCount = 0
        // 连续相同签名的尾部游程长度
        let stretch = 0
        for (let i = n - 1; i >= 0 && this.signatures[i] === sig; i--) stretch++
        // 连续 threshold 轮相同
        if (n >= this.threshold && stretch >= this.threshold) {
            kind = 'consecutive'; fingerprint = sig; repeatCount = stretch
        }
        // 周期 2：A,B,A,B
        if (!fingerprint && n >= 4) {
            const [a, b, c, d] = this.signatures.slice(-4)
            if (a === c && b === d && a !== b) { kind = 'period2'; fingerprint = b + '>' + a; repeatCount = 4 }
        }
        if (!fingerprint || !kind) return null
        if (this.silencedSet.has(fingerprint)) return null

        this.modeTurns.set(fingerprint, (this.modeTurns.get(fingerprint) ?? 0) + repeatCount)
        return {
            kind, fingerprint, repeatCount,
            detail: calls.map(c => ({toolName: c.name, argsPreview: JSON.stringify(c.args)?.slice(0, 120) ?? '', turnNo: this.turnCounter})),
        }
    }

    silence(fingerprint: string): void { this.silencedSet.add(fingerprint) }
    isSilenced(fingerprint: string): boolean { return this.silencedSet.has(fingerprint) }
    // 升级轮次 = threshold*2（设计文档 §2.5）；modeTurns 累计该指纹每次触发 verdict 的轮数，
    // display 的 repeatCount 是模式游程长度，两者语义不同
    isEscalationReached(fingerprint: string): boolean { return (this.modeTurns.get(fingerprint) ?? 0) >= this.threshold * 2 }
}

/** 从消息尾部提取"最近一轮 assistant 的工具调用 + 对应 tool 结果"。
 *  注意：ChatMessage 的 ToolCallInfo 字段是 {id, name, arguments}（不是 input），
 *  按 toolCallId 将 tool 结果消息配对到 assistant 调用；
 *  resultPreview 取结果文本前 MAX_VALUE_LEN 字符 */
export function buildTurnToolCalls(
    messages: Array<{ role: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; toolCallId?: string; toolResult?: string }>,
): TurnToolCall[] {
    // 从尾部向前找最近一条带 toolCalls 的 assistant 消息
    let assistantIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant' && messages[i].toolCalls && messages[i].toolCalls!.length > 0) {
            assistantIdx = i
            break
        }
    }
    if (assistantIdx < 0) return []

    // 收集其后（含自身位置之后的）tool 结果消息，按 toolCallId 配对
    const resultMap = new Map<string, string>()
    for (let i = assistantIdx + 1; i < messages.length; i++) {
        const m = messages[i]
        if (m.toolCallId != null && m.toolResult != null) resultMap.set(m.toolCallId, m.toolResult)
    }

    return messages[assistantIdx].toolCalls!.map(tc => ({
        name: tc.name,
        args: (tc.arguments ?? {}) as Record<string, unknown>,
        resultPreview: (resultMap.get(tc.id) ?? '').slice(0, MAX_VALUE_LEN),
    }))
}
