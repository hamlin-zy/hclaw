/**
 * 能力目录 pre-step（追加式，spec §3.1）
 *
 * 在 agent 主循环每轮"构建系统提示词"之前调用：
 * - 收集当前启用的能力条目并计算 digest
 * - 仅在 digest 变化（或尚未发布）时追加一条新的 user 角色 catalog 消息；
 *   旧 catalog 消息内容字节不动（LLM 按消息序以最后一条为准）
 * - 持久化走 conversationRepository.writeMessagesDelta（追加新行，单事务）
 *
 * 不再维护消息位置：无原地替换（update-by-id）、无 tombstone
 * （catalogSuperseded）机制；CatalogState 仅做 digest 门控与崩溃恢复。
 */

import {randomUUID} from 'crypto'
import type {ChatMessage, LoopState} from '../state'
import {addMessage} from '../state'
import type {IConversationRepository} from '../../repositories/interfaces'
import type {Message} from '@shared/types'
import {SOURCE_KIND_CATALOG} from '@shared/types/message'
import {collectCatalogSnapshot, decidePublish} from '../skills/catalogInjector'
import {logger} from '../logger'

/** 目录发布跨轮状态（追加式：仅 digest 门控，无消息位置管理，spec §3.1） */
export interface CatalogState {
    /** 上次发布的 digest */
    lastDigest?: string
    /** 连续残缺快照计数（完整性门控，spec §5.2） */
    incompleteStreak: number
}

/** 从会话消息流还原：倒序取最后一条 catalog 消息的 digest（仅为崩溃恢复续用门控） */
export function restoreCatalogState(messages: ReadonlyArray<ChatMessage>): CatalogState {
    for (let i = messages.length - 1; i >= 0; i--) {
        const meta = messages[i].metadata as Record<string, unknown> | undefined
        if (meta?.sourceKind === SOURCE_KIND_CATALOG) {
            return {lastDigest: meta.catalogDigest as string | undefined, incompleteStreak: 0}
        }
    }
    return {incompleteStreak: 0}
}

/**
 * 执行目录 pre-step。
 * @returns 更新后的 LoopState 与 CatalogState（无变化时原样返回入参引用）
 */
export function runCatalogPreStep(
    currentState: LoopState,
    catalogState: CatalogState,
    conversationRepo: IConversationRepository | null,
    sessionId: string | undefined,
    fullDescriptions: boolean,
): {state: LoopState; catalogState: CatalogState} {
    let state = currentState
    const cs: CatalogState = {...catalogState, incompleteStreak: catalogState.incompleteStreak ?? 0}

    try {
        const snapshot = collectCatalogSnapshot()
        const mode = fullDescriptions ? 'full' : 'names'
        const {decision, nextIncompleteStreak} = decidePublish(
            snapshot, mode, cs.lastDigest, !!cs.lastDigest, cs.incompleteStreak,
        )
        cs.incompleteStreak = nextIncompleteStreak
        if (decision.action === 'none') return {state, catalogState: cs}

        const meta = decision.metadata!
        const content = decision.content!
        const metaRecord = {...meta} as Record<string, unknown>

        // 追加式发布：始终产生新消息（旧消息内容字节不动）
        const created = makeCatalogMessage(randomUUID(), content, metaRecord)
        state = addMessage(state, created)
        persist(conversationRepo, sessionId, created)
        cs.lastDigest = (meta as {catalogDigest: string}).catalogDigest
        logger.info('[AgentLoop] capability catalog published', {messageId: (created.id ?? '').slice(0, 8)})
        return {state, catalogState: cs}
    } catch (err) {
        // 目录注入失败不阻断主循环
        logger.debug('[AgentLoop] capability catalog pre-step skipped', {error: String(err)})
        return {state, catalogState: cs}
    }
}

/** 构造 catalog 注入的 user 角色消息 */
function makeCatalogMessage(
    id: string,
    content: string,
    metadata: Record<string, unknown>,
): ChatMessage {
    return {id, role: 'user', content, metadata}
}

/** 落库（sessionId 空时仅内存态） */
function persist(
    conversationRepo: IConversationRepository | null,
    sessionId: string | undefined,
    message: ChatMessage,
): void {
    if (!conversationRepo || !sessionId) {
        logger.debug('[AgentLoop] no session, catalog message kept in memory only')
        return
    }
    try {
        // ChatMessage 无 timestamp 字段；落库 Message 需要，此处补齐
        conversationRepo.writeMessagesDelta(sessionId, {...message, timestamp: Date.now()} as unknown as Message)
    } catch (err) {
        logger.debug('[AgentLoop] catalog message persist failed', {error: String(err)})
    }
}
