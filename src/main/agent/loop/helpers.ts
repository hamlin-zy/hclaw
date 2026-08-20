/**
 * Agent 循环控制器 — 工具函数
 *
 * 从 controller.ts 提取的纯函数，无副作用，不依赖类实例。
 */

import type {ChatMessage} from '../model/types'
import type {ModelRole} from '@shared/types'
import {MODEL_ROLE_INFO} from '@shared/modelSchemeHelpers'

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
