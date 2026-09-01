import {getDatabase, saveDatabase} from './index'
import {deleteByConversation} from './taskBatchRepository'
import {SqliteMessageBlockRepository} from './messageBlockRepository'
import {blocksToMessage, messageToBlocks} from './messageBlockHelper'
import type {IConversationRepository} from '../interfaces'
import type {BlockDeltaPatch, BlockType, ConversationMeta, ConversationWithStats, LlmStats, Message, MessageBlock} from '@shared/types'

// ★ 临时诊断（catalog 隐式消息渲染 bug）：捕获"catalog 内容 user 消息丢失 metadata"的写入方。
// 调试结束后应连同 writeMessages / writeMessagesDelta 中的调用点一并删除。
function logReminderWithoutSourceKind(source: string, convId: string, msg: Message): void {
    if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('<system-reminder>')
        && !msg.metadata?.sourceKind) {
        console.error(`[DIAG catalog-meta-loss] ${source} 写入无 sourceKind 的 reminder user 消息`,
            {convId: convId.slice(0, 12), msgId: msg.id, metadataKeys: Object.keys(msg.metadata ?? {})},
            new Error('stack').stack)
    }
}

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
            // 级联清理该会话的任务批次与任务（task_batches / tasks）
            deleteByConversation(convId)
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteConversationRepository] delete failed:', err)
            return false
        }
    }

    list(): ConversationMeta[] {
        try {
            // ★ 双源漂移修复：updatedAt 以列 updated_at 为唯一真源（与 listWithStats 同口径）。
            //   writeMessages/writeMessagesDelta 只更新列，不更新 meta JSON 的 updatedAt；
            //   若读 meta JSON，IPC conversation-list 重载后会拿到旧值导致排序回跳。
            const rows = getDatabase().prepare('SELECT meta, updated_at FROM conversations ORDER BY updated_at DESC').all() as Array<{
                meta: string
                updated_at: number
            }>
            return rows.map(row => ({...JSON.parse(row.meta), updatedAt: row.updated_at}))
        } catch (err) {
            console.error('[SqliteConversationRepository] list failed:', err)
            return []
        }
    }

    listByWorkspace(workspacePath: string): ConversationMeta[] {
        try {
            // ★ 同 list()：updatedAt 以列值为唯一真源
            const rows = getDatabase().prepare(
                'SELECT meta, updated_at FROM conversations WHERE workspace_path = ? ORDER BY updated_at DESC'
            ).all(workspacePath) as Array<{ meta: string; updated_at: number }>
            return rows.map(row => ({...JSON.parse(row.meta), updatedAt: row.updated_at}))
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
                'SELECT id, role, timestamp, ended_at, metadata, llm_stats, is_partial FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC, rowid ASC'
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
            for (const m of messages) {
                logReminderWithoutSourceKind('writeMessages', convId, m)
            }

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
                const llmStatsStmt = db.prepare('SELECT llm_stats FROM messages WHERE id = ?')
                const blockStmt = db.prepare(
                    'INSERT OR REPLACE INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at, turn_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
                )

                for (const msg of messages) {
                    const {messages: [msgRecord], blocks} = messageToBlocks(msg, convId)
                    // B1：llm_stats 不再随消息落库（llm_usage 唯一源）。仅保留已有列值（迁移前历史唯一源），
                    // 忽略消息对象携带的 llmStats（读侧组装含 llm_usage 回读数据，写回会造成双源重复统计）
                    const existingRow = llmStatsStmt.get(msgRecord.id) as {llm_stats: string | null} | undefined
                    const llmStats = existingRow?.llm_stats ?? null

                    msgStmt.run(msgRecord.id, convId, msgRecord.role, msgRecord.timestamp, msgRecord.endedAt ?? null, JSON.stringify(msgRecord.metadata), llmStats)

                    for (const block of blocks) {
                        blockStmt.run(block.id, block.messageId, block.blockType, block.content, block.data, block.sequence, block.timestamp, block.endedAt ?? null, block.turnIndex ?? null)
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

            logReminderWithoutSourceKind('writeMessagesDelta', convId, msgRecord)

            db.transaction(() => {
                // 1. 删除该消息的旧 blocks（INSERT OR REPLACE 不级联删除 blocks）
                db.prepare('DELETE FROM message_blocks WHERE message_id = ?').run(message.id)
                // 2. UPSERT 消息行（B1：llm_stats 不再随消息落库，llm_usage 唯一源。
                //    忽略 message.llmStats——渲染层累积的 stats 含读侧组装回读数据，
                //    写回 llm_stats 列会造成双源重复统计；仅保留迁移前历史唯一源列值）
                const existingRow = db.prepare(
                    'SELECT llm_stats FROM messages WHERE id = ?'
                ).get(message.id) as { llm_stats: string | null } | undefined
                const llmStats = existingRow?.llm_stats ?? null
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
                    'INSERT OR REPLACE INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at, turn_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
                        block.turnIndex ?? null,
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
                // ★ sequence 分配：每次 INSERT 都重新查询 MAX(sequence)+1。
                //   不缓存 nextSeq——end 块（finalize 分支）必须恒为当前最大，
                //   若沿用缓存值，end 可能排在该 patch 后续新插入块之前
                //   （历史 bug：end 被挤到 text 与 tool_call 之间，读回时
                //   轮次内顺序错乱 → 重建序列与 loop 内存态逐 token 不一致
                //   → KV cache 从该轮整段断裂）。事务内逐次查询开销可忽略。
                const nextSeq = (): number =>
                    (db.prepare('SELECT COALESCE(MAX(sequence), -1) + 1 AS s FROM message_blocks WHERE message_id = ?').get(msgId) as {s: number}).s
                for (const block of patch.upsertBlocks ?? []) {
                    const existing = db.prepare('SELECT id, block_type, content FROM message_blocks WHERE id = ?').get(block.id) as {id: string; block_type: string; content: string | null} | undefined
                    if (existing) {
                        if (block.blockType === 'text' && existing.block_type === 'text') {
                            // ★ text 块追加语义：渲染端 recordTextBlock 传的是「增量切片」（fullText.slice(lastOffset)），
                            //   跨 flush 时同 id text 块携带的是自上次 flush 以来的新增字符。若这里整体覆盖，
                            //   会丢掉上次 flush 已落库的旧切片（"历史正文只剩最后一个字符"的根因，05b219c 引入）。
                            //   改为追加：DB 已存内容 + 本次切片 = 完整文本。think/tool_call/tool_result 保持覆盖
                            //   （渲染端对这些块传完整内容，追加会重复）。
                            // ★ turn_index 只在 INSERT 时确定归属轮次；UPDATE 分支不得覆盖
                            //   （handleDone 重写 think 块置 complete 时 currentTurnIndex 已是末轮，
                            //    覆盖会错误地把所有 think 块标成末轮——实测 14 个 think 全变 turn 22）。
                            db.prepare('UPDATE message_blocks SET content = COALESCE(content, \'\') || ?, data = ?, timestamp = ? WHERE id = ?').run(
                                block.content ?? '', block.data, block.timestamp, block.id,
                            )
                        } else {
                            db.prepare('UPDATE message_blocks SET content = ?, data = ?, timestamp = ? WHERE id = ?').run(
                                block.content, block.data, block.timestamp, block.id,
                            )
                        }
                    } else {
                        db.prepare('INSERT INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at, turn_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
                            block.id, msgId, block.blockType, block.content, block.data, nextSeq(), block.timestamp, block.endedAt ?? null, block.turnIndex ?? null,
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
                            `${msgId}-end`, msgId, JSON.stringify({endedAt}), nextSeq(), endedAt, endedAt,
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

    /**
     * 崩溃落库缺口修补：以主进程累积的完整正文为基准，补齐 DB text 块缺失的尾部。
     *
     * 背景：流式落库主责在渲染进程（块级增量，最多滞后 30s），渲染进程崩溃时
     * 未 flush 的增量永久丢失；主进程保险丝 #mergeAndPersist 发现 DB 已有 blocks
     * 时只补 endedAt。本方法让保险丝在 isFinal 时能修复内容缺口：
     * - DB text 总长 < fullText 长度 → 对 MAX(sequence) 的 text 块追加尾部
     * - 无任何 text 块（如仅 think 块已落库）→ 插入完整 text 块（id 规范 text-${msgId}-${offset}）
     * - 已完整 / DB 反超 → 不动（幂等 + 防覆盖，绝不 DELETE 已有块）
     *
     * @returns true = 处理成功（含无需修补）；false = 消息行不存在等不可修补场景
     */
    repairTextTail(msgId: string, fullText: string): boolean {
        try {
            const db = getDatabase()
            const row = db.prepare(
                "SELECT COALESCE(SUM(LENGTH(content)), 0) AS len FROM message_blocks WHERE message_id = ? AND block_type = 'text'"
            ).get(msgId) as {len: number}
            const dbTextLen = row?.len ?? 0
            if (!fullText || fullText.length <= dbTextLen) return true

            // 消息行必须存在（blocks 有外键引用；无行说明该消息从未落库，交给全量写路径）
            const msgRow = db.prepare('SELECT id FROM messages WHERE id = ?').get(msgId)
            if (!msgRow) return false

            const tail = fullText.slice(dbTextLen)
            const lastTextBlock = db.prepare(
                "SELECT id FROM message_blocks WHERE message_id = ? AND block_type = 'text' ORDER BY sequence DESC LIMIT 1"
            ).get(msgId) as {id: string} | undefined

            if (lastTextBlock) {
                // 追加语义与 writeBlockDelta 的 text 分支一致：COALESCE 防旧块 content 为 NULL
                db.prepare("UPDATE message_blocks SET content = COALESCE(content, '') || ?, timestamp = ? WHERE id = ?")
                    .run(tail, Date.now(), lastTextBlock.id)
            } else {
                const seq = (db.prepare('SELECT COALESCE(MAX(sequence), -1) + 1 AS s FROM message_blocks WHERE message_id = ?').get(msgId) as {s: number}).s
                db.prepare(
                    'INSERT INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp) VALUES (?, ?, ?, ?, NULL, ?, ?)'
                ).run(`text-${msgId}-${dbTextLen}`, msgId, 'text', tail, seq, Date.now())
            }
            db.prepare('UPDATE conversations SET updated_at = ? WHERE id = (SELECT conversation_id FROM messages WHERE id = ?)')
                .run(Date.now(), msgId)
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteConversationRepository] repairTextTail failed:', err)
            return false
        }
    }

    /**
     * 崩溃恢复（§4.2）：未 finalize 的 assistant 消息补 end 块 + abnormalTermination 标记。
     * 复用 writeBlockDelta finalize 分支的 end 块规则（:302-313）：end 恒为当前最大 sequence。
     * 幂等：已有 end 块则跳过（ENDED_AT 已设置的消息由调用方 SQL 过滤，双保险）。
     */
    finalizeAbnormal(convId: string, msgId: string, endedAt: number): boolean {
        try {
            const db = getDatabase()
            db.transaction(() => {
                const msgRow = db.prepare('SELECT metadata FROM messages WHERE id = ? AND conversation_id = ?').get(msgId, convId) as {metadata: string | null} | undefined
                if (!msgRow) throw new Error(`finalizeAbnormal: 消息行不存在 msg=${msgId}`)
                const endBlock = db.prepare("SELECT id FROM message_blocks WHERE message_id = ? AND block_type = 'end'").get(msgId) as {id: string} | undefined
                if (!endBlock) {
                    const seq = (db.prepare('SELECT COALESCE(MAX(sequence), -1) + 1 AS s FROM message_blocks WHERE message_id = ?').get(msgId) as {s: number}).s
                    db.prepare("INSERT INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at) VALUES (?, ?, 'end', NULL, ?, ?, ?, ?)")
                        .run(`${msgId}-end`, msgId, JSON.stringify({endedAt}), seq, endedAt, endedAt)
                }
                const meta = {...JSON.parse(msgRow.metadata || '{}'), abnormalTermination: true}
                db.prepare('UPDATE messages SET ended_at = ?, metadata = ? WHERE id = ?').run(endedAt, JSON.stringify(meta), msgId)
            })()
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteConversationRepository] finalizeAbnormal failed:', err)
            return false
        }
    }

    /** §4.2 恢复扫描：未 finalize 的 assistant 消息 id 列表 */
    listUnfinalized(convId: string): Array<{id: string}> {
        try {
            return getDatabase().prepare(
                "SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' AND ended_at IS NULL"
            ).all(convId) as Array<{id: string}>
        } catch (err) {
            console.error('[SqliteConversationRepository] listUnfinalized failed:', err)
            return []
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
            const blockStmt = db.prepare('INSERT INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at, turn_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')

            for (const msg of remaining) {
                const {messages: [msgRecord], blocks} = messageToBlocks(msg, convId)
                const llmStats = msg.llmStats ? JSON.stringify(msg.llmStats) : null

                msgStmt.run(msgRecord.id, convId, msgRecord.role, msgRecord.timestamp, msgRecord.endedAt ?? null, JSON.stringify(msgRecord.metadata), llmStats)

                db.prepare('DELETE FROM message_blocks WHERE message_id = ?').run(msgRecord.id)
                for (const block of blocks) {
                    blockStmt.run(block.id, block.messageId, block.blockType, block.content, block.data, block.sequence, block.timestamp, block.endedAt ?? null, block.turnIndex ?? null)
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
            `SELECT id, message_id, block_type, content, data, sequence, timestamp, ended_at, turn_index
             FROM message_blocks WHERE message_id IN (${msgIds.map(() => '?').join(',')})
             ORDER BY message_id, sequence ASC`
        ).all(...msgIds) as Array<{
            id: string; message_id: string; block_type: string; content: string | null; data: string | null;
            sequence: number; timestamp: number; ended_at: number | null; turn_index: number | null
        }>

        const blocksByMsg = new Map<string, typeof blocksRows>()
        for (const row of blocksRows) {
            if (!blocksByMsg.has(row.message_id)) blocksByMsg.set(row.message_id, [])
            blocksByMsg.get(row.message_id)!.push(row)
        }

        // ── B1：按 message_id 批量查 llm_usage（新数据唯一源）──
        // 消息加载时统一组装 Message.llmStats：历史 parse llm_stats 列 + 新数据追加 llm_usage 行。
        // 复用 idx_llm_usage_message 索引，会话级一次查询，组装语义与 readUsageRaw 双源合并一致
        // （历史在前、llm_usage 新数据在后）。
        const usageByMsg = new Map<string, LlmStats[]>()
        try {
            const usageRows = db.prepare(
                `SELECT message_id, provider_type, model, provider_name, input_tokens, output_tokens,
                        cache_read_tokens, cache_write_tokens, reasoning_tokens, ttft_ms, decode_ms, duration_ms
                 FROM llm_usage WHERE message_id IN (${msgIds.map(() => '?').join(',')})
                 ORDER BY created_at ASC`
            ).all(...msgIds) as Array<{
                message_id: string; provider_type: string; model: string; provider_name: string | null;
                input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
                reasoning_tokens: number; ttft_ms: number | null; decode_ms: number | null; duration_ms: number
            }>
            for (const row of usageRows) {
                const list = usageByMsg.get(row.message_id) ?? []
                list.push({
                    inputTokens: row.input_tokens,
                    outputTokens: row.output_tokens,
                    provider: row.provider_type,   // LlmStats.provider 存精确服务商类型（与 readUsageRaw 一致）
                    model: row.model,
                    providerName: row.provider_name ?? undefined,
                    duration: row.duration_ms,
                    cacheReadTokens: row.cache_read_tokens > 0 ? row.cache_read_tokens : undefined,
                    cacheWriteTokens: row.cache_write_tokens > 0 ? row.cache_write_tokens : undefined,
                    reasoningTokens: row.reasoning_tokens > 0 ? row.reasoning_tokens : undefined,
                    ttftMs: row.ttft_ms ?? undefined,
                    decodeMs: row.decode_ms ?? undefined,
                })
                usageByMsg.set(row.message_id, list)
            }
        } catch (err) {
            // 单次组装失败不阻塞消息加载：llm_usage 行缺失时消息保持 llm_stats 列原样
            console.error('[SqliteConversationRepository] buildMessagesFromRows llm_usage query failed:', err)
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
            // B1：llm_usage 新数据追加在 llm_stats 历史数据之后（历史在前、新数据在后，与 readUsageRaw 语义一致）
            const newStats = usageByMsg.get(row.id)
            if (newStats && newStats.length > 0) {
                message.llmStats = [...(message.llmStats ?? []), ...newStats]
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
                turnIndex: b.turn_index ?? undefined,
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
                'SELECT id, role, timestamp, ended_at, metadata, llm_stats, is_partial FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT ?'
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
                'SELECT id, role, timestamp, ended_at, metadata, llm_stats, is_partial FROM messages WHERE conversation_id = ? AND timestamp < ? ORDER BY timestamp DESC, rowid DESC LIMIT ?'
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

            // ── 新数据源：llm_usage 表（唯一写入源，按会话聚合） ──
            const usageRows = db.prepare(
                `SELECT conversation_id, provider_type, model, provider_name, input_tokens, output_tokens,
                        cache_read_tokens, cache_write_tokens, reasoning_tokens, ttft_ms, decode_ms, duration_ms
                 FROM llm_usage WHERE conversation_id IN (${placeholders})`
            ).all(...params) as Array<{
                conversation_id: string; provider_type: string; model: string; provider_name: string | null;
                input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
                reasoning_tokens: number; ttft_ms: number | null; decode_ms: number | null; duration_ms: number;
            }>

            // provider_name 同组兜底：历史行（加列前写入）为 NULL，用同 model+provider_type 的非 NULL 值补（数据驱动，同一 model 归属稳定）
            const providerNameByGroup = new Map<string, string>()
            for (const row of usageRows) {
                if (row.provider_name) {
                    const gk = `${row.model}\u0000${row.provider_type}`
                    if (!providerNameByGroup.has(gk)) providerNameByGroup.set(gk, row.provider_name)
                }
            }

            for (const row of usageRows) {
                const list = llmStatsByConv.get(row.conversation_id) ?? []
                list.push({
                    inputTokens: row.input_tokens,
                    outputTokens: row.output_tokens,
                    provider: row.provider_type,   // LlmStats.provider 存精确服务商类型（B1 组装后渲染端无感）
                    model: row.model,
                    providerName: row.provider_name ?? providerNameByGroup.get(`${row.model}\u0000${row.provider_type}`),
                    duration: row.duration_ms,
                    cacheReadTokens: row.cache_read_tokens > 0 ? row.cache_read_tokens : undefined,
                    cacheWriteTokens: row.cache_write_tokens > 0 ? row.cache_write_tokens : undefined,
                    reasoningTokens: row.reasoning_tokens > 0 ? row.reasoning_tokens : undefined,
                    ttftMs: row.ttft_ms ?? undefined,
                    decodeMs: row.decode_ms ?? undefined,
                })
                llmStatsByConv.set(row.conversation_id, list)
            }

            // ── 历史数据归一化：llm_stats 列的 provider 可能是方案名（旧版本 currentSchemeName || currentProvider），
            //    用 llm_usage 表的 model → provider_type 精确映射覆盖（同一 model 的 provider 归属稳定，数据驱动） ──
            const KNOWN_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'ollama', 'custom'])
            const modelProviderMap = new Map<string, string>()
            for (const row of usageRows) {
                if (!modelProviderMap.has(row.model)) modelProviderMap.set(row.model, row.provider_type)
            }
            if (modelProviderMap.size > 0) {
                for (const list of llmStatsByConv.values()) {
                    for (const s of list) {
                        if (s.provider && !KNOWN_PROVIDERS.has(s.provider)) {
                            const exact = modelProviderMap.get(s.model)
                            if (exact) s.provider = exact
                        }
                    }
                }
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
            // 级联清理各会话的任务批次与任务（task_batches / tasks）
            for (const id of ids) deleteByConversation(id)
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
