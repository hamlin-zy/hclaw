/**
 * 能力目录 pre-step（Task 6）
 *
 * 在 agent 主循环每轮"构建系统提示词"之前调用：
 * - 收集当前启用的能力条目并计算 digest
 * - 仅在 digest 变化（或尚未发布）时发布/原地替换一条 user 角色 catalog 消息
 * - 持久化走 conversationRepository.writeMessagesDelta（update-by-id，单事务原地替换）
 *
 * 替换模式 CATALOG_REPLACE_MODE = 'update-by-id'（Task 0 spike 结论）。
 * tombstone 回退方案（如需切换）：旧消息 metadata 打 `catalogSuperseded: true`
 * 后追加新消息，恢复扫描时跳过被 superseded 的消息即可，本文件保留该约定字段语义。
 */

import {randomUUID} from 'crypto'
import type {ChatMessage, LoopState} from '../state'
import {addMessage, ChunkedMessages} from '../state'
import type {IConversationRepository} from '../../repositories/interfaces'
import type {Message} from '@shared/types'
import {SOURCE_KIND_CATALOG} from '@shared/types/message'
import {collectCatalogSnapshot, decidePublish} from '../skills/catalogInjector'
import {logger} from '../logger'

/** 目录发布跨轮状态（循环外初始化；可从既有会话消息还原） */
export interface CatalogState {
    /** 上次发布的 digest */
    lastDigest?: string
    /** 已发布的 catalog 消息 id（update-by-id 原地替换目标） */
    publishedMessageId?: string
    /** 连续残缺快照计数（完整性门控，spec §5.2） */
    incompleteStreak: number
}

/**
 * 从会话消息流还原 CatalogState。
 * 取最后一个 metadata.sourceKind === 'capability-catalog' 且未被 superseded 的消息。
 */
export function restoreCatalogState(messages: ReadonlyArray<ChatMessage>): CatalogState {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        const meta = msg.metadata as Record<string, unknown> | undefined
        if (!meta || meta.sourceKind !== SOURCE_KIND_CATALOG) continue
        if (meta.catalogSuperseded) continue
        return {
            lastDigest: meta.catalogDigest as string | undefined,
            publishedMessageId: msg.id,
            incompleteStreak: 0,
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
            snapshot, mode, cs.lastDigest, !!cs.publishedMessageId, cs.incompleteStreak,
        )
        cs.incompleteStreak = nextIncompleteStreak
        if (decision.action === 'none') return {state, catalogState: cs}

        const meta = decision.metadata!
        const content = decision.content!
        const metaRecord = {...meta} as Record<string, unknown>

        // 原地替换目标存在性校验：publishedMessageId 悬空（消息被裁剪/异常态）时降级为追加新消息
        if (decision.action === 'replace' && cs.publishedMessageId
            && !state.messages.some(m => m.id === cs.publishedMessageId)) {
            // Tombstone 回退（spec §5.2 修订点 3）：旧消息不在内存流中，直接追加新消息即可满足语义。
            // ⚠️ 此处刻意【不】给旧消息打 `catalogSuperseded: true` 标记：
            // restoreCatalogState 依赖"倒序取最新一条非 superseded 的 catalog 消息"的语义保证，
            // 旧消息已不在内存流中，追加新消息后它自然不会被 restore 命中。
            // 若未来修改 restore 的扫描方向（改为正序/首条命中），必须先恢复 superseded 标记逻辑，否则会还原到过期目录。
            logger.warn('[AgentLoop] catalog publishedMessageId dangling, falling back to publish', {messageId: cs.publishedMessageId.slice(0, 8)})
            cs.publishedMessageId = undefined
        }

        if (decision.action === 'replace' && cs.publishedMessageId) {
            // 原地替换：同 id 消息更新 content + metadata
            const msgId = cs.publishedMessageId
            const replaced = makeCatalogMessage(msgId, content, metaRecord)
            const nextMessages = state.messages.map(m => (m.id === msgId ? replaced : m))
            state = Object.freeze({
                ...state,
                messages: Object.freeze([...nextMessages]),
                _chunked: new ChunkedMessages([...nextMessages]),
            })
            persist(conversationRepo, sessionId, replaced)
            logger.info('[AgentLoop] capability catalog replaced in place', {messageId: msgId.slice(0, 8)})
        } else {
            // 首次发布 / tombstone 回退：追加新消息
            const msgId = randomUUID()
            const created = makeCatalogMessage(msgId, content, metaRecord)
            state = addMessage(state, created)
            persist(conversationRepo, sessionId, created)
            cs.publishedMessageId = msgId
            logger.info('[AgentLoop] capability catalog published', {messageId: msgId.slice(0, 8)})
        }

        cs.lastDigest = meta.catalogDigest
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
