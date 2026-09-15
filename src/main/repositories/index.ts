import {SqliteConversationRepository} from './sqlite/conversationRepository'
import {SqlitePermissionRepository} from './sqlite/permissionRepository'
import {FileConfigRepository} from './sqlite/configRepository'
import {SqliteMessageBlockRepository} from './sqlite/messageBlockRepository'
// SqliteMcpRepository removed - MCP config migrated to file system (mcp.json)
import {SqlitePluginRepository} from './sqlite/pluginRepository'
import {initDatabaseSync} from './sqlite'
import type {
  IConversationRepository,
  IMessageBlockRepository,
  IPermissionRepository
} from './interfaces'

/**
 * Initialize SQLite storage backend synchronously.
 * MUST be called before any other module that uses repositories.
 * In main/index.ts, call this at the very top before any other imports.
 */
export function initStorage(): void {
  initDatabaseSync()
}

/**
 * Create a conversation repository instance (SQLite only).
 */
export function createConversationRepository(): IConversationRepository {
  return new SqliteConversationRepository()
}

/**
 * Create a config repository instance (file-based).
 */
export function createConfigRepository() {
  return new FileConfigRepository()
}

/**
 * Create a permission repository instance (SQLite only).
 */
export function createPermissionRepository(): IPermissionRepository {
  return new SqlitePermissionRepository()
}

/**
 * Create a message block repository instance (SQLite only).
 */
export function createMessageBlockRepository(): IMessageBlockRepository {
  return new SqliteMessageBlockRepository()
}

/**
 * Create a plugin repository instance (SQLite only).
 */
export function createPluginRepository() {
  return new SqlitePluginRepository()
}

// Re-export types for convenience
export type { IConversationRepository, IConfigRepository, IPermissionRepository, IMessageBlockRepository } from './interfaces'
export type { LLMProvider, LLMProviderWithModels, ProviderModel } from './sqlite/llmProviderRepository'
