/**
 * 系统环境快照 pre-step（catalog 式追加，缓存稳定化 #日期）
 *
 * 背景：system 提示词中曾动态拼接"当前日期"，跨天导致 anthropicAdapter 唯一
 * cache_control 断点（system[0]）内容变化 → 供应商前缀缓存全失效。
 *
 * 方案：日期移出 system，改为每轮 pre-step 计算环境 digest（内容 = 今天的
 * yyyy-MM-dd），仅在 digest 变化（或首次会话）时追加一条带
 * metadata.sourceKind=SOURCE_KIND_SYSTEM_ENV 的 user 消息到消息流尾部并
 * 持久化；前部消息字节不动。EnvState 从会话消息流倒序恢复（崩溃重启不重复
 * 发布），与 catalogPublish 的 CatalogState 同构。
 *
 * ⚠️ 该消息内容仅含日期等会话级环境信息，绝不包含权限模式（安全决策）。
 */

import {randomUUID} from 'crypto'
import type {ChatMessage, LoopState} from '../state'
import {addMessage} from '../state'
import type {IConversationRepository} from '../../repositories/interfaces'
import type {Message} from '@shared/types'
import {SOURCE_KIND_SYSTEM_ENV} from '@shared/types/message'
import {formatYmd} from '../utils/dateUtils'
import {logger} from '../logger'

/** 环境快照跨轮状态（仅 digest 门控，与 CatalogState 同构） */
export interface EnvState {
    /** 上次发布的环境 digest（当前实现 = yyyy-MM-dd 日期） */
    lastDigest?: string
}

/** 从会话消息流还原：倒序取最后一条 system-env 消息的 digest（崩溃恢复续用门控） */
export function restoreEnvState(messages: ReadonlyArray<ChatMessage>): EnvState {
    for (let i = messages.length - 1; i >= 0; i--) {
        const meta = messages[i].metadata as Record<string, unknown> | undefined
        if (meta?.sourceKind === SOURCE_KIND_SYSTEM_ENV) {
            return {lastDigest: meta.envDigest as string | undefined}
        }
    }
    return {}
}

/** 构造环境快照正文（<system-reminder> 包裹，与 catalog 同构；不含权限模式） */
export function renderEnvContent(digest: string): string {
    return `<system-reminder>
Today's date is ${digest}. If earlier context mentioned a different date, this line supersedes it.
</system-reminder>`
}

/**
 * 执行环境快照 pre-step。
 * @returns 更新后的 LoopState 与 EnvState（digest 无变化时原样返回入参引用，零追加）
 */
export function runEnvPreStep(
    currentState: LoopState,
    envState: EnvState,
    conversationRepo: IConversationRepository | null,
    sessionId: string | undefined,
): {state: LoopState; envState: EnvState} {
    try {
        const digest = formatYmd()
        if (envState.lastDigest === digest) {
            return {state: currentState, envState}
        }

        const created: ChatMessage = {
            id: randomUUID(),
            role: 'user',
            content: renderEnvContent(digest),
            metadata: {sourceKind: SOURCE_KIND_SYSTEM_ENV, envDigest: digest},
        }
        const state = addMessage(currentState, created)
        if (conversationRepo && sessionId) {
            try {
                conversationRepo.writeMessagesDelta(
                    sessionId, {...created, timestamp: Date.now()} as unknown as Message,
                )
            } catch (err) {
                logger.debug('[AgentLoop] env message persist failed', {error: String(err)})
            }
        }
        logger.info('[AgentLoop] system env snapshot published', {digest})
        return {state, envState: {lastDigest: digest}}
    } catch (err) {
        // 环境注入失败不阻断主循环
        logger.debug('[AgentLoop] env pre-step skipped', {error: String(err)})
        return {state: currentState, envState}
    }
}
