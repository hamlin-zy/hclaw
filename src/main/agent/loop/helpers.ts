/**
 * Agent 循环控制器 — 工具函数
 *
 * 从 controller.ts 提取的纯函数，无副作用，不依赖类实例。
 */

import type {ChatMessage, ContentPart} from '../model/types'
import type {ModelRole} from '@shared/types'
import {MODEL_ROLE_INFO} from '@shared/modelSchemeHelpers'
import {ATTACHMENT_IMAGE_PATH_PREFIX} from '../utils/imagePathMarkers'

// ─── Constants ─────────────────────────────────────────────

/** 已知支持图片的视觉模型名模式 */
export const VISION_MODEL_PATTERNS: RegExp[] = [
    /^gpt-4[o.]|^gpt-4-turbo/i, // GPT-4 Omni / 4.5 / Turbo
    /^o\d+/i,                   // OpenAI o 系列推理模型
    /^claude-3/i,               // Claude 3 系列
    /^gemini-/i,                // Gemini 系列
    /llava|bakllava|moondream|gemma3|minicpm|cogvlm|internvl/i,
    /qwen.*vl|deepseek.*vl|glm-4v|step-1v|yi-vision/i,
    /-vision|-vl$|-vlm/i,       // 通用视觉后缀
]

// ─── 视觉模型检测 ──────────────────────────────────────────

export function isVisionModel(modelName: string): boolean {
    return VISION_MODEL_PATTERNS.some(p => p.test(modelName.toLowerCase()))
}

// ─── 消息清理 ──────────────────────────────────────────────

/**
 * 过滤非视觉模型消息中的多模态内容块（image_url / input_audio）
 * 仅用于非视觉模型调用前清理历史消息中的图片残留。
 */
export function sanitizeMessagesForModel(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(msg => {
        if (typeof msg.content === 'string' || !Array.isArray(msg.content)) return msg
        const filtered = msg.content.filter(p => p.type !== 'image_url' && p.type !== 'input_audio')
        if (filtered.length === msg.content.length) return msg
        return {
            ...msg,
            content: filtered.length > 0
                ? filtered
                : '[该消息原包含图片/音频，当前模型不支持多模态内容，已自动过滤]',
        }
    })
}

/**
 * 剥离消息文本中的附件图片路径标注（仅 role='user' 消息、仅【附件图片路径】行）。
 *
 * 请求期纯派生：视觉模型下图片已随消息以 image_url 块直接可见，路径标注是纯噪声，
 * 且会命中 load_image 的工具描述触发条件 → 诱导对已可见图片重复加载（其结果再被派生成
 * 合成 user 消息、二次注入同一张图）。故发送前剥掉。
 *
 * 只剥附件标记，绝不触碰 LOAD_IMAGE_SNAPSHOT_PATH_PREFIX（【图片文件路径】，load_image 快照标记）：
 * 降级/非视觉模型下 image_url 被 sanitize 剥离后，analyze_image 仍需该路径回退。
 *
 * 只处理 role==='user'：附件标记仅由 startAgentCore / userContentBuilder 两个 user 消息构建器
 * 产出。若不限角色，assistant 输出或 tool 结果里恰好出现的同一字面量（例如 file_read 读到一份
 * 含该字符串的文档）会被静默删除——那是用户数据，不是我们的标注。
 *
 * - 纯函数：输入不被修改；无变更时返回原数组引用（幂等；调用方无需判断，测试可断言 toBe）
 * - 只处理数组 content；字符串 content 一律原样返回（非图片附件的 [附件] 描述走其他路径）
 * - 剥离后变空且该消息还有其他 part → 丢弃空 part
 * - 兜底：剥离后 content 数组为空，或只剩一个空 text part（空 text 块会被部分 adapter 拒绝）
 *   → 保留原消息不替换
 *
 * ★ 为何此处不能用「长度比较」早退（勿与 sanitizeMessagesForModel 合并成一种写法）：
 *   本函数的变更只改 part 的**内容**、不改 part 数量（除了丢弃空 part 这一例外），
 *   长度比较会漏判绝大多数命中，故必须逐 part 用 `kept === p.text` 判断；
 *   而 sanitizeMessagesForModel 过滤 image_url/input_audio，命中必然改变 part 数量，
 *   它的长度比较是对的。两者判据不同源于变更性质不同，不是重复代码。
 */
export function stripAttachmentImagePaths(messages: ChatMessage[]): ChatMessage[] {
    let changed = false
    const result = messages.map(msg => {
        if (msg.role !== 'user') return msg
        if (typeof msg.content === 'string' || !Array.isArray(msg.content)) return msg
        const parts: ContentPart[] = []
        let msgChanged = false
        for (const p of msg.content) {
            if (p.type !== 'text') {
                parts.push(p)
                continue
            }
            const kept = p.text
                .split('\n')
                .filter(line => !line.startsWith(ATTACHMENT_IMAGE_PATH_PREFIX))
                .join('\n')
            if (kept === p.text) {
                parts.push(p)
                continue
            }
            msgChanged = true
            // 剥离后变空且该消息还有其他 part → 丢弃该空 part
            if (kept === '' && msg.content.length > 1) continue
            parts.push({...p, text: kept})
        }
        if (!msgChanged) return msg
        // 兜底：整体变空 / 只剩一个空 text part → 保留原消息（空 text 块部分 adapter 会拒绝）
        if (parts.length === 0) return msg
        if (parts.length === 1 && parts[0].type === 'text' && parts[0].text === '') return msg
        changed = true
        return {...msg, content: parts}
    })
    return changed ? result : messages
}

/**
 * 过滤消息中的 thinking 内容（非推理模型调用前使用）
 *
 * 当从推理模型（thinking mode）切换到非推理模型时，历史消息中的
 * assistant 消息可能残留 thinking/thinkingSignature 字段。
 * Anthropic API 要求在未启用 thinking mode 时，消息中不得出现 thinking 块。
 * 此函数清理这些字段，避免 API 报错。
 */
export function sanitizeThinkingForModel(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(msg => {
        if (msg.role !== 'assistant') return msg
        if (!msg.thinking && !msg.thinkingSignature) return msg
        return {
            ...msg,
            thinking: undefined,
            thinkingSignature: undefined,
        }
    })
}

// ─── 角色显示名 ────────────────────────────────────────────

/**
 * 从 MODEL_ROLE_INFO 获取角色显示名（displayName 固定，无需遍历 scheme）
 */
export function getRoleDisplayName(role: string): string {
    return MODEL_ROLE_INFO[role as ModelRole]?.name || role
}

// ─── GC 清理 ───────────────────────────────────────────────

/**
 * 轮次收尾清理：主动断开大对象引用 + 通知 V8 回收
 */
export function endTurnCleanup(): void {
    try {
        if (typeof (globalThis as any).gc === 'function') {
            ;(globalThis as any).gc()
        }
    } catch {
        // GC 不可用或调用失败，静默跳过
    }
}
