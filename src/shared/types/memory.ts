// src/shared/types/memory.ts

/** 记忆 pre-step 跨轮状态 */
export interface MemoryState {
  lastMemoryDigest: string | null
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
