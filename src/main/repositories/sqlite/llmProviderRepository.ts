import {getDatabase, saveDatabase} from './index'
import type {AuthType, LLMProvider, ModelType, ProviderCredentials, ProviderModel, ProviderType} from '@shared/types'

// Re-export for consumers
export type {LLMProvider, ProviderCredentials, ProviderModel, ModelType, ProviderType, AuthType}

/** Repository 层模型记录（包含 DB 列） */
export interface SqlProviderModel {
  id: string
  providerId: string
  modelName: string
  modelType: ModelType
  enabled: boolean
}

export interface LLMProviderWithModels extends LLMProvider {
  models: ProviderModel[]
}

import {createQueryLogger} from './queryLogger'

// ─── 辅助函数 ─────────────────────────────────────────────

const logQuery = createQueryLogger('SQLite ProviderRepository')

/** 将数据库行映射为 LLMProvider 对象 */
const mapRowToProvider = (row: Record<string, unknown>): LLMProvider => {
    const credentials = JSON.parse((row.credentials as string) || '{}')
    const features = JSON.parse((row.features as string) || '{}')
    return {
        id: row.id as string,
        name: row.name as string,
        type: row.type as ProviderType,
        authType: row.auth_type as AuthType,
        baseUrl: row.base_url as string,
        credentials,
        features: Object.keys(features).length > 0 ? features : undefined,
        email: row.email as string,
        enabled: row.enabled === 1,
        models: [],
        apiKey: credentials.apiKey || undefined,
    }
}

export class SqliteProviderRepository {
  /**
   * 获取所有 Provider（不含模型）
   */
  list(): LLMProvider[] {
    const start = Date.now()
    try {
      const db = getDatabase()
      const stmt = db.prepare(`
        SELECT id, name, type, auth_type, base_url, credentials, features, email, enabled
        FROM providers
        ORDER BY created_at ASC
      `)
      const rows = stmt.all() as Array<{
        id: string
        name: string
        type: string
        auth_type: string
        base_url: string
        credentials: string
        email: string
        enabled: number
      }>
        const providers = rows.map(mapRowToProvider)
      logQuery('list', start, `${providers.length} providers`)
      return providers
    } catch (err) {
      console.error('[SqliteProviderRepository] list failed:', err)
      return []
    }
  }

  /**
   * 根据 ID 获取 Provider
   */
  getById(id: string): LLMProvider | null {
    const start = Date.now()
    try {
      const db = getDatabase()
      const stmt = db.prepare(`
        SELECT id, name, type, auth_type, base_url, credentials, features, email, enabled
        FROM providers
        WHERE id = ?
      `)
      const row = stmt.get(id) as {
        id: string
        name: string
        type: string
        auth_type: string
        base_url: string
        credentials: string
        features: string
        email: string
        enabled: number
      } | undefined
      if (!row) return null
        return mapRowToProvider(row)
    } catch (err) {
      console.error('[SqliteProviderRepository] getById failed:', err)
      return null
    }
  }

  /**
   * 根据名称获取 Provider
   */
  getByName(name: string): LLMProvider | null {
    const start = Date.now()
    try {
      const db = getDatabase()
      const stmt = db.prepare(`
        SELECT id, name, type, auth_type, base_url, credentials, features, email, enabled
        FROM providers
        WHERE name = ?
      `)
      const row = stmt.get(name) as {
        id: string
        name: string
        type: string
        auth_type: string
        base_url: string
        credentials: string
        features: string
        email: string
        enabled: number
      } | undefined
      if (!row) return null
        return mapRowToProvider(row)
    } catch (err) {
      console.error('[SqliteProviderRepository] getByName failed:', err)
      return null
    }
  }

  /**
   * 保存 Provider（新增或更新）
   */
  save(provider: LLMProvider): boolean {
    const start = Date.now()
    try {
      const db = getDatabase()
      const now = Date.now()

      // 检查是否存在
      const existing = this.getById(provider.id)
      if (existing) {
        // 更新
        const stmt = db.prepare(`
          UPDATE providers
          SET name = ?, type = ?, auth_type = ?, base_url = ?, credentials = ?,
              features = ?, email = ?, enabled = ?, updated_at = ?
          WHERE id = ?
        `)
        stmt.run(
          provider.name,
          provider.type,
          provider.authType,
          provider.baseUrl,
          JSON.stringify(provider.credentials),
          JSON.stringify(provider.features || {}),
          provider.email,
          provider.enabled ? 1 : 0,
          now,
          provider.id
        )
      } else {
        // 新增
        const stmt = db.prepare(`
          INSERT INTO providers (id, name, type, auth_type, base_url, credentials,
                                  features, email, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        stmt.run(
          provider.id,
          provider.name,
          provider.type,
          provider.authType,
          provider.baseUrl,
          JSON.stringify(provider.credentials),
          JSON.stringify(provider.features || {}),
          provider.email,
          provider.enabled ? 1 : 0,
          now,
          now
        )
      }

      saveDatabase()
      logQuery('save', start, provider.id)
      return true
    } catch (err) {
      console.error('[SqliteProviderRepository] save failed:', err)
      return false
    }
  }

  /**
   * 批量保存 Providers（替换全部）
   * 使用事务确保原子性：要么全部成功，要么全部回滚
   */
  saveAll(providers: LLMProvider[]): boolean {
    const start = Date.now()
    try {
      const db = getDatabase()
      const now = Date.now()

      // 开启事务，确保全量保存的原子性
      db.exec('BEGIN TRANSACTION')
      try {
        // 只删除 providers（不再全局删除 provider_models，
        // 各 provider 的 saveByProvider 会自行处理模型删除和重建）
        db.exec('DELETE FROM providers')

        if (providers.length === 0) {
          // 清理被删除 provider 遗留的模型
          db.prepare('DELETE FROM provider_models WHERE provider_id NOT IN (SELECT id FROM providers)').run()
          db.exec('COMMIT')
          saveDatabase()
          return true
        }

        const stmt = db.prepare(`
          INSERT INTO providers (id, name, type, auth_type, base_url, credentials,
                                  features, email, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        for (const provider of providers) {
          stmt.run(
            provider.id,
            provider.name,
            provider.type,
            provider.authType || 'api-key',
            provider.baseUrl || '',
            JSON.stringify(provider.credentials || {}),
            JSON.stringify(provider.features || {}),
            provider.email || '',
            provider.enabled ? 1 : 0,
            now,
            now
          )
        }

        // 重新清理孤儿模型（刚才删除 provider 后可能新增了 providers，确保一致性）
        db.prepare('DELETE FROM provider_models WHERE provider_id NOT IN (SELECT id FROM providers)').run()

        db.exec('COMMIT')
      } catch (innerErr) {
        db.exec('ROLLBACK')
        console.error('[SqliteProviderRepository] saveAll: transaction rolled back due to:', innerErr)
        throw innerErr
      }

      saveDatabase()
      logQuery('saveAll', start, `${providers.length} providers`)
      return true
    } catch (err) {
      console.error('[SqliteProviderRepository] saveAll failed:', err)
      return false
    }
  }

  /**
   * 删除 Provider
   */
  delete(id: string): boolean {
    const start = Date.now()
    try {
      const db = getDatabase()
      // 先删除关联的模型
      db.prepare('DELETE FROM provider_models WHERE provider_id = ?').run(id)
      db.prepare('DELETE FROM providers WHERE id = ?').run(id)
      saveDatabase()
      logQuery('delete', start, id)
      return true
    } catch (err) {
      console.error('[SqliteProviderRepository] delete failed:', err)
      return false
    }
  }

  /**
   * 更新 Provider enabled 状态
   */
  setEnabled(id: string, enabled: boolean): boolean {
    const start = Date.now()
    try {
      const db = getDatabase()
      const stmt = db.prepare(`
        UPDATE providers SET enabled = ?, updated_at = ? WHERE id = ?
      `)
      stmt.run(enabled ? 1 : 0, Date.now(), id)
      saveDatabase()
      logQuery('setEnabled', start, `${id}: ${enabled}`)
      return true
    } catch (err) {
      console.error('[SqliteProviderRepository] setEnabled failed:', err)
      return false
    }
  }
}

// ─── 辅助函数 ─────────────────────────────────────────────

const SQL_MODEL_COLUMNS = 'id, provider_id, model_name, model_type, enabled'

/** 将数据库行映射为 SqlProviderModel 对象 */
const mapRowToSqlProviderModel = (row: Record<string, unknown>): SqlProviderModel => ({
    id: row.id as string,
    providerId: row.provider_id as string,
    modelName: row.model_name as string,
    modelType: row.model_type as ModelType,
    enabled: row.enabled === 1,
})

export class SqliteProviderModelRepository {
  /**
   * 获取所有模型
   */
  list(): SqlProviderModel[] {
    const start = Date.now()
    try {
      const db = getDatabase()
        const rows = db.prepare(`SELECT ${SQL_MODEL_COLUMNS}
                                 FROM provider_models
                                 ORDER BY created_at ASC`).all() as any[]
        const models = rows.map(mapRowToSqlProviderModel)
      logQuery('list', start, `${models.length} models`)
      return models
    } catch (err) {
      console.error('[SqliteProviderModelRepository] list failed:', err)
      return []
    }
  }

  /**
   * 根据 Provider ID 获取模型列表
   */
  listByProviderId(providerId: string): SqlProviderModel[] {
    const start = Date.now()
    try {
      const db = getDatabase()
        const rows = db.prepare(`SELECT ${SQL_MODEL_COLUMNS} FROM provider_models WHERE provider_id = ? ORDER BY created_at ASC`).all(providerId) as any[]
        const models = rows.map(mapRowToSqlProviderModel)
      logQuery('listByProviderId', start, `${models.length} models for ${providerId}`)
      return models
    } catch (err) {
      console.error('[SqliteProviderModelRepository] listByProviderId failed:', err)
      return []
    }
  }

  /**
   * 根据 ID 获取模型
   */
  getById(id: string): SqlProviderModel | null {
    const start = Date.now()
    try {
      const db = getDatabase()
        const row = db.prepare(`SELECT ${SQL_MODEL_COLUMNS} FROM provider_models WHERE id = ?`).get(id) as any
      if (!row) return null
        return mapRowToSqlProviderModel(row)
    } catch (err) {
      console.error('[SqliteProviderModelRepository] getById failed:', err)
      return null
    }
  }

    /**
     * 将 model 转换为 SQL 参数数组
     */
    private static toSqlParams(model: {
        id: string;
        providerId: string;
        modelName: string;
        modelType: string;
        enabled: boolean;
    }, now: number): unknown[] {
        return [model.id, model.providerId, model.modelName, model.modelType, model.enabled ? 1 : 0, now]
    }

  /**
   * 保存模型（新增或更新）
   */
  save(model: SqlProviderModel): boolean {
    const start = Date.now()
    try {
      const db = getDatabase()
      const now = Date.now()
        const params = SqliteProviderModelRepository.toSqlParams(model, now)

        if (this.getById(model.id)) {
            db.prepare(`
          UPDATE provider_models SET provider_id=?, model_name=?, model_type=?, enabled=?,
            updated_at=?
          WHERE id=?
        `).run(...params.slice(1).concat(params[0]))
      } else {
            db.prepare(`
          INSERT INTO provider_models (id,provider_id,model_name,model_type,enabled,
            created_at,updated_at)
          VALUES (?,?,?,?,?,?,?)
        `).run(...params, now)
      }

      saveDatabase()
      logQuery('save', start, model.id)
      return true
    } catch (err) {
      console.error('[SqliteProviderModelRepository] save failed:', err)
      return false
    }
  }

  /**
   * 批量保存模型（替换某 Provider 的全部模型）
   */
  saveByProviderId(providerId: string, models: SqlProviderModel[]): boolean {
    const start = Date.now()
    try {
      const db = getDatabase()
      const now = Date.now()

      db.prepare('DELETE FROM provider_models WHERE provider_id = ?').run(providerId)

      const stmt = db.prepare(`
        INSERT INTO provider_models (id,provider_id,model_name,model_type,enabled,
          created_at,updated_at)
        VALUES (?,?,?,?,?,?,?)
      `)

      for (const model of models) {
          stmt.run(...SqliteProviderModelRepository.toSqlParams(model, now), now)
      }

      saveDatabase()
      logQuery('saveByProviderId', start, `${models.length} models for ${providerId}`)
      return true
    } catch (err) {
      console.error('[SqliteProviderModelRepository] saveByProviderId failed:', err)
      return false
    }
  }

  /**
   * 删除模型
   */
  delete(id: string): boolean {
    const start = Date.now()
    try {
      const db = getDatabase()
      db.prepare('DELETE FROM provider_models WHERE id = ?').run(id)
      saveDatabase()
      logQuery('delete', start, id)
      return true
    } catch (err) {
      console.error('[SqliteProviderModelRepository] delete failed:', err)
      return false
    }
  }

  /**
   * 删除某 Provider 的所有模型
   */
  deleteByProviderId(providerId: string): boolean {
    const start = Date.now()
    try {
      const db = getDatabase()
      db.prepare('DELETE FROM provider_models WHERE provider_id = ?').run(providerId)
      saveDatabase()
      logQuery('deleteByProviderId', start, providerId)
      return true
    } catch (err) {
      console.error('[SqliteProviderModelRepository] deleteByProviderId failed:', err)
      return false
    }
  }

  /**
   * 更新模型 enabled 状态
   */
  setEnabled(id: string, enabled: boolean): boolean {
    const start = Date.now()
    try {
      const db = getDatabase()
      const stmt = db.prepare(`
        UPDATE provider_models SET enabled = ?, updated_at = ? WHERE id = ?
      `)
      stmt.run(enabled ? 1 : 0, Date.now(), id)
      saveDatabase()
      logQuery('setEnabled', start, `${id}: ${enabled}`)
      return true
    } catch (err) {
      console.error('[SqliteProviderModelRepository] setEnabled failed:', err)
      return false
    }
  }
}
