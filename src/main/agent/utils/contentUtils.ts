/**
 * 内容处理工具函数
 */

import type {ContentPart} from '../model/types'

/**
 * 获取消息内容的前缀摘要（用于日志输出）
 * 非文本内容（如图片）返回 '(non-text)'
 */
export function getMessagePreview(msg: { content?: string | ContentPart[] }, maxLen = 60): string {
    return typeof msg.content === 'string' ? msg.content.slice(0, maxLen) : '(non-text)'
}

/**
 * 从消息内容中提取纯文本
 * 支持多模态内容块数组
 */
export function extractTextContent(content: string | ContentPart[]): string {
    if (typeof content === 'string') {
        return content
    }
    return content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map(part => part.text)
        .join(' ')
}
