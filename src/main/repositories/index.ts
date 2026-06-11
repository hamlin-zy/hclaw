import {SqliteConversationRepository} from './sqlite/conversationRepository'
import {SqlitePermissionRepository} from './sqlite/permissionRepository'
import {FileConfigRepository} from './sqlite/configRepository'
import {SqliteMessageBlockRepository} from './sqlite/messageBlockRepository'
// SqliteMcpRepository removed - MCP config migrated to file system (mcp.json)
import {SqlitePluginRepository} from './sqlite/pluginRepository'
import {SqliteAccountRepository} from './sqlite/accountRepository'
import {SqliteProviderModelRepository, SqliteProviderRepository} from './sqlite/llmProviderRepository'
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

/**
 * Create an account repository instance (SQLite only).
 */
export function createAccountRepository() {
  return new SqliteAccountRepository()
}

/**
 * Create a provider repository instance (SQLite only).
 */
export function createProviderRepository() {
  return new SqliteProviderRepository()
}

/**
 * Create a provider model repository instance (SQLite only).
 */
export function createProviderModelRepository() {
  return new SqliteProviderModelRepository()
}

// Re-export types for convenience
export type { IConversationRepository, IConfigRepository, IPermissionRepository, IMessageBlockRepository } from './interfaces'
export type { LLMProvider, LLMProviderWithModels, ProviderModel } from './sqlite/llmProviderRepository'
