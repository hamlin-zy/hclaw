/**
 * Agent 循环控制器 — 工具函数
 *
 * 从 controller.ts 提取的纯函数，无副作用，不依赖类实例。
 */

import type {ChatMessage} from '../model/types'
import type {IntentAnalysisResult} from '@shared/types'
import type {ModelRole} from '@shared/types'

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

// ─── 角色显示名 ────────────────────────────────────────────

/**
 * 从方案中按角色名查找 displayName
 */
export function getRoleDisplayName(
    scheme: { roles: Array<{ role: string; displayName?: string }> } | null | undefined,
    role: string,
): string {
    return scheme?.roles?.find(r => r.role === role)?.displayName || role
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

// ─── 意图分析 ──────────────────────────────────────────────

export function createDefaultResult(text: string): IntentAnalysisResult {
    const msg = text.toLowerCase()
    const messageLength = text.length

    const isComplex = /重构|架构|设计|实现|优化|迁移|升级|refactor|architect|implement|optimize|migrate|upgrade/i.test(msg)
    const isExploration = /查看|列出|搜索|查找|读取|分析|理解|探索|结构|describe|list|find|search|show|explain/i.test(msg)

    const complexity: 'simple' | 'moderate' | 'complex' =
        isComplex || messageLength > 400 ? 'complex'
        : isExploration && messageLength < 150 ? 'simple'
        : messageLength > 100 ? 'moderate'
        : 'simple'

    let estimatedSteps = 1
    if (complexity === 'complex') estimatedSteps = 5
    else if (complexity === 'moderate') estimatedSteps = 3

    let suggestedModel: ModelRole = 'primary'
    if (complexity === 'simple' || (isExploration && complexity !== 'complex')) {
        suggestedModel = 'lightweight'
    } else if (complexity === 'complex') {
        suggestedModel = 'reasoning'
    }

    return {
        summary: text.slice(0, 200),
        complexity,
        estimatedSteps,
        needsPlanning: complexity === 'complex',
        suggestedModel,
    }
}

// ─── Token 格式化 ──────────────────────────────────────────

export function formatTokenCount(tokens: number): string {
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`
    }
    return `${tokens}`
}
