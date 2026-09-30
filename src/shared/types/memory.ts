// src/shared/types/memory.ts

/** 记忆 pre-step 跨轮状态 */
export interface MemoryState {
  lastMemoryDigest: string | null
  /** 归档卷索引注入 digest（第二轮注入，与记忆 digest 各自独立门控） */
  lastArchiveIndexDigest: string | null
}

/** 加载的记忆内容 */
export interface MemoryContent {
  preferencesMd: string | null
  projectMemoryMd: string | null
  projectName: string | null
}

/** index.json 条目 */
export interface MemoryIndexEntry {
  dir: string
  projectName: string
}

/** index.json 结构 */
export type MemoryIndex = Record<string, MemoryIndexEntry>

/** .state.json 结构 */
export interface MemoryAccumulationState {
  lastAnalyzedAt: number
  lastConversationId: string
}

/** 记忆消息 metadata 标识 */
export const MEMORY_SOURCE_KIND = 'memory'
export const MEMORY_DIGEST_KEY = 'memoryDigest'
/** 归档卷索引消息额外携带的 digest 键（与记忆 digest 各自门控） */
export const ARCHIVE_INDEX_DIGEST_KEY = 'archiveIndexDigest'
