import type {
  ConversationMeta,
  ConversationWithStats,
  LlmStats,
  Message,
  MessageBlock,
  PermissionRule
} from '@shared/types'

// ─── Message Block Repository ─────────────────────────────────

export interface IMessageBlockRepository {
  writeBlock(convId: string, block: MessageBlock): void

  updateBlock(blockId: string, updates: Partial<MessageBlock>): void

  readBlocksByMessage(messageId: string): MessageBlock[]

  deleteBlocksByMessage(messageId: string): void
}

// ─── Conversation Repository ───────────────────────────────────

export interface IConversationRepository {
  create(convId: string, meta: ConversationMeta): boolean

  readMeta(convId: string): ConversationMeta | null

  updateMeta(convId: string, updates: Partial<ConversationMeta>): boolean

  readMessages(convId: string): Message[]

    /** 加载最近 N 条消息，返回消息列表和总条数（用于判断 hasMore） */
    readMessagesTail(convId: string, count: number): { messages: Message[]; totalCount: number }

    /** 加载某条消息之前的 N 条消息（按 timestamp 降序取，返回升序排列） */
    readMessagesBefore(convId: string, beforeTimestamp: number, count: number): {
        messages: Message[];
        totalCount: number
    }

  writeMessages(convId: string, messages: Message[]): boolean

    /**
     * 增量写入单条消息（UPSERT messages + 重建该消息的 blocks）。
     * 相比 writeMessages 的全量重写，只影响一条消息，IPC 传输和 DB 写入量都小得多，
     * 且单事务原子（断电时该消息要么完整、要么不存在，不会半写）。
     */
    writeMessagesDelta(convId: string, message: Message): boolean

  setMessageEnded(convId: string, messageId: string, endedAt: number): boolean

  /** 更新消息的 LLM 统计信息 */
  updateMessageLlmStats(convId: string, messageId: string, llmStats: LlmStats[]): boolean

  delete(convId: string): boolean

  deleteMessage(convId: string, messageId: string): boolean

  list(): ConversationMeta[]

  listByWorkspace(workspacePath: string): ConversationMeta[]

    /** 查询所有会话及统计信息（消息数、block 数） */
    listWithStats(workspacePath: string): ConversationWithStats[]

    /** 读取多会话的 LLM 统计与工具调用计数（用量统计弹窗用，不读消息正文） */
    readUsageRaw(convIds: string[]): {
        llmStatsByConv: Map<string, LlmStats[]>;
        toolCallCountByConv: Map<string, number>;
    }

    /** 批量删除会话（事务内） */
    deleteBatch(ids: string[]): boolean

    /** 读取缓存的系统提示词（无缓存返回 null） */
    getSystemPrompt(convId: string): string | null

    /** 写入/更新缓存的系统提示词 */
    setSystemPrompt(convId: string, prompt: string): boolean
}

// ─── Config Repository ────────────────────────────────────────

export interface IConfigRepository {
  read<T = unknown>(name: string): Promise<T | null>
  write<T = unknown>(name: string, data: T): Promise<boolean>
  readDir<T = unknown>(dir: string, filename: string): Promise<T | null>
  writeDir(dir: string, filename: string, data: unknown): Promise<boolean>
  listDir(dir: string): Promise<Array<{ _filename: string } & Record<string, unknown>>>
  deleteDir(dir: string, filename: string): Promise<boolean>
}

// ─── Permission Repository ─────────────────────────────────────

export interface IPermissionRepository {
  getRules(): PermissionRule[]

  saveRules(rules: PermissionRule[]): boolean

  addRule(rule: PermissionRule): boolean

  removeRule(toolName: string): boolean
}
