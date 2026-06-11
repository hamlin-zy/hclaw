import {getDatabase, saveDatabase} from './index'
import {SqliteMessageBlockRepository} from './messageBlockRepository'
import {blocksToMessage, messageToBlocks} from './messageBlockHelper'
import type {IConversationRepository} from '../interfaces'
import type {BlockType, ConversationMeta, ConversationWithStats, LlmStats, Message, MessageBlock} from '@shared/types'

export class SqliteConversationRepository implements IConversationRepository {
    private blockRepo = new SqliteMessageBlockRepository()

    // ── CRUD ────────────────────────────────────────────

    create(convId: string, meta: ConversationMeta): boolean {
        try {
            const db = getDatabase()
            const now = Date.now()
            db.prepare('INSERT OR REPLACE INTO conversations (id, meta, created_at, updated_at, workspace_path) VALUES (?, ?, ?, ?, ?)')
                .run(convId, JSON.stringify(meta), now, now, meta.workspacePath || '')
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteConversationRepository] create failed:', err)
            return false
        }
    }

    readMeta(convId: string): ConversationMeta | null {
        try {
            const db = getDatabase()
            const row = db.prepare('SELECT meta FROM conversations WHERE id = ?').get(convId) as {
                meta: string
            } | undefined
            return row ? JSON.parse(row.meta) : null
        } catch (err) {
            console.error('[SqliteConversationRepository] readMeta failed:', err)
            return null
        }
    }

    updateMeta(convId: string, updates: Partial<ConversationMeta>): boolean {
        try {
            const merged = {...this.readMeta(convId), ...updates, updatedAt: Date.now()}
            const db = getDatabase()
            db.prepare('UPDATE conversations SET meta = ?, updated_at = ?, workspace_path = ? WHERE id = ?')
                .run(JSON.stringify(merged), Date.now(), merged.workspacePath || '', convId)
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteConversationRepository] updateMeta failed:', err)
            return false
        }
    }

    delete(convId: string): boolean {
        try {
            getDatabase().prepare('DELETE FROM conversations WHERE id = ?').run(convId)
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteConversationRepository] delete failed:', err)
            return false
        }
    }

    list(): ConversationMeta[] {
        try {
            const rows = getDatabase().prepare('SELECT meta FROM conversations ORDER BY updated_at DESC').all() as Array<{
                meta: string
            }>
            return rows.map(row => JSON.parse(row.meta))
        } catch (err) {
            console.error('[SqliteConversationRepository] list failed:', err)
            return []
        }
    }

    listByWorkspace(workspacePath: string): ConversationMeta[] {
        try {
            const rows = getDatabase().prepare(
                'SELECT meta FROM conversations WHERE workspace_path = ? ORDER BY updated_at DESC'
            ).all(workspacePath) as Array<{ meta: string }>
            return rows.map(row => JSON.parse(row.meta))
        } catch (err) {
            console.error('[SqliteConversationRepository] listByWorkspace failed:', err)
            return []
        }
    }

    // ── Messages ────────────────────────────────────────

    readMessages(convId: string): Message[] {
        try {
            const db = getDatabase()

            const msgRows = db.prepare(
                'SELECT id, role, timestamp, ended_at, metadata, llm_stats FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC'
            ).all(convId) as typeof this.msgRowType[]

            return  this.buildMessagesFromRows(msgRows)
        } catch (err) {
            console.error('[SqliteConversationRepository] readMessages failed:', err)
            return []
        }
    }

    writeMessages(convId: string, messages: Message[]): boolean {
        try {
            const db = getDatabase()

            // 读取当前消息总数（诊断用）
            const _beforeCount = (db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ?').get(convId) as {cnt: number})?.cnt ?? 0

            // ── ★ 核心修复：使用 INSERT OR REPLACE 逐条替换，不再 DELETE ALL ──
            // 旧方案 DELETE ALL + INSERT ALL 会误删 compact 时尚未被 worker 感知的新消息（如刚收到的用户指令）
            // 新方案只替换 compact 结果中包含的消息，未涉及的消息（含新用户消息）原样保留
            const messageIds = messages.map(m => m.id).filter(Boolean) as string[]
            const writeTransaction = db.transaction(() => {
                // 1. 删除将被替换消息的旧 blocks（INSERT OR REPLACE 不会级联删除关联 blocks）
                if (messageIds.length > 0) {
                    const placeholders = messageIds.map(() => '?').join(',')
                    const _delBlockResult = db.prepare(`DELETE FROM message_blocks WHERE message_id IN (${placeholders})`).run(...messageIds)
                }

                // 2. INSERT OR REPLACE 逐条写入 compact 结果
                const msgStmt = db.prepare(
                    'INSERT OR REPLACE INTO messages (id, conversation_id, role, timestamp, ended_at, metadata, llm_stats) VALUES (?, ?, ?, ?, ?, ?, ?)'
                )
                const blockStmt = db.prepare(
                    'INSERT OR REPLACE INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                )

                let insertedCount = 0
                let blockCount = 0
                for (const msg of messages) {
                    const {messages: [msgRecord], blocks} = messageToBlocks(msg, convId)
                    const llmStats = msg.llmStats ? JSON.stringify(msg.llmStats) : null

                    msgStmt.run(msgRecord.id, convId, msgRecord.role, msgRecord.timestamp, msgRecord.endedAt ?? null, JSON.stringify(msgRecord.metadata), llmStats)
                    insertedCount++

                    for (const block of blocks) {
                        blockStmt.run(block.id, block.messageId, block.blockType, block.content, block.data, block.sequence, block.timestamp, block.endedAt ?? null)
                        blockCount++
                    }
                }

                const _updateResult = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), convId)
            })

            writeTransaction()
            saveDatabase()

            return true
        } catch (err) {
            console.error('[SqliteConversationRepository] writeMessages failed:', err)
            return false
        }
    }

    setMessageEnded(convId: string, messageId: string, endedAt: number): boolean {
        try {
            const blocks = this.blockRepo.readBlocksByMessage(messageId)
            const endBlock = blocks.find(b => b.blockType === 'end')

            if (endBlock) {
                this.blockRepo.updateBlock(endBlock.id, {endedAt, data: JSON.stringify({endedAt})})
            } else {
                this.blockRepo.writeBlock(convId, {
                    id: `${messageId}-end`, messageId, blockType: 'end', content: null,
                    data: JSON.stringify({endedAt}), sequence: blocks.length, timestamp: endedAt, endedAt,
                })
            }

            getDatabase().prepare('UPDATE messages SET ended_at = ? WHERE id = ? AND conversation_id = ?').run(endedAt, messageId, convId)
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteConversationRepository] setMessageEnded failed:', err)
            return false
        }
    }

    updateMessageLlmStats(convId: string, messageId: string, llmStats: LlmStats[]): boolean {
        try {
            getDatabase().prepare('UPDATE messages SET llm_stats = ? WHERE id = ? AND conversation_id = ?').run(JSON.stringify(llmStats), messageId, convId)
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteConversationRepository] updateMessageLlmStats failed:', err)
            return false
        }
    }

    deleteMessage(convId: string, messageId: string): boolean {
        try {
            const db = getDatabase()
            const remaining = this.readMessages(convId).filter(m => m.id !== messageId)

            db.prepare('DELETE FROM message_blocks WHERE message_id = ?').run(messageId)
            db.prepare('DELETE FROM messages WHERE id = ? AND conversation_id = ?').run(messageId, convId)

            // Rewrite remaining messages
            const msgStmt = db.prepare('INSERT OR REPLACE INTO messages (id, conversation_id, role, timestamp, ended_at, metadata, llm_stats) VALUES (?, ?, ?, ?, ?, ?, ?)')
            const blockStmt = db.prepare('INSERT INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')

            for (const msg of remaining) {
                const {messages: [msgRecord], blocks} = messageToBlocks(msg, convId)
                const llmStats = msg.llmStats ? JSON.stringify(msg.llmStats) : null

                msgStmt.run(msgRecord.id, convId, msgRecord.role, msgRecord.timestamp, msgRecord.endedAt ?? null, JSON.stringify(msgRecord.metadata), llmStats)

                db.prepare('DELETE FROM message_blocks WHERE message_id = ?').run(msgRecord.id)
                for (const block of blocks) {
                    blockStmt.run(block.id, block.messageId, block.blockType, block.content, block.data, block.sequence, block.timestamp, block.endedAt ?? null)
                }
            }

            db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), convId)
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteConversationRepository] deleteMessage failed:', err)
            return false
        }
    }

    // ── Paginated reads ──────────────────────────────

    /** Row shape returned by message SELECT queries. */
    private readonly msgRowType = null as unknown as {
        id: string; role: string; timestamp: number;
        ended_at: number | null; metadata: string | null; llm_stats: string | null
    }

    /** Assemble message rows + their blocks into Message objects. */
    private buildMessagesFromRows(msgRows: typeof this.msgRowType[]): Message[] {
        if (msgRows.length === 0) return []

        const db = getDatabase()
        const msgIds = msgRows.map(r => r.id)
        const blocksRows = db.prepare(
            `SELECT id, message_id, block_type, content, data, sequence, timestamp, ended_at
             FROM message_blocks WHERE message_id IN (${msgIds.map(() => '?').join(',')})
             ORDER BY message_id, sequence ASC`
        ).all(...msgIds) as Array<{
            id: string; message_id: string; block_type: string; content: string | null; data: string | null;
            sequence: number; timestamp: number; ended_at: number | null
        }>

        const blocksByMsg = new Map<string, typeof blocksRows>()
        for (const row of blocksRows) {
            if (!blocksByMsg.has(row.message_id)) blocksByMsg.set(row.message_id, [])
            blocksByMsg.get(row.message_id)!.push(row)
        }

        return msgRows.map(row => {
            const role = row.role as 'user' | 'assistant' | 'system'
            const metadata = row.metadata ? JSON.parse(row.metadata) : {}
            const message: Message = {
                id: row.id, role, timestamp: row.timestamp, endedAt: row.ended_at ?? undefined,
                content: role === 'assistant' ? '' : (metadata.content || ''), ...metadata,
            }
            // ★ 诊断: 追踪 content 的来源
            if (row.llm_stats) {
                try {
                    message.llmStats = JSON.parse(row.llm_stats)
                } catch { /* ignore */
                }
            }
            const blocks: MessageBlock[] = (blocksByMsg.get(row.id) || []).map(b => ({
                id: b.id, messageId: b.message_id, blockType: b.block_type as BlockType,
                content: b.content, data: b.data, sequence: b.sequence,
                timestamp: b.timestamp, endedAt: b.ended_at ?? undefined,
            }))
            return role === 'assistant' ? blocksToMessage(message, blocks) : message
        })
    }

    readMessagesTail(convId: string, count: number): { messages: Message[]; totalCount: number } {
        try {
            const db = getDatabase()
            const totalRow = db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ?').get(convId) as {
                cnt: number
            }
            const totalCount = totalRow?.cnt ?? 0

            const msgRows = db.prepare(
                'SELECT id, role, timestamp, ended_at, metadata, llm_stats FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?'
            ).all(convId, count) as typeof this.msgRowType[]
            msgRows.reverse()

            return {messages: this.buildMessagesFromRows(msgRows), totalCount}
        } catch (err) {
            console.error('[SqliteConversationRepository] readMessagesTail failed:', err)
            return {messages: [], totalCount: 0}
        }
    }

    readMessagesBefore(convId: string, beforeTimestamp: number, count: number): {
        messages: Message[];
        totalCount: number
    } {
        try {
            const db = getDatabase()
            const totalRow = db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ?').get(convId) as {
                cnt: number
            }
            const totalCount = totalRow?.cnt ?? 0

            const msgRows = db.prepare(
                'SELECT id, role, timestamp, ended_at, metadata, llm_stats FROM messages WHERE conversation_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?'
            ).all(convId, beforeTimestamp, count) as typeof this.msgRowType[]
            msgRows.reverse()

            return {messages: this.buildMessagesFromRows(msgRows), totalCount}
        } catch (err) {
            console.error('[SqliteConversationRepository] readMessagesBefore failed:', err)
            return {messages: [], totalCount: 0}
        }
    }

    // ── Batch operations ─────────────────────────────────

    listWithStats(workspacePath: string): ConversationWithStats[] {
        try {
            const rows = getDatabase().prepare(`
                SELECT c.id, c.meta, c.workspace_path, c.created_at, c.updated_at,
                       COUNT(DISTINCT m.id) AS message_count,
                       COUNT(mb.id) AS block_count,
                       COALESCE(MAX(m.timestamp), c.created_at) AS sort_time
                FROM conversations c
                LEFT JOIN messages m ON m.conversation_id = c.id
                LEFT JOIN message_blocks mb ON mb.message_id = m.id
                WHERE c.workspace_path = ?
                GROUP BY c.id
                ORDER BY sort_time DESC
            `).all(workspacePath) as Array<{
                id: string;
                meta: string;
                workspace_path: string;
                created_at: number;
                updated_at: number;
                message_count: number;
                block_count: number;
                sort_time: number
            }>

            return rows.map(row => ({
                ...JSON.parse(row.meta), id: row.id, workspacePath: row.workspace_path,
                updatedAt: row.updated_at, messageCount: row.message_count, blockCount: row.block_count,
            }))
        } catch (err) {
            console.error('[SqliteConversationRepository] listWithStats failed:', err)
            return []
        }
    }

    deleteBatch(ids: string[]): boolean {
        try {
            const db = getDatabase()
            const stmt = db.prepare('DELETE FROM conversations WHERE id = ?')
            db.transaction((ids: string[]) => {
                for (const id of ids) stmt.run(id)
            })(ids)
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteConversationRepository] deleteBatch failed:', err)
            return false
        }
    }

    // ── 系统提示词缓存 ────────────────────────────────

    getSystemPrompt(convId: string): string | null {
        try {
            const db = getDatabase()
            const row = db.prepare(
                'SELECT system_prompt FROM conversations WHERE id = ?'
            ).get(convId) as { system_prompt: string | null } | undefined
            return row?.system_prompt ?? null
        } catch (err) {
            console.error('[SqliteConversationRepository] getSystemPrompt failed:', err)
            return null
        }
    }

    setSystemPrompt(convId: string, prompt: string): boolean {
        try {
            const db = getDatabase()
            db.prepare('UPDATE conversations SET system_prompt = ?, updated_at = ? WHERE id = ?')
                .run(prompt, Date.now(), convId)
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteConversationRepository] setSystemPrompt failed:', err)
            return false
        }
    }
}
