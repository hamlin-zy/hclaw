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

import {memo, useEffect, useMemo, useRef, useState} from 'react'
import {useThemeStore} from '../../stores/themeStore'
import {useAgentStore} from '../../stores/agentStore'
import {useConversationStore} from '../../stores/conversationStore'
import type {Message, ThemeName} from '@shared/types'
import {isUltraCompactMode} from '../../lib/displayMode'
import ThinkBlock from '../ThinkBlock'
import MarkdownRenderer from './MarkdownRenderer'
import ToolCallRenderer, {UltraCompactToolGroup, UltraCompactCombinedGroup} from './ToolCallRenderer'
import {resolveAgentDisplayName, resolveSkillDisplayName, isSkillToolCall} from './utils/messageUtils'
import {buildDisplaySegments, type Segment, type CombinedItem} from './utils/displaySegments'
import MediaPlayer from './MediaPlayer'

// 外部引用兼容：CombinedItem 现由 utils/displaySegments 定义
export type {CombinedItem}

interface InterleavedContentProps {
    message: Message
    isUser: boolean
}

/**
 * 增量渲染：流式期间对齐浏览器绘制节奏（rAF）渲染，避免 200ms 节流带来的"逐块冒出"卡顿。
 * 流式过程 不 暴露原始 markdown 文本给用户——未渲染部分仅显示一个刷新的光标指示器。
 * 流结束后立即完整渲染。
 *
 * ★ 设计原则：
 *  用户不应看到原始 markdown 符号（**、`` ` `**、`|` 等），
 *  宁可让内容短暂跳跃，也不展示未解析的格式化文本。
 *
 * ★ 性能实现（rAF 帧级合并，替代原 setTimeout 200ms）：
 *   - 流式期间用 requestAnimationFrame 合并到下一帧渲染（约 16ms @60Hz），
 *     比固定 200ms 流畅 12 倍，且不会空转（IPC 间歇时帧内无新内容则跳过 setState）；
 *   - 空闲（非流式）时直接渲染最新内容，无延迟；
 *   - 卸载 / isStreaming 翻转时取消未执行的 rAF，避免内存泄漏与过期更新；
 *   - ref 跟踪 props 最新 content，避免 effect 内闭包陈旧导致漏更；
 *   - 标签页隐藏时冻结渲染（不提交 setState、零 markdown 解析），恢复可见时合并渲染最新内容一次。
 */
export function ThrottledMarkdown({content, isUser, theme}: {
    content: string; isUser: boolean; theme: ThemeName
}) {
    // ★ 修复：只订阅当前活跃会话的流式状态（原实现遍历全部会话，
    //   任一会话流式时，所有消息块的 ThrottledMarkdown 都会启动 rAF 循环，
    //   导致渲染进程 60fps 空转 × 块数，最终引发渲染异常/白边）。
    //   活跃会话无 conv 状态时回退全局 agentState（主会话/旧路径兼容）。
    const activeConversationId = useConversationStore((s) => s.activeConversationId)
    const isStreaming = useAgentStore((s) => {
        const convSt = activeConversationId
            ? s.convAgentStates[activeConversationId]?.agentState?.status
            : undefined
        if (convSt === 'thinking' || convSt === 'running') return true
        const globalSt = s.agentState.status
        return globalSt === 'thinking' || globalSt === 'running'
    })

    // 帧级合并的渲染内容：非流式立即同步，流式每帧最多提交一次最新 content
    const [displayContent, setDisplayContent] = useState(content)
    const contentRef = useRef(content)
    contentRef.current = content
    // ★ 内存修复：displayContent 的 ref 镜像。tick 在 rAF 回调闭包中运行，
    //   若读取组件闭包里的 displayContent 会因闭包陈旧而误判；
    //   ref 镜像保证读到「当前已提交」的值，用于「值不等才提交」判定。
    const displayContentRef = useRef(displayContent)
    displayContentRef.current = displayContent

    // 只在 isStreaming 翻转时重启 rAF 循环；content 变更通过 ref 自动跟随。
    // content 刻意不入依赖：rAF 回调通过 contentRef 读取最新值，避免流式期间每帧重挂 effect。
    useEffect(() => {
        // ★ 统一提交入口：**值形式** setState —— 函数式 updater 无法走 React
        //   的 eagerState 快路径（每次 dispatch 都会 enqueue update 对象，
        //   历史块 bail out 后 updateQueue 永不消费 → 运行期堆线性堆积，
        //   实测 +0.5~1MB/s，是渲染进程运行期增长的直接根因）。
        //   值形式 + 前置比对：等值时直接返回（React bail out，零 enqueue）。
        const syncLatest = () => {
            const latest = contentRef.current
            if (latest !== displayContentRef.current) {
                setDisplayContent(latest)
            }
        }

        // 空闲时同步提交最新内容，无需节流
        if (!isStreaming) {
            syncLatest()
            return
        }

        // rAF tick：每帧最多提交一次最新 content；等值时 bail out，避免空转 setState
        let frameId = 0
        const tick = () => {
            syncLatest()
            frameId = requestAnimationFrame(tick)
        }

        // ★ 隐藏冻结：hidden 时彻底停掉 rAF 且不提交（displayContent 保持快照，
        //   content 仍经 ref 累积）；visible 时只渲染最新一次并重启循环。
        //   避免隐藏期间 1Hz 反复解析 markdown 积压、恢复瞬间渲染风暴。
        const handleVisibility = () => {
            if (document.visibilityState === 'visible') {
                syncLatest()
                if (isStreaming) frameId = requestAnimationFrame(tick)
            } else {
                cancelAnimationFrame(frameId)
            }
        }

        // ★ 启动守卫：hidden 中不启动 rAF（isStreaming false→true 翻转重建 effect 时
        //   也不会在隐藏期间启动，避免 1Hz 持续解析 markdown 积压）。
        //   visible 由 handleVisibility 的 visible 分支负责启动；cancel(0) 是安全 no-op。
        frameId = document.hidden ? 0 : requestAnimationFrame(tick)
        document.addEventListener('visibilitychange', handleVisibility)

        return () => {
            cancelAnimationFrame(frameId)
            document.removeEventListener('visibilitychange', handleVisibility)
        }
    }, [isStreaming])

    return (
        // data-find-scope：正文搜索范围标记（MessageList.find 的 buildHighlights 只搜此标记内文本，
        // 避免命中 header/时间戳/工具卡片/聚合芯片等 UI 元信息）
        <div className="min-w-0" data-find-scope>
            <MarkdownRenderer isUser={isUser} theme={theme}>{displayContent}</MarkdownRenderer>
        </div>
    )
}

// ── 方案 B2：块级 memo 隔离 ──
// text 块：默认浅比较（content 字符串引用）——块级增量下未变化块引用不变 → bail out
const ThrottledMarkdownMemo = memo(ThrottledMarkdown)
// think 块：每次块级增量构建新 thinkBlock 对象，默认浅比较永不相等 → ★ 必须自定义 comparator
const ThinkBlockMemo = memo(ThinkBlock, (prev, next) =>
    prev.thinkBlock.content === next.thinkBlock.content
    && prev.thinkBlock.status === next.thinkBlock.status
)

/**
 * 交错内容组件
 */
export default function InterleavedContent({message, isUser}: InterleavedContentProps) {
    const theme = useThemeStore((s) => s.theme)
    const text = typeof message.content === 'string' ? message.content : ''
    const calls = message.toolCalls || []

    const displayMode = useAgentStore((s) => s.messageDisplayMode)
    // 构建展示片段（基础交错 + 极简模式聚合），与弹窗实时重推导共用同一纯函数
    const processedSegments = useMemo(
        () => buildDisplaySegments(message, isUltraCompactMode(displayMode)),
        [message, displayMode],
    )

    // Early return: 如果没有内容且没有 contentBlocks（含 think/tool_use 等非文本块）
    if (calls.length === 0 && !text && !message.contentBlocks?.length) return null
    // 防御性兜底：即使 contentBlocks 非空，但 segments 为空且无文本无工具调用 → 空白气泡，返回 null
    if (processedSegments.length === 0 && !text && calls.length === 0) return null

    const renderSegment = (seg: Segment, i: number) => {
        switch (seg.type) {
            case 'think-thread':
                // data-find-scope：think 内容属用户可见正文（展开时），纳入搜索范围
                return <div key={seg.blockId} className="mb-2" data-find-scope><ThinkBlockMemo thinkBlock={seg.thinkBlock}/></div>
            case 'text':
                return seg.content ?
                    <ThrottledMarkdownMemo key={`t-${i}`} content={seg.content} isUser={isUser} theme={theme}/> : null
            case 'media':
                return <div key={`media-${i}`} className="my-1"><MediaPlayer media={seg.mediaBlock}/></div>
            case 'tool-with-reason':
                return (
                    <div key={`tcwr-${seg.toolCall.id}`} className="mb-2 mt-2">
                        {/* data-find-scope：reason 是正文叙事的一部分（工具卡片的 arguments/result 不 scope） */}
                        <div
                            data-find-scope
                            className="text-[var(--text-secondary)] mb-2 italic bg-[var(--surface-muted)] p-2 rounded-lg border border-[var(--border)]">{seg.reason}</div>
                        <ToolCallRenderer toolCall={seg.toolCall}/>
                    </div>
                )
            case 'tool-group': {
                const isAgent = seg.toolCalls.length === 1 && seg.toolCalls[0].name === 'agent'
                const agentTc = isAgent ? seg.toolCalls[0] : null
                const isSkill = seg.toolCalls.length === 1 && isSkillToolCall(seg.toolCalls[0])
                const skillTc = isSkill ? seg.toolCalls[0] : null
                const skillDisplayName = skillTc ? resolveSkillDisplayName(skillTc) : null
                return (
                    <UltraCompactToolGroup
                        key={`tg-${i}`}
                        toolCalls={seg.toolCalls}
                        messageId={message.id}
                        isAgent={isAgent}
                        agentDisplayName={agentTc ? resolveAgentDisplayName(agentTc) : null}
                        agentTypeLabel={agentTc ? ((agentTc.arguments as any)?.agentType ?? null) : null}
                        isSkill={isSkill}
                        skillDisplayName={skillDisplayName}
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
