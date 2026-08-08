import {getDatabase, saveDatabase} from './index'
import {SqliteMessageBlockRepository} from './messageBlockRepository'
import {blocksToMessage, messageToBlocks} from './messageBlockHelper'
import type {IConversationRepository} from '../interfaces'
import type {BlockDeltaPatch, BlockType, ConversationMeta, ConversationWithStats, LlmStats, Message, MessageBlock} from '@shared/types'

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
                'SELECT id, role, timestamp, ended_at, metadata, llm_stats, is_partial FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC'
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

                for (const msg of messages) {
                    const {messages: [msgRecord], blocks} = messageToBlocks(msg, convId)
                    const llmStats = msg.llmStats ? JSON.stringify(msg.llmStats) : null

                    msgStmt.run(msgRecord.id, convId, msgRecord.role, msgRecord.timestamp, msgRecord.endedAt ?? null, JSON.stringify(msgRecord.metadata), llmStats)

                    for (const block of blocks) {
                        blockStmt.run(block.id, block.messageId, block.blockType, block.content, block.data, block.sequence, block.timestamp, block.endedAt ?? null)
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

    /**
     * 增量写入单条消息（渲染进程流式期间的频繁落库路径）。
     * 只 UPSERT 该消息 + 重建其 blocks，不做全量重写。
     */
    writeMessagesDelta(convId: string, message: Message): boolean {
        try {
            const db = getDatabase()
            const {messages: [msgRecord], blocks} = messageToBlocks(message, convId)

            db.transaction(() => {
                // 1. 删除该消息的旧 blocks（INSERT OR REPLACE 不级联删除 blocks）
                db.prepare('DELETE FROM message_blocks WHERE message_id = ?').run(message.id)
                // 2. UPSERT 消息行（保留已有 llm_stats，避免流式中间态覆盖已写入的统计）
                const existingRow = db.prepare(
                    'SELECT llm_stats FROM messages WHERE id = ?'
                ).get(message.id) as { llm_stats: string | null } | undefined
                const llmStats = message.llmStats ? JSON.stringify(message.llmStats) : (existingRow?.llm_stats ?? null)
                db.prepare(
                    'INSERT OR REPLACE INTO messages (id, conversation_id, role, timestamp, ended_at, metadata, llm_stats) VALUES (?, ?, ?, ?, ?, ?, ?)'
                ).run(
                    msgRecord.id,
                    convId,
                    msgRecord.role,
                    msgRecord.timestamp,
                    msgRecord.endedAt ?? null,
                    JSON.stringify(msgRecord.metadata),
                    llmStats,
                )
                // 3. 写入新 blocks
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
                // 4. 更新会话时间戳
                db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), convId)
            })()

            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteConversationRepository] writeMessagesDelta failed:', err)
            return false
        }
    }

    /**
     * 块级增量写入（流式期间渲染进程高频路径）。
     * 幂等 UPSERT：块 id 存在则 UPDATE content/data（think/text 尾块增长），不存在则 INSERT 并分配 sequence。
     * 不变式：已落库块永不重写（不 DELETE 任何已有块）。
     */
    writeBlockDelta(convId: string, msgId: string, patch: BlockDeltaPatch): boolean {
        try {
            const db = getDatabase()
            db.transaction(() => {
                // ★ 先建/更新消息行，再写块：message_blocks.message_id 有外键引用 messages.id
                //   （迁移 001_initial.sql:62 ON DELETE CASCADE）。首写（消息行尚不存在）时
                //   若先 INSERT 块会撞 FOREIGN KEY constraint failed 整笔回滚——此前流式期间
                //   增量块全部因此丢失，仅靠主进程保险丝全量写兜底（已实测根因）。
                if (patch.messageFields && typeof patch.messageFields.role === 'string') {
                    // ★ NOT NULL 对只验一半的修复（review）：role 判了 string 但 timestamp 未校验，
                    //   缺失/非法 timestamp 会让 INSERT OR REPLACE 撞 `timestamp INTEGER NOT NULL`，
                    //   整笔事务回滚（连块写入一起丢）并静默返回 false。
                    //   改为显式防御：要求建行但 timestamp 非法 → 抛错回滚整笔事务返回 false，
                    //   渲染端按"失败重试"语义保留 dirty 块待 30s 兜底重试，绝不写半笔/垃圾行。
                    const ts = patch.messageFields.timestamp
                    if (typeof ts !== 'number' || !Number.isFinite(ts)) {
                        throw new Error(`writeBlockDelta: messageFields.timestamp 非法（缺失/非有限数），msg=${msgId}`)
                    }
                    // ★ REPLACE-into-CASCADE fix：INSERT OR REPLACE 在冲突时先 DELETE 旧行再 INSERT，
                    //   DELETE 触发 message_blocks.message_id 的 ON DELETE CASCADE，导致该消息
                    //   所有已落库的块被连带删除。改为「首次 INSERT OR IGNORE + 后续 UPDATE」模式。
                    const existingRow = db.prepare('SELECT metadata, llm_stats FROM messages WHERE id = ?').get(msgId) as { metadata: string | null; llm_stats: string | null } | undefined
                    const metadata = patch.messageFields.metadata
                        ? JSON.stringify(patch.messageFields.metadata)
                        : (existingRow?.metadata ?? '{}')
                    if (existingRow) {
                        // 行已存在 → UPDATE 可变字段（metadata / ended_at），不触发 DELETE CASCADE
                        db.prepare('UPDATE messages SET metadata = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?').run(
                            metadata,
                            patch.messageFields.endedAt ?? null,
                            msgId,
                        )
                    } else {
                        // 首写 → INSERT（此时无块，不存在 CASCADE 风险）
                        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, ended_at, metadata, llm_stats) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
                            msgId, convId, patch.messageFields.role, patch.messageFields.timestamp,
                            patch.messageFields.endedAt ?? null,
                            metadata,
                            null,
                        )
                    }
                }
                let nextSeq = -1
                const resolveSeq = (): number => {
                    if (nextSeq < 0) {
                        nextSeq = (db.prepare('SELECT COALESCE(MAX(sequence), -1) + 1 AS s FROM message_blocks WHERE message_id = ?').get(msgId) as {s: number}).s
                    }
                    return nextSeq++
                }
                for (const block of patch.upsertBlocks ?? []) {
                    const existing = db.prepare('SELECT id FROM message_blocks WHERE id = ?').get(block.id) as {id: string} | undefined
                    if (existing) {
                        db.prepare('UPDATE message_blocks SET content = ?, data = ?, timestamp = ? WHERE id = ?').run(
                            block.content, block.data, block.timestamp, block.id,
                        )
                    } else {
                        db.prepare('INSERT INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
                            block.id, msgId, block.blockType, block.content, block.data, resolveSeq(), block.timestamp, block.endedAt ?? null,
                        )
                    }
                }
                if (patch.finalize) {
                    const endedAt = patch.messageFields?.endedAt ?? Date.now()
                    const endBlock = db.prepare("SELECT id FROM message_blocks WHERE message_id = ? AND block_type = 'end'").get(msgId) as {id: string} | undefined
                    if (endBlock) {
                        db.prepare("UPDATE message_blocks SET data = ?, ended_at = ? WHERE id = ?").run(JSON.stringify({endedAt}), endedAt, endBlock.id)
                    } else {
                        db.prepare("INSERT INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at) VALUES (?, ?, 'end', NULL, ?, ?, ?, ?)").run(
                            `${msgId}-end`, msgId, JSON.stringify({endedAt}), resolveSeq(), endedAt, endedAt,
                        )
                    }
                    db.prepare('UPDATE messages SET ended_at = ? WHERE id = ?').run(endedAt, msgId)
                }
                db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), convId)
            })()
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteConversationRepository] writeBlockDelta failed:', err)
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
        ended_at: number | null; metadata: string | null; llm_stats: string | null;
        is_partial: number
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
            // 标记崩溃恢复的未完成消息：
            // is_partial=1（流式中间态落库未 final）或 assistant 消息无 ended_at（渲染端 delta 最后写入但未完成）
            if (role === 'assistant' && (row.is_partial === 1 || row.ended_at == null)) {
                message.metadata = { ...message.metadata, _partialRecovery: true }
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
                'SELECT id, role, timestamp, ended_at, metadata, llm_stats, is_partial FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?'
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
                'SELECT id, role, timestamp, ended_at, metadata, llm_stats, is_partial FROM messages WHERE conversation_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?'
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

    readUsageRaw(convIds: string[]): {
        llmStatsByConv: Map<string, LlmStats[]>;
        toolCallCountByConv: Map<string, number>;
    } {
        const llmStatsByConv = new Map<string, LlmStats[]>()
        const toolCallCountByConv = new Map<string, number>()
        if (convIds.length === 0) return {llmStatsByConv, toolCallCountByConv}

        try {
            const db = getDatabase()
            const placeholders = convIds.map(() => '?').join(',')
            const params = [...convIds]

            // 一次查询取全部相关消息的 llm_stats（不读 metadata/content，避免传输正文）
            const msgRows = db.prepare(
                `SELECT conversation_id, llm_stats FROM messages WHERE conversation_id IN (${placeholders})`
            ).all(...params) as Array<{ conversation_id: string; llm_stats: string | null }>

            for (const row of msgRows) {
                if (!row.llm_stats) continue
                const list = llmStatsByConv.get(row.conversation_id) ?? []
                try {
                    list.push(...(JSON.parse(row.llm_stats) as LlmStats[]))
                } catch {
                    // 单条损坏的 llm_stats 忽略，不阻塞整体统计
                }
                llmStatsByConv.set(row.conversation_id, list)
            }

            // 工具调用计数：message_blocks 中 block_type='tool_call'
            const toolRows = db.prepare(
                `SELECT m.conversation_id, COUNT(*) AS cnt
                 FROM message_blocks b
                 JOIN messages m ON m.id = b.message_id
                 WHERE b.block_type = 'tool_call' AND m.conversation_id IN (${placeholders})
                 GROUP BY m.conversation_id`
            ).all(...params) as Array<{ conversation_id: string; cnt: number }>

            for (const row of toolRows) {
                toolCallCountByConv.set(row.conversation_id, row.cnt)
            }
        } catch (err) {
            console.error('[SqliteConversationRepository] readUsageRaw failed:', err)
        }
        return {llmStatsByConv, toolCallCountByConv}
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
