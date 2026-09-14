/**
 * 展示片段构建（纯函数模块）
 *
 * 从 InterleavedContent.tsx 抽出：消息 → 交错基础片段（contentBlocks 新路径 / textOffset 旧路径）
 * → 紧凑模式下工具聚合 + 思考合并。
 *
 * 抽出目的：极简模式的两级弹窗持有「打开时刻的快照」，数据不再跟随消息更新。
 * 现在弹窗可按 anchor（toolCallId / blockId）从最新 message 实时重推导片段（pull 模型），
 * 找不到时回退快照。
 *
 * ★ 语义必须与抽取前逐字保持一致，含既有修复：
 *   - 空白 text（trim 后为空）在紧凑模式下不作为分隔符；
 *   - agent 工具单独成组（先 flush 当前组再单独成组）；
 *   - 旧路径 buildSegmentsFromFlatFields 行为不变。
 */

import type {Message, ToolCall, ThinkBlock as ThinkBlockType, MediaBlock} from '@shared/types'

/**
 * 交错片段类型
 */
export type Segment =
    | { type: 'text'; content: string }
    | { type: 'tool'; toolCall: ToolCall }
    | { type: 'tool-with-reason'; reason: string; toolCall: ToolCall }
    | { type: 'tool-group'; toolCalls: ToolCall[] }
    | { type: 'think-thread'; thinkBlock: ThinkBlockType; blockId: string }
    | { type: 'media'; mediaBlock: MediaBlock }
    | { type: 'combined-group'; items: CombinedItem[]; thinkCount: number; toolCalls: ToolCall[] }

/**
 * 聚合卡片中的有序条目（思考块或工具组）
 */
export type CombinedItem =
    | { type: 'think'; thinkBlock: ThinkBlockType; blockId: string }
    | { type: 'tools'; toolCalls: ToolCall[] }

/**
 * 【旧路径】从扁平字段（text + toolCalls.textOffset）构建交错片段。
 *
 * 后向兼容：旧消息没有 contentBlocks，通过 textOffset 属性确定工具调用在文本中的插入位置。
 * 当所有数据生产者迁移到 contentBlocks 后，此函数可移除。
 *
 * @param text   消息全文（message.content）
 * @param sorted 已按 textOffset 升序排列的工具调用列表
 * @returns 按时间序交错的片段数组
 */
function buildSegmentsFromFlatFields(text: string, sorted: ToolCall[]): Segment[] {
    const segs: Segment[] = []
    let lastEnd = 0

    for (const tc of sorted) {
        const offset = tc.textOffset ?? lastEnd
        if (offset > lastEnd) {
            segs.push({type: 'text', content: text.slice(lastEnd, offset)})
        }

        // reason 只有在紧贴前一段末尾（无间隔文本）时才渲染为 tool-with-reason
        if (tc.reason && lastEnd === offset) {
            segs.push({type: 'tool-with-reason', reason: tc.reason, toolCall: tc})
        } else {
            segs.push({type: 'tool', toolCall: tc})
        }
        lastEnd = offset
    }

    // 剩余文本
    if (lastEnd < text.length) {
        segs.push({type: 'text', content: text.slice(lastEnd)})
    }

    return segs
}

/**
 * 构建消息的基础交错片段（不聚合）。
 *
 * 新路径：contentBlocks 有序渲染；旧路径：textOffset 交错（后向兼容）。
 */
function buildBaseSegments(message: Message): Segment[] {
    // ── 新路径：使用 contentBlocks 有序渲染 ──────────────────────────────
    if (message.contentBlocks && message.contentBlocks.length > 0) {
        const segs: Segment[] = []
        for (const cb of message.contentBlocks) {
            switch (cb.type) {
                case 'think':
                    if (cb.thinkBlock) {
                        segs.push({type: 'think-thread', thinkBlock: cb.thinkBlock, blockId: cb.id})
                    }
                    break
                case 'text':
                    if (cb.text) {
                        segs.push({type: 'text', content: typeof cb.text === 'string' ? cb.text : ''})
                    }
                    break
                case 'tool_use':
                    if (cb.toolCall) {
                        const tc = cb.toolCall
                        if (tc.reason) {
                            segs.push({type: 'tool-with-reason', reason: tc.reason, toolCall: tc})
                        } else {
                            segs.push({type: 'tool', toolCall: tc})
                        }
                    }
                    break
                case 'media':
                    if (cb.media) {
                        segs.push({type: 'media', mediaBlock: cb.media})
                    }
                    break
            }
        }
        return segs
    }

    // ── 旧路径：使用 textOffset 交错（后向兼容） ─────────────────────────
    const text = typeof message.content === 'string' ? message.content : ''
    const calls = message.toolCalls || []
    // 按 textOffset 排序
    const sorted = [...calls].sort((a, b) => (a.textOffset ?? 0) - (b.textOffset ?? 0))
    return buildSegmentsFromFlatFields(text, sorted)
}

/**
 * 紧凑模式聚合：连续 tool 片段聚合为 tool-group，再按正文分段把连续的 think + tool
 * 合并为 combined-group。
 */
function groupUltraCompact(segments: Segment[]): Segment[] {
    // Step 1: 将连续 tool 片段聚合成 tool-group
    const grouped: Segment[] = []
    let toolGroup: ToolCall[] = []

    const flushGroup = () => {
        if (toolGroup.length > 0) {
            grouped.push({type: 'tool-group', toolCalls: toolGroup})
            toolGroup = []
        }
    }

    for (const seg of segments) {
        if (seg.type === 'tool') {
            // Agent 工具：先 flush 当前组，再单独成组
            if (seg.toolCall.name === 'agent') {
                flushGroup()
                grouped.push({type: 'tool-group', toolCalls: [seg.toolCall]})
            } else {
                toolGroup.push(seg.toolCall)
            }
        } else {
            // 非 tool 片段：flush 当前组再添加
            flushGroup()
            grouped.push(seg)
        }
    }
    flushGroup()

    // Step 2: 按正文分段，每段内连续的 think + tool 合并为一个聚合组
    //
    // ★ 修复：空白 text（trim 后为空，如 '\n\n\n'）在紧凑模式下不作为分隔符，
    //   避免把「无正文」的连续 think+tool 切成多个聚合组——
    //   用户期望没有正文时整个消息合并为一个组。
    const result: Segment[] = []
    let i = 0
    while (i < grouped.length) {
        const seg = grouped[i]
        // text 作为分隔符；但空白文本不产生分隔（直接跳过）
        if (seg.type === 'text') {
            if (seg.content.trim()) {
                result.push(seg)
            }
            i++
            continue
        }
        // 收集连续的 think-thread + tool-group（遇实质 text 即停）
        if (seg.type === 'think-thread' || seg.type === 'tool-group') {
            const items: CombinedItem[] = []
            let thinkCount = 0
            const allToolCalls: ToolCall[] = []

            while (i < grouped.length) {
                const s = grouped[i]
                if (s.type === 'think-thread') {
                    items.push({type: 'think', thinkBlock: s.thinkBlock, blockId: s.blockId})
                    thinkCount++
                    i++
                } else if (s.type === 'tool-group') {
                    items.push({type: 'tools', toolCalls: s.toolCalls})
                    allToolCalls.push(...s.toolCalls)
                    i++
                } else if (s.type === 'text' && !s.content.trim()) {
                    // 空白文本：跳过，不打断聚合
                    i++
                } else {
                    // 有实质内容的 text 或其他 → 分段边界，停止收集
                    break
                }
            }

            // 进入本分支时首元素必为 think-thread / tool-group，故 items 非空
            result.push({type: 'combined-group', items, thinkCount, toolCalls: allToolCalls})
        } else {
            result.push(seg)
            i++
        }
    }

    return result
}

/**
 * 构建消息的展示片段。
 *
 * @param message     最新消息对象
 * @param ultraCompact 是否为极简（ultra-compact）模式；false 时仅返回基础片段
 */
export function buildDisplaySegments(message: Message, ultraCompact: boolean): Segment[] {
    const segments = buildBaseSegments(message)
    if (!ultraCompact) return segments
    return groupUltraCompact(segments)
}

/**
 * 按 anchor（toolCallId / blockId）在片段中定位聚合组，返回其完整数据。
 * 用于 L1 聚合弹窗从最新消息实时重推导。
 *
 * - 命中 tool-group（其 toolCalls 含 anchor.toolCallId）→ 单工具组
 * - 命中 combined-group（含 anchor.toolCallId，或某 think 子项 blockId === anchor.blockId）→ 聚合组
 * - 未命中 → null
 */
export function resolveGroupByAnchor(
    segments: Segment[],
    anchor: {toolCallId?: string; blockId?: string},
): {items: CombinedItem[]; thinkCount: number; toolCalls: ToolCall[]} | null {
    for (const seg of segments) {
        if (seg.type === 'tool-group') {
            if (anchor.toolCallId && seg.toolCalls.some((tc) => tc.id === anchor.toolCallId)) {
                return {items: [{type: 'tools', toolCalls: seg.toolCalls}], thinkCount: 0, toolCalls: seg.toolCalls}
            }
        } else if (seg.type === 'combined-group') {
            const hitTool = !!anchor.toolCallId && seg.toolCalls.some((tc) => tc.id === anchor.toolCallId)
            const hitThink = !!anchor.blockId && seg.items.some((it) => it.type === 'think' && it.blockId === anchor.blockId)
            if (hitTool || hitThink) {
                return {items: seg.items, thinkCount: seg.thinkCount, toolCalls: seg.toolCalls}
            }
        }
    }
    return null
}

/**
 * 按 anchor.toolCallId 在片段中定位工具调用集，返回其最新 toolCalls。
 * 用于 L2 工具详情弹窗从最新消息实时重推导。
 *
 * - 命中 combined-group 内的 tools 子项（含 anchor.toolCallId）→ 该子项 toolCalls
 * - 命中顶层 tool-group → 其 toolCalls
 * - 未命中 → null
 */
export function resolveToolCallsByAnchor(
    segments: Segment[],
    anchor: {toolCallId?: string; blockId?: string},
): ToolCall[] | null {
    for (const seg of segments) {
        if (seg.type === 'combined-group') {
            if (anchor.toolCallId) {
                const item = seg.items.find(
                    (it): it is Extract<CombinedItem, {type: 'tools'}> =>
                        it.type === 'tools' && it.toolCalls.some((tc) => tc.id === anchor.toolCallId),
                )
                if (item) return item.toolCalls
            }
        } else if (seg.type === 'tool-group') {
            if (anchor.toolCallId && seg.toolCalls.some((tc) => tc.id === anchor.toolCallId)) {
                return seg.toolCalls
            }
        }
    }
    return null
}
