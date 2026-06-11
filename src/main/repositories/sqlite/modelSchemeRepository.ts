import crypto from 'crypto'
import {getDatabase, saveDatabase} from './index'
import type {ModelRole, ModelScheme, ModelSchemeRole, ModelType} from '@shared/types'

// Re-export for consumers
export type {ModelScheme, ModelSchemeRole, ModelType, ModelRole}

/** @deprecated use ModelRole */
export type ModelSchemeRoleType = ModelRole

import {createQueryLogger} from './queryLogger'

const logQuery = createQueryLogger('SqliteModelSchemeRepository')

/** 忽略元数据字段，比较角色业务字段是否相等 */
function isRoleEqual(a: ModelSchemeRole, b: ModelSchemeRole): boolean {
  return (
    a.role === b.role &&
    a.displayName === b.displayName &&
    a.description === b.description &&
    a.icon === b.icon &&
    a.endpointId === b.endpointId &&
    a.modelId === b.modelId &&
    a.modelType === b.modelType &&
    a.enabled === b.enabled &&
    a.thinkingEffort === b.thinkingEffort
  )
}

/** 脏检查：对比 scheme 及其 roles 是否有业务变更 */
function isSchemeEqual(a: ModelScheme | null, b: ModelScheme): boolean {
  if (!a) return false
  if (a.name !== b.name || a.description !== b.description || a.enabled !== b.enabled) return false
  if (a.roles.length !== b.roles.length) return false
  return b.roles.every(role => {
    const existing = a.roles.find(r => r.id === role.id)
    return existing && isRoleEqual(existing, role)
  })
}

/** 计算角色差异：返回 toUpsert（新增/变更）、toDelete（需移除） */
function diffRoles(
  existingRoles: ModelSchemeRole[] | undefined,
  newRoles: ModelSchemeRole[]
): { toUpsert: ModelSchemeRole[]; toDelete: string[] } {
  const existingMap = new Map((existingRoles || []).map(r => [r.id, r]))
  const newIds = new Set(newRoles.map(r => r.id))

  return {
    toUpsert: newRoles.filter(role => {
      const existing = existingMap.get(role.id)
      return !existing || !isRoleEqual(existing, role)
    }),
    toDelete: [...existingMap.keys()].filter(id => !newIds.has(id)),
  }
}

export class SqliteModelSchemeRepository {
  /**
   * List all roles for a given scheme
   */
  listRolesBySchemeId(schemeId: string): ModelSchemeRole[] {
    const start = Date.now()
    try {
      const db = getDatabase()
      const stmt = db.prepare(`
        SELECT id, scheme_id, role, display_name, description, icon, endpoint_id, model_id, model_type, enabled, thinking_effort
        FROM model_scheme_roles
        WHERE scheme_id = ?
        ORDER BY created_at ASC
      `)
      const rows = stmt.all(schemeId) as Array<{
        id: string
        scheme_id: string
        role: string
        display_name: string | null
        description: string | null
        icon: string | null
        endpoint_id: string
        model_id: string
        model_type: string
        enabled: number
          thinking_effort: string | null
      }>
      const roles = rows.map(row => ({
        id: row.id,
        role: row.role as ModelSchemeRoleType,
        displayName: row.display_name || undefined,
        description: row.description || undefined,
        icon: row.icon || undefined,
        endpointId: row.endpoint_id,
        modelId: row.model_id,
        modelType: row.model_type as ModelType,
        enabled: row.enabled === 1,
          ...(row.thinking_effort ? {thinkingEffort: row.thinking_effort as 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'} : {}),
      }))
      logQuery('listRolesBySchemeId', start, `${roles.length} roles for scheme ${schemeId}`)
      return roles
    } catch (err) {
      console.error('[SqliteModelSchemeRepository] listRolesBySchemeId failed:', err)
      return []
    }
  }

  /**
   * List all model schemes with their roles
   */
  list(): ModelScheme[] {
    const start = Date.now()
    try {
      const db = getDatabase()
      const stmt = db.prepare(`
        SELECT id, name, description, enabled, created_at, updated_at
        FROM model_schemes
        ORDER BY created_at ASC
      `)
      const rows = stmt.all() as Array<{
        id: string
        name: string
        description: string | null
        enabled: number
        created_at: number
        updated_at: number
      }>
      const schemes = rows.map(row => {
        const roles = this.listRolesBySchemeId(row.id)
        return {
          id: row.id,
          name: row.name,
          description: row.description ?? undefined,
          enabled: row.enabled === 1,
          roles,
        }
      })
      logQuery('list', start, `${schemes.length} schemes`)
      return schemes
    } catch (err) {
      console.error('[SqliteModelSchemeRepository] list failed:', err)
      return []
    }
  }

  /**
   * Get a scheme by ID with its roles
   */
  getById(id: string): ModelScheme | null {
    const start = Date.now()
    try {
      const db = getDatabase()
      const stmt = db.prepare(`
        SELECT id, name, description, enabled, created_at, updated_at
        FROM model_schemes
        WHERE id = ?
      `)
      const row = stmt.get(id) as {
        id: string
        name: string
        description: string | null
        enabled: number
        created_at: number
        updated_at: number
      } | undefined
      if (!row) return null

      const roles = this.listRolesBySchemeId(row.id)
      logQuery('getById', start, id)
      return {
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
        enabled: row.enabled === 1,
        roles,
      }
    } catch (err) {
      console.error('[SqliteModelSchemeRepository] getById failed:', err)
      return null
    }
  }

  /**
   * Save a scheme with incremental upsert (B+C 优化：跳过无变更 + 增量写入)
   *
   * 优化策略：
   * - C: 先检查 scheme 是否有变化，无变化则跳过
   * - B: 用 INSERT ... ON CONFLICT DO UPDATE 替代 DELETE + INSERT
   */
  save(scheme: ModelScheme): boolean {
    const start = Date.now()
    try {
      const db = getDatabase()
      const now = Date.now()

      // C: 检查是否有变化，无变化则跳过
      const existing = this.getById(scheme.id)
      if (existing && isSchemeEqual(existing, scheme)) {
        logQuery('save', start, `skipped (no changes) ${scheme.id}`)
        return true
      }

      // INSERT or UPDATE model_schemes
      if (existing) {
        const stmt = db.prepare(`
          UPDATE model_schemes
          SET name = ?, description = ?, enabled = ?, updated_at = ?
          WHERE id = ?
        `)
        stmt.run(
          scheme.name,
          scheme.description ?? null,
          scheme.enabled ? 1 : 0,
          now,
          scheme.id
        )
      } else {
        const stmt = db.prepare(`
          INSERT INTO model_schemes (id, name, description, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        stmt.run(
          scheme.id,
          scheme.name,
          scheme.description ?? null,
          scheme.enabled ? 1 : 0,
          now,
          now
        )
      }

      // 计算角色差异，delete + upsert 在同一事务中保证一致性
      const { toUpsert, toDelete } = diffRoles(existing?.roles, scheme.roles)

      if (toDelete.length > 0 || toUpsert.length > 0) {
        db.exec('BEGIN TRANSACTION')
        try {
          if (toDelete.length > 0) {
            const placeholders = toDelete.map(() => '?').join(', ')
            db.prepare(`DELETE FROM model_scheme_roles WHERE id IN (${placeholders})`).run(...toDelete)
          }

          const roleStmt = db.prepare(`
            INSERT INTO model_scheme_roles (id, scheme_id, role, display_name, description, icon, endpoint_id, model_id, model_type, enabled, thinking_effort, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              scheme_id = excluded.scheme_id,
              role = excluded.role,
              display_name = excluded.display_name,
              description = excluded.description,
              icon = excluded.icon,
              endpoint_id = excluded.endpoint_id,
              model_id = excluded.model_id,
              model_type = excluded.model_type,
              enabled = excluded.enabled,
              thinking_effort = excluded.thinking_effort,
              updated_at = excluded.updated_at
          `)
          for (const role of toUpsert) {
            const roleId = role.id || crypto.randomUUID()
            roleStmt.run(
              roleId, scheme.id, role.role,
              role.displayName ?? null, role.description ?? null, role.icon ?? null,
              role.endpointId, role.modelId,
              role.modelType, role.enabled ? 1 : 0, role.thinkingEffort ?? null,
              now, now,
            )
          }
          db.exec('COMMIT')
        } catch (err) {
          db.exec('ROLLBACK')
          console.error('[SqliteModelSchemeRepository] role update failed, rolling back:', err)
          throw err
        }
      }

      saveDatabase()
      logQuery('save', start, scheme.id)
      return true
    } catch (err) {
      console.error('[SqliteModelSchemeRepository] save failed:', err)
      return false
    }
  }

  /**
   * Delete a scheme and its roles (cascade via FK)
   */
  delete(id: string): boolean {
    const start = Date.now()
    try {
      const db = getDatabase()
      // Delete roles first (or rely on CASCADE)
      db.prepare('DELETE FROM model_scheme_roles WHERE scheme_id = ?').run(id)
      db.prepare('DELETE FROM model_schemes WHERE id = ?').run(id)
      saveDatabase()
      logQuery('delete', start, id)
      return true
    } catch (err) {
      console.error('[SqliteModelSchemeRepository] delete failed:', err)
      return false
    }
  }
}

// Singleton instance
export const modelSchemeRepo = new SqliteModelSchemeRepository()
