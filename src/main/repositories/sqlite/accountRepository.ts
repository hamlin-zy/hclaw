import {getDatabase, saveDatabase} from './index'
import {createQueryLogger} from './queryLogger'

export interface Account {
    id: string
    name: string
    type: string
    remark: string
    url: string
    username: string
    passwd: string
    encrypted: boolean
    createdAt?: number
    updatedAt?: number
}

const logQuery = createQueryLogger('SQLite AccountRepository')

export class SqliteAccountRepository {
    /**
     * 获取所有账户
     */
    list(): Account[] {
        const start = Date.now()
        try {
            const db = getDatabase()
            const stmt = db.prepare(`
        SELECT id, name, type, remark, url, username, passwd, encrypted,
               created_at, updated_at
        FROM accounts
        ORDER BY name ASC
      `)
            const rows = stmt.all() as Array<{
                id: string
                name: string
                type: string
                remark: string
                url: string
                username: string
                passwd: string
                encrypted: number
                created_at: number
                updated_at: number
            }>
            const accounts = rows.map(row => ({
                id: row.id,
                name: row.name,
                type: row.type,
                remark: row.remark,
                url: row.url,
                username: row.username,
                passwd: row.passwd,
                encrypted: row.encrypted === 1,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            }))
            logQuery('list', start, `${accounts.length} accounts`)
            return accounts
        } catch (err) {
            console.error('[SqliteAccountRepository] list failed:', err)
            return []
        }
    }

    /**
     * 根据 ID 获取账户
     */
    getById(id: string): Account | null {
        const start = Date.now()
        try {
            const db = getDatabase()
            const stmt = db.prepare(`
        SELECT id, name, type, remark, url, username, passwd, encrypted,
               created_at, updated_at
        FROM accounts
        WHERE id = ?
      `)
            const row = stmt.get(id) as {
                id: string
                name: string
                type: string
                remark: string
                url: string
                username: string
                passwd: string
                encrypted: number
                created_at: number
                updated_at: number
            } | undefined
            if (!row) return null
            return {
                id: row.id,
                name: row.name,
                type: row.type,
                remark: row.remark,
                url: row.url,
                username: row.username,
                passwd: row.passwd,
                encrypted: row.encrypted === 1,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            }
        } catch (err) {
            console.error('[SqliteAccountRepository] getById failed:', err)
            return null
        }
    }

    /**
     * 保存所有账户（批量替换）
     */
    save(accounts: Account[]): boolean {
        const start = Date.now()
        try {
            const db = getDatabase()
            const now = Date.now()

            // 清空现有数据
            db.exec('DELETE FROM accounts')

            const stmt = db.prepare(`
        INSERT INTO accounts (id, name, type, remark, url, username, passwd,
                             encrypted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

            for (const account of accounts) {
                stmt.run(
                    account.id,
                    account.name,
                    account.type,
                    account.remark || '',
                    account.url || '',
                    account.username || '',
                    account.passwd || '',
                    account.encrypted ? 1 : 0,
                    account.createdAt || now,
                    account.updatedAt || now
                )
            }

            saveDatabase()
            logQuery('save', start, `${accounts.length} accounts`)
            return true
        } catch (err) {
            console.error('[SqliteAccountRepository] save failed:', err)
            return false
        }
    }

    /**
     * 删除账户
     */
    delete(id: string): boolean {
        const start = Date.now()
        try {
            const db = getDatabase()
            const stmt = db.prepare('DELETE FROM accounts WHERE id = ?')
            stmt.run(id)
            saveDatabase()
            logQuery('delete', start)
            return true
        } catch (err) {
            console.error('[SqliteAccountRepository] delete failed:', err)
            return false
        }
    }
}

export const accountRepo = new SqliteAccountRepository()
