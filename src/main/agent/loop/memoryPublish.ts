/**
 * 用户习惯记忆 pre-step（追加式，spec §3）
 *
 * 在 agent 主循环每轮"构建系统提示词"之前调用：
 * - loadMemory 加载 mem/SKILL.md、用户偏好、项目记忆并计算 digest
 * - 仅在 digest 变化（或尚未发布）时追加一条新的 user 角色记忆消息
 * - 持久化走 conversationRepository.writeMessagesDelta（与 catalogPublish 相同模式）
 *
 * MemoryState 仅做 digest 门控与崩溃恢复；消息追加后不再改动。
 * 整个 pre-step 包裹在 try-catch 内：记忆注入失败绝不阻断主循环。
 */

import {randomUUID} from 'crypto'
import type {ChatMessage, LoopState} from '../state'
import {addMessage} from '../state'
import type {IConversationRepository} from '../../repositories/interfaces'
import type {Message} from '@shared/types'
import {MEMORY_SOURCE_KIND, MEMORY_DIGEST_KEY} from '@shared/types/memory'
import type {MemoryState} from '@shared/types/memory'
import {loadMemory, computeMemoryDigest} from '../memory'
import {logger} from '../logger'

export type {MemoryState}

/**
 * 从会话消息流还原：倒序取最后一条 memory 消息的 digest（崩溃恢复续用门控）。
 */
export function restoreMemoryState(messages: ReadonlyArray<ChatMessage>): MemoryState {
    for (let i = messages.length - 1; i >= 0; i--) {
        const meta = messages[i].metadata as Record<string, unknown> | undefined
        if (meta?.sourceKind !== MEMORY_SOURCE_KIND) continue
        const digest = meta[MEMORY_DIGEST_KEY]
        return {lastMemoryDigest: typeof digest === 'string' ? digest : null}
    }
    return {lastMemoryDigest: null}
}

/**
 * 执行记忆 pre-step。
 *
 * @param options.hclawDir HClaw 配置目录
 * @param options.workspacePath 会话工作目录（workspacePath）
 * @param options.memoryEnabled 用户习惯记忆功能总开关
 * @param options.channel 渠道标识；schedule 会话（系统定时任务）不注入记忆
 * @returns 更新后的 LoopState 与 MemoryState（无变化时原样返回入参引用）
 */
export function runMemoryPreStep(
    currentState: LoopState,
    memoryState: MemoryState,
    conversationRepo: IConversationRepository | null,
    sessionId: string | undefined,
    options: {
        hclawDir: string
        workspacePath: string | null
        memoryEnabled: boolean
        channel?: string
    },
): {state: LoopState; memoryState: MemoryState} {
    const {hclawDir, workspacePath, memoryEnabled, channel} = options
    let state = currentState
    const ms: MemoryState = {...memoryState}

    try {
        if (!memoryEnabled) return {state, memoryState: ms}
        if (channel === 'schedule') return {state, memoryState: ms}

        const content = loadMemory(hclawDir, workspacePath)
        if (!content) return {state, memoryState: ms}

        const digest = computeMemoryDigest(content)
        if (digest === ms.lastMemoryDigest) return {state, memoryState: ms}

        const text = buildMemoryMessageText(content)
        if (!text) return {state, memoryState: ms}

        const created: ChatMessage = {
            id: randomUUID(),
            role: 'user',
            content: text,
            metadata: {
                sourceKind: MEMORY_SOURCE_KIND,
                [MEMORY_DIGEST_KEY]: digest,
            } as Record<string, unknown>,
        }
        state = addMessage(state, created)
        persist(conversationRepo, sessionId, created)
        ms.lastMemoryDigest = digest

        logger.info('[AgentLoop] memory pre-step published', {
            messageId: created.id!.slice(0, 8),
        })
        return {state, memoryState: ms}
    } catch (err) {
        // 记忆注入失败不阻断主循环
        logger.debug('[AgentLoop] memory pre-step skipped', {error: String(err)})
        return {state, memoryState: ms}
    }
}

/** 拼装记忆注入消息文本；无任何内容时返回 null */
function buildMemoryMessageText(content: {
    skillMd: string | null
    preferencesMd: string | null
    projectMemoryMd: string | null
    projectName: string | null
}): string | null {
    const sections: string[] = []
    if (content.skillMd) sections.push(content.skillMd)
    if (content.preferencesMd) sections.push(`## 用户偏好\n\n${content.preferencesMd}`)
    if (content.projectMemoryMd) {
        sections.push(`## 项目记忆（${content.projectName ?? 'unknown'}）\n\n${content.projectMemoryMd}`)
    }
    if (sections.length === 0) return null
    return `<system-reminder>\n# 用户习惯记忆\n\n${sections.join('\n\n---\n\n')}\n</system-reminder>`
}

/** 落库（sessionId 空时仅内存态） */
function persist(
    conversationRepo: IConversationRepository | null,
    sessionId: string | undefined,
    message: ChatMessage,
): void {
    if (!conversationRepo || !sessionId) {
        logger.debug('[AgentLoop] no session, memory message kept in memory only')
        return
    }
    try {
        // ChatMessage 无 timestamp 字段；落库 Message 需要，此处补齐
        conversationRepo.writeMessagesDelta(sessionId, {...message, timestamp: Date.now()} as unknown as Message)
    } catch (err) {
        logger.debug('[AgentLoop] memory message persist failed', {error: String(err)})
    }
}
