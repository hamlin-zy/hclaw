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
import type {CatalogMetadata} from '@shared/types/message'
import {collectCatalogSnapshot, decidePublish, decideMcpPublish} from '../skills/catalogInjector'
import {logger} from '../logger'

/**
 * 目录发布跨轮状态（追加式：仅 digest 门控，无消息位置管理，spec §3.1）
 *
 * skills / mcp 两源独立 digest：MCP 频繁变动不应连累技能目录重发（token 浪费）。
 */
export interface CatalogState {
    /** 上次发布的 skills 目录 digest */
    lastSkillDigest?: string
    /** 上次发布的 MCP 工具目录 digest */
    lastMcpDigest?: string
    /** 连续残缺快照计数（完整性门控，spec §5.2） */
    incompleteStreak: number
}

/**
 * 从会话消息流还原：按 catalogKind 分别倒序取各自最后一条 catalog 消息的 digest
 * （仅为崩溃恢复续用门控）。
 *
 * 兼容旧数据：无 `catalogKind` 的历史 catalog 消息一律视为 'skills'，
 * 否则升级后会把技能目录当成缺失而重复发布。
 */
export function restoreCatalogState(messages: ReadonlyArray<ChatMessage>): CatalogState {
    const state: CatalogState = {incompleteStreak: 0}
    for (let i = messages.length - 1; i >= 0; i--) {
        const meta = messages[i].metadata as Record<string, unknown> | undefined
        if (meta?.sourceKind !== SOURCE_KIND_CATALOG) continue
        const kind = meta.catalogKind === 'mcp' ? 'mcp' : 'skills'
        if (kind === 'mcp') {
            if (state.lastMcpDigest === undefined) state.lastMcpDigest = meta.catalogDigest as string | undefined
        } else {
            if (state.lastSkillDigest === undefined) state.lastSkillDigest = meta.catalogDigest as string | undefined
        }
        if (state.lastSkillDigest !== undefined && state.lastMcpDigest !== undefined) break
    }
    return state
}

/**
 * 执行目录 pre-step。
 *
 * 两条独立消息（skills / MCP），各自 digest 门控：MCP 变动不重发技能目录。
 *
 * @param mcpToolDeclared 本轮注入 LLM 的 tools 里是否真的带上了 call_mcp_tool。
 *   受限 agent（白名单未保留它）为 false —— 此时不发布 MCP 目录，否则目录会指示
 *   模型调用一个未声明的工具。默认 true 仅为兼容测试装配，业务调用方一律显式传值。
 * @returns 更新后的 LoopState 与 CatalogState（无变化时原样返回入参引用）
 */
export function runCatalogPreStep(
    currentState: LoopState,
    catalogState: CatalogState,
    conversationRepo: IConversationRepository | null,
    sessionId: string | undefined,
    fullDescriptions: boolean,
    mcpToolDeclared = true,
): {state: LoopState; catalogState: CatalogState} {
    let state = currentState
    const cs: CatalogState = {...catalogState, incompleteStreak: catalogState.incompleteStreak ?? 0}

    try {
        const snapshot = collectCatalogSnapshot()
        const mode = fullDescriptions ? 'full' : 'names'

        // ── skills 目录 ──
        const skillResult = decidePublish(
            snapshot, mode, cs.lastSkillDigest, !!cs.lastSkillDigest, cs.incompleteStreak,
        )
        cs.incompleteStreak = skillResult.nextIncompleteStreak
        if (skillResult.decision.action === 'publish') {
            const published = publishDecision(state, skillResult.decision, 'skills', conversationRepo, sessionId)
            state = published.state
            cs.lastSkillDigest = published.digest
        }

        // ── MCP 工具目录（mcpTools 为空时 decideMcpPublish 自行判定为不发布）──
        //    ★ 仅当本轮 tools 真的下发了 call_mcp_tool 时才发布：受限 agent
        //      （白名单既无调用器也无 MCP 工具）看到目录会去调一个未声明的工具。
        //      不可见时只跳过、**不重置 digest**：已发布过的目录仍留在消息流里且内容仍然
        //      准确，可见性恢复后若工具集未变即无需重复追加（避免来回翻转时堆积重复目录）。
        if (mcpToolDeclared) {
            const mcpResult = decideMcpPublish(
                snapshot, cs.lastMcpDigest, !!cs.lastMcpDigest, cs.incompleteStreak,
            )
            if (mcpResult.decision.action === 'publish') {
                const published = publishDecision(state, mcpResult.decision, 'mcp', conversationRepo, sessionId)
                state = published.state
                cs.lastMcpDigest = published.digest
            }
        }

        return {state, catalogState: cs}
    } catch (err) {
        // 目录注入失败不阻断主循环
        logger.debug('[AgentLoop] capability catalog pre-step skipped', {error: String(err)})
        return {state, catalogState: cs}
    }
}

/** 追加式发布一条 catalog 消息并落库，返回新 state 与已发布 digest */
function publishDecision(
    state: LoopState,
    decision: {content?: string; metadata?: CatalogMetadata},
    catalogKind: 'skills' | 'mcp',
    conversationRepo: IConversationRepository | null,
    sessionId: string | undefined,
): {state: LoopState; digest: string | undefined} {
    const meta = decision.metadata!
    const content = decision.content!
    const metaRecord = {...meta} as Record<string, unknown>

    // 追加式发布：始终产生新消息（旧消息内容字节不动）
    const created = makeCatalogMessage(randomUUID(), content, metaRecord)
    const nextState = addMessage(state, created)
    persist(conversationRepo, sessionId, created)
    logger.info('[AgentLoop] capability catalog published', {
        messageId: (created.id ?? '').slice(0, 8),
        kind: catalogKind,
    })
    return {state: nextState, digest: (meta as {catalogDigest: string}).catalogDigest}
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
