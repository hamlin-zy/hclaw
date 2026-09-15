/**
 * ToolCallResult — 工具调用结果展示组件
 *
 * 展示工具执行的输出结果，支持文本输出和音频预览
 */

import {truncate} from '../../lib/format'
import AudioPreviewPlayer from './AudioPreviewPlayer'
import MarkdownRenderer from './MarkdownRenderer'

interface ToolCallResultProps {
    /** 输出文本 */
    output: string
    /** 工具调用名称（用于定制标签文字） */
    toolCallName?: string
}

/**
 * 结果展示组件
 */
export default function ToolCallResult({output, toolCallName}: ToolCallResultProps) {
    if (!output) return null

    return (
        <div>
            <span data-find-exclude className="text-[10px] text-[var(--text-secondary)] uppercase tracking-wide">
                {toolCallName === 'file_edit' ? '执行结果' : '输出'}
            </span>
            <div
                className="text-[11px] text-[var(--text-secondary)] max-h-64 overflow-y-auto p-2 mt-1 bg-[var(--success-muted)] border border-[rgba(16,185,129,0.1)] rounded-md">
                <MarkdownRenderer>{toolCallName === 'agent' ? output : truncate(output, 4000)}</MarkdownRenderer>
            </div>
            {/* 音频预览播放器（当输出包含音频 URL 时显示） */}
            {isAudioOutput(output) && (
                <AudioPreviewPlayer
                    url={extractAudioUrl(output)}
                    fileName={extractFileName(output)}
                />
            )}
        </div>
    )
}

// ========================================
// 音频预览辅助函数
// ========================================

/** 判断输出内容是否为音频 URL */
function isAudioOutput(output: string): boolean {
    const audioExtensions = ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma']
    const lowerOutput = output.toLowerCase()

    // 检查是否包含音频扩展名（涵盖常见 CDN 直链）
    if (audioExtensions.some((ext) => lowerOutput.includes(ext))) return true

    // 检查是否包含 Success. Audio URLs 或类似的成功标记
    return /Success.*Audio/i.test(output) || /Audio.*URL/i.test(output)
}

/** 从输出中提取音频 URL */
function extractAudioUrl(output: string): string {
    if (!output) return ''

    // 尝试匹配常见的 URL 格式
    const urlPatterns = [
        // http/https URLs（包括查询参数）
        /https?:\/\/[^\s\]"']+\.(?:mp3|wav|flac|aac|ogg|m4a)(?:\?[^\s\]"']*)?/gi,
        // 直接以 http 开头的内容
        /^https?:\/\/.+$/gm,
    ]

    for (const pattern of urlPatterns) {
        const matches = output.match(pattern)
        if (matches && matches.length > 0) {
            // 返回第一个匹配的 URL
            return matches[0].trim()
        }
    }

    return ''
}

/** 从输出中提取文件名 */
function extractFileName(output: string): string {
    const url = extractAudioUrl(output)
    if (!url) return 'Audio'

    // 从 URL 中提取文件名，并移除查询参数
    const lastPart = url.split('/').pop() ?? ''
    return lastPart.split('?')[0] || 'Audio'
}
