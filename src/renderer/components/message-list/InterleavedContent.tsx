/**
 * 交错内容组件
 *
 * ── 双路径架构 ──
 *
 * 由于历史原因，消息数据存在两种格式，本组件对应实现了两条渲染路径：
 *
 * 【新路径 — contentBlocks】（推荐）
 *   使用 message.contentBlocks[] 有序数组，每个块带有明确类型（text / think / tool_use / media）。
 *   LLM 输出的时间序天然保留在数组顺序中，无需额外排序。
 *
 * 【旧路径 — textOffset】（后向兼容）
 *   旧消息没有 contentBlocks 字段，通过 message.content（完整文本字符串）+ message.toolCalls[]
 *   的 textOffset 属性来交错渲染文本片段和工具调用。
 *   见：buildSegmentsFromFlatFields()
 *
 * 设计目标：当所有数据生产者迁移到 contentBlocks 后，可移除旧路径及本注释。
 */

import {useMemo} from 'react'
import {useThemeStore} from '../../stores/themeStore'
import {useAgentStore} from '../../stores/agentStore'
import type {Message, ToolCall, ThinkBlock as ThinkBlockType, MediaBlock} from '@shared/types'
import {isUltraCompactMode} from '../../lib/displayMode'
import ThinkBlock from '../ThinkBlock'
import MarkdownRenderer from './MarkdownRenderer'
import ToolCallRenderer, {UltraCompactToolGroup, UltraCompactCombinedGroup} from './ToolCallRenderer'
import {getToolDescription, resolveAgentDisplayName} from './utils/messageUtils'
import MediaPlayer from './MediaPlayer'

interface InterleavedContentProps {
    message: Message
    isUser: boolean
}

/**
 * 交错片段类型
 */
type Segment =
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
 * 增量渲染：流式期间每 200ms 完整渲染一次。
 * 流式过程 不 暴露原始 markdown 文本给用户——未渲染部分仅显示一个刷新的光标指示器。
 * 流结束后立即完整渲染。
 *
 * ★ 设计原则：
 *  用户不应看到原始 markdown 符号（**、`` ` `**、`|` 等），
 *  宁可让内容短暂跳跃，也不展示未解析的格式化文本。
 */
function ThrottledMarkdown({content, isUser, theme}: {
    content: string; isUser: boolean; theme: 'light' | 'dark' | 'yuanshandai' | 'shiyangjin'
}) {
    return (
        <div className="min-w-0">
            <MarkdownRenderer isUser={isUser} theme={theme}>{content}</MarkdownRenderer>
        </div>
    )
}

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

    // 兜底：没有任何文本段但有工具调用（textOffset 都为 0 或未设）
    if (segs.length === 0 && sorted.length > 0) {
        if (text) segs.push({type: 'text', content: text})
        sorted.forEach((tc) => {
            if (tc.reason) {
                segs.push({type: 'tool-with-reason', reason: tc.reason, toolCall: tc})
            } else {
                // 尝试自动生成描述作为 reason
                const desc = getToolDescription(tc)
                if (desc) {
                    segs.push({type: 'tool-with-reason', reason: desc, toolCall: tc})
                } else {
                    segs.push({type: 'tool', toolCall: tc})
                }
            }
        })
    }

    return segs
}

/**
 * 交错内容组件
 */
export default function InterleavedContent({message, isUser}: InterleavedContentProps) {
    const theme = useThemeStore((s) => s.theme)
    const text = typeof message.content === 'string' ? message.content : ''
    const calls = message.toolCalls || []

    // 按 textOffset 排序（仅旧路径使用）
    const sorted = useMemo(() => [...calls].sort((a, b) => (a.textOffset ?? 0) - (b.textOffset ?? 0)), [calls])

    // 构建交错片段
    const segments = useMemo(() => {
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
        return buildSegmentsFromFlatFields(text, sorted)
    }, [message.contentBlocks, sorted, text])

    // ── 紧凑模式：工具聚合 + 思考块合并 ──
    const displayMode = useAgentStore((s) => s.messageDisplayMode)
    const processedSegments = useMemo(() => {
        if (!isUltraCompactMode(displayMode)) return segments

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
        const result: Segment[] = []
        let i = 0
        while (i < grouped.length) {
            const seg = grouped[i]
            // text 直接透传，作为分隔符
            if (seg.type === 'text') {
                result.push(seg)
                i++
                continue
            }
            // 收集连续的 think-thread + tool-group（遇 text 即停）
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
                    } else {
                        // text 或其他 → 分段边界，停止收集
                        break
                    }
                }

                if (items.length > 0) {
                    result.push({type: 'combined-group', items, thinkCount, toolCalls: allToolCalls})
                }
            } else {
                result.push(seg)
                i++
            }
        }

        return result
    }, [segments, displayMode])

    // Early return: 如果没有内容且没有 contentBlocks（含 think/tool_use 等非文本块）
    if (calls.length === 0 && !text && !message.contentBlocks?.length) return null
    // 防御性兜底：即使 contentBlocks 非空，但 segments 为空且无文本无工具调用 → 空白气泡，返回 null
    if (segments.length === 0 && !text && calls.length === 0) return null

    const renderSegment = (seg: Segment, i: number) => {
        switch (seg.type) {
            case 'think-thread':
                return <div key={seg.blockId} className="mb-2"><ThinkBlock thinkBlock={seg.thinkBlock}/></div>
            case 'text':
                return seg.content ?
                    <ThrottledMarkdown key={`t-${i}`} content={seg.content} isUser={isUser} theme={theme}/> : null
            case 'media':
                return <div key={`media-${i}`} className="my-1"><MediaPlayer media={seg.mediaBlock}/></div>
            case 'tool-with-reason':
                return (
                    <div key={`tcwr-${seg.toolCall.id}`} className="mb-2 mt-2">
                        <div
                            className="text-[var(--text-secondary)] mb-2 italic bg-[var(--surface-muted)]/50 p-2 rounded-lg border border-[var(--border-muted)]">{seg.reason}</div>
                        <ToolCallRenderer toolCall={seg.toolCall}/>
                    </div>
                )
            case 'tool-group': {
                const isAgent = seg.toolCalls.length === 1 && seg.toolCalls[0].name === 'agent'
                const agentTc = isAgent ? seg.toolCalls[0] : null
                return (
                    <UltraCompactToolGroup
                        key={`tg-${i}`}
                        toolCalls={seg.toolCalls}
                        isAgent={isAgent}
                        agentDisplayName={agentTc ? resolveAgentDisplayName(agentTc) : null}
                        agentTypeLabel={agentTc ? ((agentTc.arguments as any)?.agentType ?? null) : null}
                    />
                )
            }
            case 'combined-group': {
                return (
                    <UltraCompactCombinedGroup
                        key={`cg-${i}`}
                        items={seg.items}
                        thinkCount={seg.thinkCount}
                        toolCalls={seg.toolCalls}
                        messageId={message.id}
                    />
                )
            }
            default:
                return <ToolCallRenderer key={`tc-${seg.toolCall.id}`} toolCall={seg.toolCall}/>
        }
    }

    return (
        <div className="text-sm leading-relaxed text-[var(--text-primary)]">
            {processedSegments.length === 0 && text
                ? <ThrottledMarkdown content={text} isUser={isUser} theme={theme}/>
                : processedSegments.map((seg, i) => renderSegment(seg, i))}
        </div>
    )
}
