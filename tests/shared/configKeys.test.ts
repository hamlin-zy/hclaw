/**
 * 加固 4：`'project-group-view'` 配置键收敛为单一导出。
 *
 * 为什么值得钉：同一个键在两处各写一份字面量时，任一处改错就会让主进程把它当
 * 「非 SQLite 键」（走 JSON 文件）而渲染端按 SQLite 读 → 读回 null、视图作用域静默丢失。
 * 本用例双向守卫：① 共享常量值本身（wire 值不能漂移）② 两个消费点必须引用常量、不得再写字面量。
 */
import {describe, it, expect} from 'vitest'
import fs from 'fs'
import path from 'path'
import {PROJECT_GROUP_VIEW_CONFIG_KEY} from '../../src/shared/configKeys'

const CONFIG_IPC = path.resolve(process.cwd(), 'src/main/ipc/configIPC.ts')
const CONVERSATION_STORE = path.resolve(process.cwd(), 'src/renderer/stores/conversationStore.ts')

describe('PROJECT_GROUP_VIEW_CONFIG_KEY', () => {
    it('wire 值不变（持久化键一旦改名，存量用户的视图作用域会静默丢失）', () => {
        expect(PROJECT_GROUP_VIEW_CONFIG_KEY).toBe('project-group-view')
    })

    it('主进程 configIPC 引用常量而非字面量（SQLITE_KEYS 白名单）', () => {
        const src = fs.readFileSync(CONFIG_IPC, 'utf-8')
        expect(src).toContain('PROJECT_GROUP_VIEW_CONFIG_KEY')
        expect(src).not.toContain("'project-group-view'")
    })

    it('渲染端 conversationStore 引用常量而非字面量', () => {
        const src = fs.readFileSync(CONVERSATION_STORE, 'utf-8')
        expect(src).toContain('VIEW_SCOPE_KEY = PROJECT_GROUP_VIEW_CONFIG_KEY')
        expect(src).not.toContain("'project-group-view'")
    })
})
