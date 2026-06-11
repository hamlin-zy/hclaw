/**
 * 图片处理工具
 *
 * 支持处理本地图片和网络图片，统一转换为 LLM 兼容的 base64 格式。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import {logger} from '../logger'

// 图片 MIME 类型映射（使用内置方式，不依赖外部库）
const MIME_TYPE_MAP: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
}

// 图片扩展名集合
const IMAGE_EXTENSIONS = new Set(Object.keys(MIME_TYPE_MAP))

/** 音频扩展名集合 */
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.amr', '.ogg', '.webm', '.flac', '.aac', '.silk'])

/**
 * 判断文件是否为图片
 */
export function isImageFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    return IMAGE_EXTENSIONS.has(ext)
}

/**
 * 判断文件是否为音频
 */
export function isAudioFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    return AUDIO_EXTENSIONS.has(ext)
}

/**
 * 获取图片的 MIME 类型
 */
export function getImageMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    return MIME_TYPE_MAP[ext] || 'image/jpeg'
}

/**
 * 将本地图片文件转换为 data URL（base64）
 * @param filePath 本地文件路径
 * @returns base64 data URL
 */
export async function localImageToBase64(filePath: string): Promise<string> {
    try {
        // 验证文件存在
        const ext = path.extname(filePath).toLowerCase()
        await fs.access(filePath)

        // 读取文件
        const buffer = await fs.readFile(filePath)
        const mimeType = getImageMimeType(filePath)
        const base64 = buffer.toString('base64')
        const dataUrl = `data:${mimeType};base64,${base64}`

        logger.info('localImageToBase64', { file: filePath, ext, mime: mimeType, fileSize: buffer.length, dataUrlLen: dataUrl.length })
        return dataUrl
    } catch (err: any) {
        logger.error('localImageToBase64', { file: filePath, error: err.message })
        throw new Error(`无法读取图片文件: ${err.message}`)
    }
}

/**
 * 检测 URL 是否为网络图片
 */
export function isNetworkImageUrl(url: string): boolean {
    if (!url) return false
    try {
        const parsed = new URL(url)
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    } catch {
        return false
    }
}

/**
 * 处理附件列表，返回多模态内容块
 *
 * @param attachments 附件列表
 * @param userText 用户输入的文本
 * @returns 包含文本和图片的多模态内容块
 */
export async function processAttachments(
    attachments: Array<{ path: string; name: string }>,
    userText: string
): Promise<{
    content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
    processedCount: number
    errors: string[]
}> {
    const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
    const errors: string[] = []
    let processedCount = 0

    // 添加用户文本
    if (userText) {
        content.push({type: 'text', text: userText})
    }

    // 处理图片附件
    if (attachments && attachments.length > 0) {
        for (const att of attachments) {
            try {
                if (isImageFile(att.path)) {
                    // 本地图片：读取并转换为 base64
                    const dataUrl = await localImageToBase64(att.path)
                    content.push({
                        type: 'image_url',
                        image_url: {url: dataUrl}
                    })
                    processedCount++
                                    } else if (isNetworkImageUrl(att.path)) {
                    // 网络图片：直接使用 URL
                    content.push({
                        type: 'image_url',
                        image_url: {url: att.path}
                    })
                    processedCount++
                                    } else {
                    // 非图片文件：跳过（已在消息中添加了文件路径信息）
                                    }
            } catch (err: any) {
                errors.push(`处理图片 ${att.name} 失败: ${err.message}`)
                            }
        }
    }

    return {content, processedCount, errors}
}

/**
 * 简化版本：仅返回图片 URL 列表（用于不需要 base64 的场景）
 */
export async function extractImageUrls(
    attachments: Array<{ path: string; name: string }>
): Promise<{
    images: Array<{ url: string; name: string }>
    skipped: Array<{ name: string; reason: string }>
}> {
    const images: Array<{ url: string; name: string }> = []
    const skipped: Array<{ name: string; reason: string }> = []

    for (const att of attachments) {
        if (isImageFile(att.path)) {
            try {
                const dataUrl = await localImageToBase64(att.path)
                images.push({url: dataUrl, name: att.name})
            } catch {
                skipped.push({name: att.name, reason: '无法读取文件'})
            }
        } else if (isNetworkImageUrl(att.path)) {
            images.push({url: att.path, name: att.name})
        } else {
            skipped.push({name: att.name, reason: '非图片格式'})
        }
    }

    return {images, skipped}
}
