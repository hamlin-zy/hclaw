/**
 * powerManager.collectCommandEntries — Hub command 条目归属/启用态映射
 *
 * 锁定本次修复：
 *   - 插件命令经 pluginOwnership.resolve({kind:'command', pluginName, ...}) 判定，
 *     pluginEnabled 反映插件真实状态、enabled 反映 command_overrides 表值
 *     （此前只读 pluginCommandOverrides，resolver 的 command 分支为死路径）；
 *   - 文件命令 pluginName/pluginEnabled 保持 undefined。
 *
 * 隔离：mock CommandDispatcher（避免真实插件/文件扫描）；mock getHclawDir 到临时目录，
 * 用真实 SQLite 提供 command_overrides。绝不触碰真实 ~/.hclaw。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../src/main/config', async () => {
    const osMod = await import('os')
    const pathMod = await import('path')
    const testDir = pathMod.join(
        osMod.tmpdir(),
        'hclaw-test-cmdentries-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    )
    fs.mkdirSync(testDir, {recursive: true})
    return {
        getHclawDir: () => testDir,
        getHclawDataDir: () => pathMod.join(testDir, 'data'),
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
    }
})
vi.mock('../../../src/main/hclawPaths', async () => await import('../../../src/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

// 可变的 dispatcher 返回值；每个用例前重设
const hoisted = vi.hoisted(() => ({result: null as unknown}))
vi.mock('../../../src/main/plugin/commands', () => ({
    CommandDispatcher: {
        getInstance: () => ({getAllCommands: () => hoisted.result}),
    },
}))

import {getDatabase, closeDatabase} from '../../../src/main/repositories/sqlite'
import {PluginRegistry} from '@/main/plugin/registry'
import {powerManager} from '@/main/agent/powerManager'
import type {CommandDef, LoadedPlugin} from '@/main/plugin/types'
import type {CapabilityEntry} from '@/main/capability/types'

let db: ReturnType<typeof getDatabase>

function plugin(name: string, enabled: boolean): LoadedPlugin {
    return {name, source: 'local', path: `/tmp/${name}`, manifest: {name}, enabled, isBuiltin: false}
}

function cmd(id: string, name: string): CommandDef {
    return {id, name, description: '', content: 'body', filePath: `/tmp/${id}.md`}
}

function collect(): CapabilityEntry[] {
    return (powerManager as unknown as {collectCommandEntries(): CapabilityEntry[]}).collectCommandEntries()
}

function setResult(result: {
    pluginGroups: Map<string, CommandDef[]>
    userCommands: Array<{id: string; name: string; description?: string; content: string; enabled: boolean; args?: unknown[]}>
    pluginCommandOverrides: Record<string, {enabled: boolean}>
}) {
    hoisted.result = result
}

describe('collectCommandEntries — 插件命令走 pluginOwnership.resolve', () => {
    beforeEach(() => {
        db = getDatabase()
        db.exec(`CREATE TABLE IF NOT EXISTS command_overrides (
            command_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL);`)
        db.exec('DELETE FROM command_overrides')
        const registry = PluginRegistry.getInstance()
        registry.clear()
        registry.register(plugin('demo', true))
        registry.register(plugin('off', false))
    })

    afterEach(() => {
        PluginRegistry.getInstance().clear()
        try { closeDatabase() } catch { /* noop */ }
    })

    it('enabled 反映 command_overrides 表值（resolver command 分支在生产可达）', () => {
        db.prepare('INSERT INTO command_overrides (command_id, enabled, updated_at) VALUES (?, ?, ?)')
            .run('demo:my-cmd', 0, Date.now())
        setResult({
            pluginGroups: new Map([['demo', [cmd('demo:my-cmd', 'my-cmd')]]]),
            userCommands: [],
            pluginCommandOverrides: {},
        })

        const [entry] = collect()
        expect(entry.pluginName).toBe('demo')
        expect(entry.pluginEnabled).toBe(true)
        expect(entry.source).toBe('plugin')
        expect(entry.enabled).toBe(false) // command_overrides 覆盖
    })

    it('无 command_overrides 时回落到 pluginCommandOverrides（保持既有行为）', () => {
        setResult({
            pluginGroups: new Map([['demo', [cmd('demo:over', 'over')]]]),
            userCommands: [],
            pluginCommandOverrides: {'demo:over': {enabled: false}},
        })

        const [entry] = collect()
        expect(entry.enabled).toBe(false)
    })

    it('插件禁用 → pluginEnabled=false 且 capabilityEnabled=false', () => {
        setResult({
            pluginGroups: new Map([['off', [cmd('off:x', 'x')]]]),
            userCommands: [],
            pluginCommandOverrides: {},
        })

        const [entry] = collect()
        expect(entry.pluginName).toBe('off')
        expect(entry.pluginEnabled).toBe(false)
        expect(entry.enabled).toBe(false)
    })

    it('文件命令无插件归属（pluginName/pluginEnabled 均为 undefined）', () => {
        setResult({
            pluginGroups: new Map(),
            userCommands: [{id: 'local-cmd', name: 'Local', description: '', content: 'body', enabled: true}],
            pluginCommandOverrides: {},
        })

        const [entry] = collect()
        expect(entry.source).toBe('user')
        expect(entry.pluginName).toBeUndefined()
        expect(entry.pluginEnabled).toBeUndefined()
        expect(entry.enabled).toBe(true)
    })
})
