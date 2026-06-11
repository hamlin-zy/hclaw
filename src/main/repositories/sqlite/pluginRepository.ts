import {getDatabase, saveDatabase} from './index'

export interface Plugin {
    name: string
    path: string
    enabled: boolean
}

import {createQueryLogger} from './queryLogger'

const logQuery = createQueryLogger('SQLite PluginRepository')

export class SqlitePluginRepository {
    /**
     * 获取所有插件
     */
    list(): Plugin[] {
        const start = Date.now()
        try {
            const db = getDatabase()
            const stmt = db.prepare('SELECT name, path, enabled FROM plugins ORDER BY name ASC')
            const rows = stmt.all() as Array<{ name: string; path: string; enabled: number }>
            const plugins = rows.map(row => ({
                name: row.name,
                path: row.path,
                enabled: row.enabled === 1,
            }))
            logQuery('list', start, `${plugins.length} plugins`)
            return plugins
        } catch (err) {
            console.error('[SqlitePluginRepository] list failed:', err)
            return []
        }
    }

    /**
     * 根据名称获取插件
     */
    getByName(name: string): Plugin | null {
        const start = Date.now()
        try {
            const db = getDatabase()
            const stmt = db.prepare('SELECT name, path, enabled FROM plugins WHERE name = ?')
            const row = stmt.get(name) as { name: string; path: string; enabled: number } | undefined
            if (!row) return null
            return {
                name: row.name,
                path: row.path,
                enabled: row.enabled === 1,
            }
        } catch (err) {
            console.error('[SqlitePluginRepository] getByName failed:', err)
            return null
        }
    }

    /**
     * 保存所有插件（批量替换）
     */
    save(plugins: Plugin[]): boolean {
        const start = Date.now()
        try {
            const db = getDatabase()
            const now = Date.now()

            // 清空现有数据
            db.exec('DELETE FROM plugins')

            const stmt = db.prepare(`
        INSERT INTO plugins (name, path, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `)

            for (const plugin of plugins) {
                stmt.run(plugin.name, plugin.path, plugin.enabled ? 1 : 0, now, now)
            }

            saveDatabase()
            logQuery('save', start, `${plugins.length} plugins`)
            return true
        } catch (err) {
            console.error('[SqlitePluginRepository] save failed:', err)
            return false
        }
    }

    /**
     * 清理数据库中路径为空的无效记录（旧名字残留或安装失败的占位记录）
     */
    cleanup(): void {
        try {
            const db = getDatabase()
            const stmt = db.prepare(`DELETE FROM plugins WHERE path IS NULL OR path = ''`)
            const result = stmt.run()
            if (result.changes > 0) {
                console.log(`[SqlitePluginRepository.cleanup] removed ${result.changes} stale entries`)
                saveDatabase()
            }
        } catch (err) {
            console.error('[SqlitePluginRepository.cleanup] failed:', err)
        }
    }

    /**
     * 设置插件启用/禁用状态
     */
    setEnabled(name: string, enabled: boolean): boolean {
        const start = Date.now()
        try {
            const db = getDatabase()
            const now = Date.now()
            const stmt = db.prepare('UPDATE plugins SET enabled = ?, updated_at = ? WHERE name = ?')
            stmt.run(enabled ? 1 : 0, now, name)
            saveDatabase()
            logQuery('setEnabled', start)
            return true
        } catch (err) {
            console.error('[SqlitePluginRepository] setEnabled failed:', err)
            return false
        }
    }
}

export const pluginRepo = new SqlitePluginRepository()
