/**
 * AgentManager 消息持久化器
 * 
 * 负责将累积的流式消息合并并持久化到 SQLite。
 */

import {logger} from './logger'
import type {Message, ToolCall} from '@shared/types'
import type {ChatMessage} from './model/types'
import type {PendingAssistantMsg} from './manager.types'
import type {AgentStreamEvent} from './stream'
import {backupOldMessagesToDisk} from './manager.backup'

/**
 * 持久化压缩后的消息到 SQLite
 */
export async function persistCompactedMessages(
  conversationId: string,
  event: {
    messages: ChatMessage[]
    beforeTokens: number
    afterTokens: number
    savedTokens: number
    message: string
  },
): Promise<boolean> {
  try {
    const {createConversationRepository} = await import('../repositories')
    const conversationRepo = createConversationRepository()

    // 先读取旧消息（用于备份和诊断）
    const oldMessages = conversationRepo.readMessages(conversationId)
    const oldUserCount = oldMessages.filter(m => m.role === 'user').length

    // 备份旧消息
    try {
      if (oldMessages.length > 0) {
        backupOldMessagesToDisk(conversationId, oldMessages)
      }
    } catch (backupErr) {
      logger.warn('[AgentManager] backup old messages failed, proceeding anyway:', {error: backupErr})
    }

    // 写入压缩后的消息
    const now = Date.now()
    const compactedMessages = event.messages.map((m, i, all) => {
      const msg = m as ChatMessage & {timestamp?: number; id?: string}
      const newId = msg.id || `compact_msg_${now}_${i}`
      const newTs = msg.timestamp ?? (i === all.length - 1 ? now : now + i + 1)
      return {
        ...msg,
        id: newId,
        timestamp: newTs,
      } as ChatMessage
    })

    // 关键检查：如果 compact 后的 user 消息比原来少，这是问题信号！
    const compactUserCount = compactedMessages.filter(m => m.role === 'user').length
    if (compactUserCount < oldUserCount) {
      logger.warn('[AgentManager] compact 后 user 消息数量减少', {
        before: oldUserCount,
        after: compactUserCount,
        conversationId,
      })
    }

    const ok = conversationRepo.writeMessages(conversationId, compactedMessages as unknown as Message[])
    if (!ok) {
      logger.error('[AgentManager] persistCompactedMessages: writeMessages returned false')
      return false
    }
    return true
  } catch (err) {
    logger.error('[AgentManager] persistCompactedMessages failed:', {error: err})
    return false
  }
}

/**
 * 最终持久化（done/error 时调用）
 */
export async function persistAccumulatedMessages(
  conversationId: string,
  pending: PendingAssistantMsg | null | undefined,
  _event: AgentStreamEvent,
): Promise<void> {
  try {
    await doMergeAndPersist(conversationId, pending, true)
  } catch (err) {
    logger.error('[AgentManager] 持久化消息失败', {error: err, conversationId})
  }
}

/**
 * 合并 pending assistant 消息并写入 SQLite（核心方法）
 *
 * 使用 UPSERT 只写入/更新该条 assistant 消息及其 blocks，
 * 不再做 DELETE ALL + REINSERT ALL，避免并发写入导致消息丢失。
 *
 * @param isFinal - 是否为最终写入（done/error），会影响 thinkBlock 状态和 endedAt
 */
export async function doMergeAndPersist(
  conversationId: string,
  pending: PendingAssistantMsg | null | undefined,
  isFinal: boolean,
): Promise<void> {
  if (!pending || (!pending.content && pending.toolCalls.length === 0 && !pending.thinkContent)) {
    return
  }

  const {getDatabase, saveDatabase} = await import('../repositories/sqlite')
  const {messageToBlocks} = await import('../repositories/sqlite/messageBlockHelper')
  const db = getDatabase()
  const now = Date.now()

  // 读取写入前的消息数
  const beforeUserRows = db.prepare(
    'SELECT id, role FROM messages WHERE conversation_id = ? AND role = ? ORDER BY timestamp ASC'
  ).all(conversationId, 'user') as Array<{id: string; role: string}>

  const msg: Message = {
    id: pending.id,
    role: 'assistant',
    content: pending.content,
    timestamp: pending.timestamp,
    endedAt: isFinal ? now : undefined,
    toolCalls: pending.toolCalls.length > 0 ? pending.toolCalls : undefined,
    thinkBlock: pending.thinkContent
      ? {
          id: `think-${pending.id}`,
          content: pending.thinkContent,
          status: isFinal ? 'complete' : 'thinking',
          timestamp: now,
        }
      : undefined,
  }

  const {messages: [msgRecord], blocks} = messageToBlocks(msg, conversationId)

  // ★ 修复重复消息：读取已有 llm_stats，避免 INSERT OR REPLACE 将其覆盖为 null
  // （渲染进程可能已通过 writeMessages 或 updateMessageLlmStats IPC 提前写入）
  const existingRow = db.prepare(
    'SELECT llm_stats FROM messages WHERE id = ?'
  ).get(pending.id) as { llm_stats: string | null } | undefined
  const existingLlmStats = existingRow?.llm_stats

  // 使用事务包裹：先删旧 blocks → UPSERT message → 写入新 blocks
  db.transaction(() => {
    db.prepare('DELETE FROM message_blocks WHERE message_id = ?').run(pending.id)
    db.prepare(
      'INSERT OR REPLACE INTO messages (id, conversation_id, role, timestamp, ended_at, metadata, llm_stats) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      msgRecord.id,
      conversationId,
      msgRecord.role,
      msgRecord.timestamp,
      msgRecord.endedAt ?? null,
      JSON.stringify(msgRecord.metadata),
      existingLlmStats ?? null,
    )

    const blockStmt = db.prepare(
      'INSERT OR REPLACE INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    for (const block of blocks) {
      blockStmt.run(
        block.id,
        block.messageId,
        block.blockType,
        block.content,
        block.data,
        block.sequence,
        block.timestamp,
        block.endedAt ?? null,
      )
    }
  })()
  saveDatabase()

  // 检查 user 消息是否丢失
  const afterUserRows = db.prepare(
    'SELECT id, role FROM messages WHERE conversation_id = ? AND role = ? ORDER BY timestamp ASC'
  ).all(conversationId, 'user') as Array<{id: string; role: string}>
  if (afterUserRows.length < beforeUserRows.length) {
    const missing = beforeUserRows.filter(b => !afterUserRows.find(a => a.id === b.id))
    logger.error('[AgentManager] user消息减少', {
      before: beforeUserRows.length,
      after: afterUserRows.length,
      missingIds: missing.map(r => r.id?.slice(0, 8)).join(','),
      conversationId,
    })
  }
}