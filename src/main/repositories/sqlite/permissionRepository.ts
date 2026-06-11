import { getDatabase, saveDatabase } from './index'
import type { IPermissionRepository } from '../interfaces'
import type {PermissionRule} from '@shared/types'

import {createQueryLogger} from './queryLogger'

const logQuery = createQueryLogger('SQLite PermissionRepository')

export class SqlitePermissionRepository implements IPermissionRepository {
    getRules(): PermissionRule[] {
        const start = Date.now()
    try {
        const db = getDatabase()
        const stmt = db.prepare('SELECT tool, action, created_at FROM permission_rules')
        const rows = stmt.all() as Array<{ tool: string, action: 'allow' | 'deny' | 'ask', created_at: number }>
        const rules = rows.map(row => ({
            tool: row.tool,
            action: row.action,
            createdAt: row.created_at,
      }))
        logQuery('getRules', start, `${rules.length} rules`)
        return rules
    } catch (err) {
        // 数据库未初始化时返回空规则，不阻塞启动
        if ((err as Error).message.includes('not initialized')) {
            return []
        }
      console.error('[SqlitePermissionRepository] getRules failed:', err)
      return []
    }
  }

    saveRules(rules: PermissionRule[]): boolean {
        const start = Date.now()
    try {
        const db = getDatabase()
        db.exec('DELETE FROM permission_rules')
        const stmt = db.prepare('INSERT INTO permission_rules (tool, action, created_at) VALUES (?, ?, ?)')
      for (const rule of rules) {
          stmt.run(rule.tool, rule.action, rule.createdAt ?? Date.now())
      }
      saveDatabase()
        logQuery('saveRules', start, `${rules.length} rules`)
      return true
    } catch (err) {
      console.error('[SqlitePermissionRepository] saveRules failed:', err)
      return false
    }
  }

    addRule(rule: PermissionRule): boolean {
        const start = Date.now()
    try {
        const db = getDatabase()
        const stmt = db.prepare('INSERT OR REPLACE INTO permission_rules (tool, action, created_at) VALUES (?, ?, ?)')
        stmt.run(rule.tool, rule.action, rule.createdAt ?? Date.now())
      saveDatabase()
        logQuery('addRule', start)
      return true
    } catch (err) {
      console.error('[SqlitePermissionRepository] addRule failed:', err)
      return false
    }
  }

    removeRule(toolName: string): boolean {
    if (!toolName || typeof toolName !== 'string' || toolName.trim() === '') {
      console.error('[SqlitePermissionRepository] removeRule failed: invalid toolName')
      return false
    }
        const start = Date.now()
    try {
        const db = getDatabase()
        const stmt = db.prepare('DELETE FROM permission_rules WHERE tool = ?')
        stmt.run(toolName)
      saveDatabase()
        logQuery('removeRule', start)
      return true
    } catch (err) {
      console.error('[SqlitePermissionRepository] removeRule failed:', err)
      return false
    }
  }
}
