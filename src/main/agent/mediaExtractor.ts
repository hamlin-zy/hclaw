/**
 * 媒体文件提取器
 *
 * 扫描工具执行结果中的本地文件路径和网络 URL，
 * 提取音频/图片/视频文件生成 MediaBlock，用于在消息中内联渲染。
 */

import type {ChatMessage} from './model/types'
import type {MediaBlock} from '@shared/types'
import {MEDIA_EXT_MAP} from '@shared/types'
import * as path from 'path'

// ─── 正则匹配模式 ─────────────────────────────────────

/** 匹配 Windows 路径: E:\path\to\file.mp3 */
const WIN_PATH_RE = /([a-zA-Z]:[\\/][^\s\]"',;<>]+\.(?:mp3|wav|flac|aac|ogg|m4a|wma|opus|jpg|jpeg|png|gif|webp|bmp|svg|avif|mp4|webm|avi|mov|mkv|wmv|flv))/gi

/** 匹配 Unix 路径: /path/to/file.mp3 */
const UNIX_PATH_RE = /(\/[^\s\]"',;<>]+\.(?:mp3|wav|flac|aac|ogg|m4a|wma|opus|jpg|jpeg|png|gif|webp|bmp|svg|avif|mp4|webm|avi|mov|mkv|wmv|flv))/gi

/** 匹配网络媒体 URL: https://...file.mp3 */
const URL_MEDIA_RE = /https?:\/\/[^\s\]"']+\.(?:mp3|wav|flac|aac|ogg|m4a|wma|opus|jpg|jpeg|png|gif|webp|bmp|svg|avif|mp4|webm|avi|mov|mkv|wmv|flv)(?:\?[^\s\]"']*)?/gi

/** Markdown 图片引用: ![alt](path) */
const MD_IMAGE_RE = /!\[.*?\]\(([^)]+)\)/g

/** Windows 反斜杠路径（Markdown 内） */
const WIN_BACKSLASH_IN_MD_RE = /(!\[.*?\]\()([a-zA-Z]:\\.*?)(\))/g

/**
 * 从任意输出中提取所有媒体文件路径和 URL
 * 支持文本行解析和 JSON 递归提取
 */
function extractMediaUrls(output: unknown): string[] {
    if (!output) return []
    const str = typeof output === 'string' ? output : JSON.stringify(output)
    const urls: string[] = []
    const seen = new Set<string>()

    // 尝试 JSON 解析后递归提取
    try {
        const obj = JSON.parse(str)
        collectPathsFromObject(obj, urls, seen)
    } catch {
        // 非 JSON，走文本行解析
    }

    // 文本解析：用三个正则匹配所有行
    for (const url of extractFromText(str)) {
        if (!seen.has(url)) {
            seen.add(url)
            urls.push(url)
        }
    }

    return urls
}

/** 从纯文本中提取媒体路径/URL（共三个正则） */
function* extractFromText(text: string): Generator<string> {
    const extractors = [
        (s: string) => matchAllGen(WIN_PATH_RE, s, 1),
        (s: string) => matchAllGen(UNIX_PATH_RE, s, 1),
        (s: string) => matchAllGen(URL_MEDIA_RE, s, 0),
    ]
    for (const extractor of extractors) {
        for (const url of extractor(text)) {
            yield url
        }
    }
}

/** matchAll 的 Generator 封装 */
function* matchAllGen(re: RegExp, text: string, groupIdx: number): Generator<string> {
    if (re.global) re.lastIndex = 0
    for (const m of text.matchAll(re)) {
        yield m[groupIdx]
    }
}

/** 递归从对象中提取文件路径 */
function collectPathsFromObject(obj: unknown, urls: string[], seen: Set<string>): void {
    if (!obj) return
    if (typeof obj === 'string') {
        for (const url of extractFromText(obj)) {
            if (!seen.has(url)) {
                seen.add(url);
                urls.push(url)
            }
        }
        return
    }
    if (Array.isArray(obj)) {
        for (const item of obj) collectPathsFromObject(item, urls, seen)
        return
    }
    if (typeof obj === 'object') {
        for (const val of Object.values(obj as Record<string, unknown>)) {
            collectPathsFromObject(val, urls, seen)
        }
    }
}

// ─── 对外 API ─────────────────────────────────────────

/**
 * 从工具调用结果中提取媒体文件信息
 */
export function extractMediaBlocksFromToolResults(messages: ChatMessage[]): MediaBlock[] {
    const blocks: MediaBlock[] = []
    const seen = new Set<string>()

    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role !== 'tool' || !msg.toolResult) continue

        for (const url of extractMediaUrls(msg.toolResult)) {
            if (seen.has(url)) continue
            seen.add(url)

            const cleanUrl = url.split('?')[0]
            const ext = path.extname(cleanUrl).toLowerCase().replace('.', '')
            const mediaType = MEDIA_EXT_MAP[ext]
            if (!mediaType) continue

            blocks.push({
                type: mediaType,
                url: url.replace(/\\/g, '/'),
                fileName: path.basename(cleanUrl),
            })
        }
    }

    return blocks
}

// ─── Markdown 路径修复 ────────────────────────────────

/**
 * 修复消息文本中 LLM 写出的相对路径 Markdown 图片引用。
 * 如 `![猫](oriental_beauty.png)` → `![猫](E:\output\oriental_beauty.png)`
 */
function fixRelativeMdImageRefs(text: string, mediaBlocks: MediaBlock[]): string {
    return text.replace(MD_IMAGE_RE, (fullMatch, rawPath: string) => {
        if (!rawPath) return fullMatch
        // 跳过已是绝对路径或协议的引用
        if (/^(https?|hclaw-media):\/\//.test(rawPath)) return fullMatch
        if (rawPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rawPath)) return fullMatch

        const fileName = path.basename(rawPath).replace(/[?].*$/, '')
        // 精确匹配优先，扩展名兜底
        const matched = mediaBlocks.find(mb => mb.fileName === fileName)
            ?? (fileName.includes('.')
                ? mediaBlocks.find(mb => path.extname(mb.fileName || mb.url).toLowerCase() === path.extname(fileName).toLowerCase())
                : undefined)

        return matched
            ? fullMatch.replace(`(${rawPath})`, `(${matched.url.replace(/\\/g, '/')})`)
            : fullMatch
    })
}

/**
 * 将 Markdown 图片路径中的 Windows 反斜杠转为正斜杠
 * `![](E:\path\to\file.png)` → `![](E:/path/to/file.png)`
 */
function fixBackslashInMdImages(text: string): string {
    return text.replace(WIN_BACKSLASH_IN_MD_RE, (_match, prefix, winPath, suffix) =>
        prefix + winPath.replace(/\\/g, '/') + suffix
    )
}

/**
 * 将提取到的媒体块附加到 ChatMessage 上
 */
export function attachMediaBlocksToMessage(
    message: ChatMessage,
    mediaBlocks: MediaBlock[],
): ChatMessage {
    if (mediaBlocks.length === 0) return message

    const mediaContentBlocks = mediaBlocks.map((mb, i) => ({
        id: `media_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 9)}`,
        type: 'media' as const,
        media: mb,
    }))

    let result: ChatMessage = {
        ...message,
        contentBlocks: [...(message.contentBlocks || []), ...mediaContentBlocks],
    }

    const content = typeof message.content === 'string' ? message.content : ''
    if (!content) return result

    const fixed = fixBackslashInMdImages(fixRelativeMdImageRefs(content, mediaBlocks))
    if (fixed !== content) {
        result = {...result, content: fixed}
    }

    return result
}
