import {getDatabase, saveDatabase} from './index'

export class SqliteSystemSettingsRepository {
    /**
     * 获取系统配置
     */
    get(key: string): string | null {
        try {
            const db = getDatabase()
            const stmt = db.prepare('SELECT value FROM system_settings WHERE key = ?')
            const row = stmt.get(key) as { value: string } | undefined
            return row?.value ?? null
        } catch (err) {
            console.error('[SqliteSystemSettingsRepository] get failed:', err)
            return null
        }
    }

    /**
     * 获取系统配置（解析为 JSON）
     */
    getJson<T>(key: string): T | null {
        const value = this.get(key)
        if (!value) return null
        try {
            return JSON.parse(value) as T
        } catch {
            return null
        }
    }

    /**
     * 设置系统配置
     */
    set(key: string, value: string): boolean {
        try {
            const db = getDatabase()
            const stmt = db.prepare('INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)')
            stmt.run(key, value, Date.now())
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteSystemSettingsRepository] set failed:', err)
            return false
        }
    }

    /**
     * 设置系统配置（存储 JSON）
     */
    setJson<T>(key: string, value: T): boolean {
        return this.set(key, JSON.stringify(value))
    }

    /**
     * 删除系统配置
     */
    delete(key: string): boolean {
        try {
            const db = getDatabase()
            const stmt = db.prepare('DELETE FROM system_settings WHERE key = ?')
            stmt.run(key)
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteSystemSettingsRepository] delete failed:', err)
            return false
        }
    }

    /**
     * 获取所有系统配置
     */
    getAll(): Record<string, string> {
        try {
            const db = getDatabase()
            const stmt = db.prepare('SELECT key, value FROM system_settings')
            const rows = stmt.all() as Array<{ key: string; value: string }>
            const result: Record<string, string> = {}
            for (const row of rows) {
                result[row.key] = row.value
            }
            return result
        } catch (err) {
            console.error('[SqliteSystemSettingsRepository] getAll failed:', err)
            return {}
        }
    }
}

export const systemSettingsRepo = new SqliteSystemSettingsRepository()
