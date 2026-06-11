import { getDatabase, saveDatabase } from './index'
import type { IMessageBlockRepository } from '../interfaces'
import type {MessageBlock} from '@shared/types'

export class SqliteMessageBlockRepository implements IMessageBlockRepository {
  writeBlock(convId: string, block: MessageBlock): void {
    const db = getDatabase()
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    stmt.run(
      block.id,
      block.messageId,
      block.blockType,
      block.content,
      block.data,
      block.sequence,
      block.timestamp,
      block.endedAt ?? null
    )
  }

  updateBlock(blockId: string, updates: Partial<MessageBlock>): void {
    const db = getDatabase()
    const fields: string[] = []
    const values: unknown[] = []

    if (updates.content !== undefined) {
      fields.push('content = ?')
      values.push(updates.content)
    }
    if (updates.data !== undefined) {
      fields.push('data = ?')
      values.push(updates.data)
    }
    if (updates.endedAt !== undefined) {
      fields.push('ended_at = ?')
      values.push(updates.endedAt)
    }

    if (fields.length === 0) return

    values.push(blockId)
    const stmt = db.prepare(`UPDATE message_blocks SET ${fields.join(', ')} WHERE id = ?`)
    stmt.run(...values)
  }

  readBlocksByMessage(messageId: string): MessageBlock[] {
    const db = getDatabase()
    const stmt = db.prepare(
      'SELECT id, message_id, block_type, content, data, sequence, timestamp, ended_at FROM message_blocks WHERE message_id = ? ORDER BY sequence ASC'
    )
      const rows = stmt.all(messageId) as Array<{
          id: string,
          message_id: string,
          block_type: string,
          content: string | null,
          data: string | null,
          sequence: number,
          timestamp: number,
          ended_at: number | null
      }>
    return rows.map(row => ({
        id: row.id,
        messageId: row.message_id,
        blockType: row.block_type as MessageBlock['blockType'],
        content: row.content,
        data: row.data,
        sequence: row.sequence,
        timestamp: row.timestamp,
        endedAt: row.ended_at ?? undefined,
    }))
  }

  deleteBlocksByMessage(messageId: string): void {
    const db = getDatabase()
    const stmt = db.prepare('DELETE FROM message_blocks WHERE message_id = ?')
    stmt.run(messageId)
  }

  writeBlocks(convId: string, blocks: MessageBlock[]): void {
    const db = getDatabase()
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const block of blocks) {
      stmt.run(
        block.id,
        block.messageId,
        block.blockType,
        block.content,
        block.data,
        block.sequence,
        block.timestamp,
        block.endedAt ?? null
      )
    }
  }
}
