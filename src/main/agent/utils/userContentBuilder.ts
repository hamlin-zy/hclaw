/**
 * user 消息附件 → LLM content 构建器（共享）
 *
 * 两条链路必须共用本模块，保证输出逐字节一致（跨 turn KV cache 前缀稳定）：
 * - session_handoff 首轮：工具构建首条 user 消息 content（session_handoff_start → AgentManager.start）
 * - agent-start 历史重建：从 DB 读回 user 消息（content + metadata.attachments）后重建 content
 *
 * 语义与 execution.ts 历史 user 消息重建分支一致：
 * - 图片（本地/网络）：文本追加【图片文件路径】标记（供非视觉模型 analyze_image 使用），
 *   本地图片转 base64 image_url 块，网络图片直接用 URL；读取失败回退文本描述
 * - 非图片附件：文本 + '\n\n' + `[附件]\n文件: ...\n路径: ...` 描述
 */

import * as fs from 'fs/promises'
import crypto from 'crypto'
import {isImageFile, isNetworkImageUrl} from './imageProcessor'

type ContentPart = {type: 'text'; text: string} | {type: 'image_url'; image_url: {url: string}}

/** 附件可能是 {path} 对象，也可能是裸路径字符串（历史数据兼容） */
function attPath(att: {path?: string} | string): string {
    return typeof att === 'string' ? att : att.path || ''
}

const MIME_BY_EXT: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
}

function extToMime(p: string): string {
    const ext = p.split('.').pop()?.toLowerCase() || 'png'
    return MIME_BY_EXT[ext] || 'image/png'
}

/**
 * 构建带附件的 user 消息 LLM content。
 * 与 execution.ts 历史重建分支同源：相同输入（文本 + 附件列表）→ 相同输出。
 */
export async function buildUserHistoryContent(
    text: string,
    attachments: Array<{path?: string; name?: string}>,
): Promise<string | ContentPart[]> {
    if (!attachments || attachments.length === 0) return text

    const imgAttachments = attachments.filter(att =>
        isImageFile(attPath(att)) || isNetworkImageUrl(attPath(att)),
    )

    if (imgAttachments.length === 0) {
        // 非图片附件，添加文本描述
        const otherDesc = attachments.map(att => {
            const path = attPath(att)
            const attName = att.name || path.split('/').pop() || path.split('\\').pop() || path
            return `[附件]\n文件: ${attName}\n路径: ${path}`
        }).join('\n')
        return (text || '') + '\n\n' + otherDesc
    }

    // 将图片路径加入文本，确保非视觉模型也能通过 analyze_image 工具分析图片
    const textParts: string[] = [text || '']
    const imgParts: ContentPart[] = []
    for (const img of imgAttachments) {
        const imgPath = attPath(img)
        if (isNetworkImageUrl(imgPath)) {
            imgParts.push({type: 'image_url', image_url: {url: imgPath}})
        } else {
            try {
                const imgBuffer = await fs.readFile(imgPath)
                const mime = extToMime(imgPath)
                const dataUri = `data:${mime};base64,${imgBuffer.toString('base64')}`
                imgParts.push({type: 'image_url', image_url: {url: dataUri}})
            } catch {
                // 图片读取失败，使用文本描述代替
                textParts.push(`\n[图片: ${imgPath}]`)
            }
        }
    }
    const histImgPaths = imgAttachments.map(att =>
        `\n【图片文件路径】${attPath(att)}`,
    ).join('')
    textParts.push(histImgPaths)
    return [{type: 'text', text: textParts.join('')}, ...imgParts]
}

/**
 * 命令模板 → <command-task> 尾随消息 content。
 * 两条链路必须共用本函数，保证输出逐字节一致（跨 turn KV cache 前缀稳定）：
 * - 命令轮首轮：loop/execute.ts 在当轮每次 LLM 调用末尾注入
 * - 后续轮：ipc/execution.ts 从 DB 重建历史时，对带 metadata.commandTemplate
 *   的 user 消息重放同一条尾随消息（首轮注入不落库，缺失会导致第二轮请求
 *   前缀在命令 user 消息后立即分叉 → cached_tokens 归零）
 */
export function buildCommandTaskContent(template: string): string {
    return `<command-task>\n${template}\n</command-task>`
}

/** DB 读回的 user 消息行（execution.ts 历史重建输入，metadata 已含命令/附件等） */
export interface HistoryUserRow {
    id?: string
    role: string
    content?: unknown
    attachments?: Array<{ path?: string; name?: string }>
    messageAttachments?: Array<{ path?: string; name?: string }>
    metadata?: Record<string, unknown> | null
    /** ★ DB 读回约定：metadata 展开到消息顶层，commandTemplate 实际在此 */
    commandTemplate?: unknown
    /** catalog 恢复字段（DB 读回约定：展开到消息顶层） */
    sourceKind?: unknown
    catalogDigest?: unknown
    catalogEntries?: unknown
    catalogSuperseded?: unknown
}

/** 重建后的 user 消息（含可选的命令尾随重放消息） */
export interface RebuiltUserMessage {
    role: 'user'
    content: string | ContentPart[]
    id: string
    metadata?: Record<string, unknown>
}

/**
 * DB user 消息行 → LLM 历史消息（可能 2 条：本体 + 命令尾随重放）。
 *
 * 唯一重建入口：ipc/execution.ts 历史重建调用。回归测试锁定其输出与
 * loop/execute.ts 首轮注入序列逐字节一致（跨 turn KV cache 前缀稳定）。
 */
export async function convertUserHistoryMessage(msg: HistoryUserRow): Promise<RebuiltUserMessage[]> {
    const attachments = (msg.attachments || msg.messageAttachments) as Array<{ path?: string; name?: string }> | undefined
    let userContent: RebuiltUserMessage['content'] = (msg.content as string) || ''

    if (attachments && attachments.length > 0) {
        userContent = await buildUserHistoryContent((msg.content as string) || '', attachments)
    }

    // ★ DB 读回约定：metadata 展开到消息顶层（buildMessagesFromRows）。
    //   白名单收拢回 metadata，否则 restoreCatalogState 扫不到
    //   sourceKind/catalogDigest → 崩溃/重启恢复后重复发布第二条 catalog。
    const histMetadata: Record<string, unknown> = {
        ...(msg.metadata || {}),
        ...(msg.sourceKind !== undefined ? {sourceKind: msg.sourceKind} : {}),
        ...(msg.catalogDigest !== undefined ? {catalogDigest: msg.catalogDigest} : {}),
        ...(msg.catalogEntries !== undefined ? {catalogEntries: msg.catalogEntries} : {}),
        ...(msg.catalogSuperseded !== undefined ? {catalogSuperseded: msg.catalogSuperseded} : {}),
    }

    const result: RebuiltUserMessage[] = [{
        role: 'user',
        content: userContent,
        id: msg.id || `msg-${Date.now()}`,
        ...(Object.keys(histMetadata).length > 0 ? {metadata: histMetadata} : {}),
    }]

    // ★ 命令模板尾随消息重放（KV cache 修复）：命令轮首轮在 LLM 调用时
    //   注入 <command-task> 尾随 user 消息但不落库，历史重建若不补上，
    //   下一轮请求前缀会在该命令 user 消息后立即分叉 → cached_tokens 归零。
    //   content 构建与 loop/execute.ts 首轮注入共用同一函数，逐字节一致。
    // ★ DB 读回约定：metadata 展开到消息顶层（buildMessagesFromRows `...metadata`），
    //   commandTemplate 实际在消息顶层；兼容读取 metadata 字段以防读回约定变化。
    const commandTemplate = msg.commandTemplate ?? histMetadata.commandTemplate
    if (typeof commandTemplate === 'string' && commandTemplate.length > 0) {
        result.push({
            role: 'user',
            content: buildCommandTaskContent(commandTemplate),
            id: `cmd-replay-${msg.id || Date.now()}`,
        })
    }

    return result
}

/** 规范化输入消息的最小结构（role + 可选 id/metadata） */
interface NormalizableMessage {
    role: string
    id?: string
    metadata?: Record<string, unknown> | null
    sourceKind?: unknown
}

function isCatalogMessage(m: NormalizableMessage): boolean {
    return m.metadata?.sourceKind === 'capability-catalog' || m.sourceKind === 'capability-catalog'
}

function isCommandReplayMessage(m: NormalizableMessage): boolean {
    return typeof m.id === 'string' && m.id.startsWith('cmd-replay-')
}

/**
 * 历史重建消息顺序规范化（KV cache 前缀一致性）。
 *
 * DB 行时间戳无法还原两类"调用时合成/晚落库"消息在首轮请求中的真实位置：
 * - catalog 消息：loop pre-step 追加到内存末尾（紧随当轮 user），但 assistant 占位行
 *   创建于 loop 启动（时间戳更早）→ DB 排序后 catalog 落到 assistant 之后
 * - cmd 重放消息：首轮在每次 LLM 调用时尾随注入（★ 始终位于当轮消息列表末尾：
 *   execute.ts 构建 effectiveMessages = [...state, cmdTask]，轮内消息不断增长，
 *   故首轮最后一个请求——即 provider 实际缓存的前缀——中 cmdTask 在全部
 *   assistant/tool 之后、下一轮 user 之前）
 *
 * 本函数将两类消息重定位到与首轮最后请求（缓存前缀）一致的位置：
 * - catalog → 紧跟其锚点 user（数组顺序中最近的前驱 user）之后
 * - cmd 重放 → 命令轮段末尾，即「下一个 user 消息之前」（无后续 user 则数组末尾）。
 *   该位置同时是后续轮请求中的真实位置（in-loop 状态在次轮起点固化后不再移动），
 *   因此第二轮起的重建同样逐字节对齐。
 */
export function normalizeHistoryMessageOrder<T extends NormalizableMessage>(messages: T[]): T[] {
    // Pass 1：摘出 catalog 与 cmd 重放，记录锚点 user（数组顺序中最近的前驱 user）
    const catalogsByAnchor = new Map<NormalizableMessage, T[]>()
    const replayByAnchor = new Map<NormalizableMessage, T>()
    const rest: T[] = []
    let lastUser: NormalizableMessage | undefined
    for (const m of messages) {
        if (isCatalogMessage(m)) {
            if (lastUser) {
                const list = catalogsByAnchor.get(lastUser) ?? []
                list.push(m)
                catalogsByAnchor.set(lastUser, list)
            } else {
                rest.push(m) // 无锚点（异常态），保持原位
            }
            continue
        }
        if (isCommandReplayMessage(m)) {
            if (lastUser && !replayByAnchor.has(lastUser)) {
                replayByAnchor.set(lastUser, m)
            } else {
                rest.push(m)
            }
            continue
        }
        if (m.role === 'user') lastUser = m
        rest.push(m)
    }

    // Pass 2：user 后输出 [锚点 catalogs...]；cmd 重放挂起到「下一个 user 之前」再输出
    //（= 命令轮 assistant/tool 全部之后，与首轮最后请求的尾随注入位置一致）
    const result: T[] = []
    let pendingReplay: T | undefined
    for (const m of rest) {
        if (m.role !== 'user') {
            result.push(m)
            continue
        }
        // 到达下一个 user：先输出挂起的上一命令轮重放（= 命令轮段末尾）
        if (pendingReplay) {
            result.push(pendingReplay)
            pendingReplay = undefined
        }
        result.push(m)
        for (const c of catalogsByAnchor.get(m) ?? []) result.push(c)
        // 本 user 若是命令锚点：重放挂起，延迟到下一个 user 之前（或末尾）输出
        const replay = replayByAnchor.get(m)
        if (replay) pendingReplay = replay
    }
    // 无后续 user 的重放（命令轮是历史末尾，次轮起点场景）：补到末尾
    if (pendingReplay) result.push(pendingReplay)
    return result
}

/**
 * 渠道/工具附件 → Message Attachment 结构（AttachmentPreview 渲染兼容）。
 * 与 messageHandler.toMessageAttachments 同构，此处为共享版本。
 */
export function toMessageAttachments(atts: Array<{path: string; name: string; mimeType?: string}>): Array<{
    id: string; name: string; type: string; size: number; path: string; isImage: boolean
}> {
    const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.svg'])
    return atts.map(a => {
        const ext = a.path ? `.${a.path.split('.').pop()?.toLowerCase()}` : ''
        return {
            id: crypto.randomUUID(),
            name: a.name,
            type: a.mimeType || '',
            size: 0,
            path: a.path,
            isImage: IMAGE_EXTENSIONS.has(ext),
        }
    })
}
