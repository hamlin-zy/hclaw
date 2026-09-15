import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * plugin/ipc.ts — 命令名冲突护栏（主进程权威防线）
 *
 * 根因：handleCreateCommand 无存在性检查 → 与已有命令重名时静默覆盖；
 *       handleUpdateCommand 改名后不检查目标名冲突 → 会把另一个命令文件覆盖掉。
 *
 * 本测试以运行态方式捕获 IPC handler，指向真实临时目录，验证：
 *   - 新建撞名（含大小写不敏感）被拒绝且不写文件；
 *   - 改名撞名被拒绝；改回自身 / 仅大小写变化不算冲突。
 */

const DUPLICATE_ERROR = '已存在同名命令，请修改命令名'

type CommandResult = {success: boolean; error?: string}
type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<CommandResult>

const {handlers, commandsDirRef, powerRefresh} = vi.hoisted(() => ({
    handlers: {} as Record<string, IpcHandler>,
    commandsDirRef: {current: ''},
    powerRefresh: vi.fn(async () => {}),
}))

vi.mock('electron', () => ({
    ipcMain: {handle: (ch: string, fn: IpcHandler) => { handlers[ch] = fn }},
    BrowserWindow: {getAllWindows: () => []},
}))

vi.mock('../../../src/main/agent/commandLoader', () => ({
    loadCommands: vi.fn(async () => []),
    getCommandsDir: () => commandsDirRef.current,
}))

vi.mock('../../../src/main/agent/powerManager', () => ({
    powerManager: {refresh: powerRefresh},
}))

vi.mock('../../../src/main/config', () => ({
    getHclawDir: () => path.join(os.tmpdir(), 'hclaw-conflict-test'),
}))

vi.mock('../../../src/main/plugin/plugins-config', () => ({
    disablePluginInConfig: vi.fn(),
    enablePluginInConfig: vi.fn(),
    isPluginEnabled: vi.fn(() => true),
    loadPluginsConfig: vi.fn(() => ({plugins: []})),
    savePluginsConfig: vi.fn(),
}))

import '../../../src/main/plugin/ipc'
import {registerPluginIPC} from '../../../src/main/plugin/ipc'

function commandFilePath(name: string): string {
    return path.join(commandsDirRef.current, `${name}.md`)
}

function writeCommand(name: string, content = 'original body'): void {
    fs.writeFileSync(
        commandFilePath(name),
        `---\nname: ${name}\ndescription: desc\nenabled: true\n---\n\n${content}`,
        'utf-8',
    )
}

describe('plugin/ipc.ts — 命令名冲突护栏', () => {
    beforeEach(() => {
        commandsDirRef.current = fs.mkdtempSync(path.join(os.tmpdir(), 'hclaw-cmd-conflict-'))
        registerPluginIPC()
        powerRefresh.mockClear()
    })

    afterEach(() => {
        try { fs.rmSync(commandsDirRef.current, {recursive: true, force: true}) } catch { /* noop */ }
    })

    it('新建撞名（完全同名）→ 返回错误且不覆盖原文件', async () => {
        writeCommand('daily', 'ORIGINAL')
        const result = await handlers['command:create']({}, {name: 'daily', content: 'NEW'})
        expect(result).toEqual({success: false, error: DUPLICATE_ERROR})
        expect(fs.readFileSync(commandFilePath('daily'), 'utf-8')).toContain('ORIGINAL')
    })

    it('新建撞名（大小写不敏感）→ 被拒绝', async () => {
        writeCommand('Daily', 'ORIGINAL')
        const result = await handlers['command:create']({}, {name: 'daily', content: 'NEW'})
        expect(result).toEqual({success: false, error: DUPLICATE_ERROR})
        expect(fs.readFileSync(commandFilePath('Daily'), 'utf-8')).toContain('ORIGINAL')
    })

    it('新建不撞名 → 成功写入', async () => {
        const result = await handlers['command:create']({}, {name: 'fresh', content: 'BODY'})
        expect(result).toEqual({success: true})
        expect(fs.existsSync(commandFilePath('fresh'))).toBe(true)
    })

    it('改名撞另一个已有命令 → 被拒绝，且原命令文件不受影响', async () => {
        writeCommand('alpha', 'ALPHA')
        writeCommand('beta', 'BETA')
        const result = await handlers['command:update']({}, 'user:alpha', {name: 'beta'})
        expect(result).toEqual({success: false, error: DUPLICATE_ERROR})
        expect(fs.readFileSync(commandFilePath('alpha'), 'utf-8')).toContain('ALPHA')
        expect(fs.readFileSync(commandFilePath('beta'), 'utf-8')).toContain('BETA')
    })

    it('改名撞名（大小写不敏感）→ 被拒绝', async () => {
        writeCommand('alpha', 'ALPHA')
        writeCommand('Beta', 'BETA')
        const result = await handlers['command:update']({}, 'user:alpha', {name: 'beta'})
        expect(result).toEqual({success: false, error: DUPLICATE_ERROR})
    })

    it('改名到未占用的新名 → 成功且旧文件被移除', async () => {
        writeCommand('alpha', 'ALPHA')
        const result = await handlers['command:update']({}, 'user:alpha', {name: 'gamma'})
        expect(result).toEqual({success: true})
        expect(fs.existsSync(commandFilePath('alpha'))).toBe(false)
        expect(fs.existsSync(commandFilePath('gamma'))).toBe(true)
    })

    it('保持原名（未改名）→ 不触发冲突检查，保存成功', async () => {
        writeCommand('alpha', 'ALPHA')
        const result = await handlers['command:update']({}, 'user:alpha', {name: 'alpha', content: 'UPDATED'})
        expect(result).toEqual({success: true})
        expect(fs.readFileSync(commandFilePath('alpha'), 'utf-8')).toContain('UPDATED')
    })

    it('仅大小写改名（Foo → foo，同一文件）→ 不视为冲突', async () => {
        writeCommand('Foo', 'FOO')
        const result = await handlers['command:update']({}, 'user:Foo', {name: 'foo'})
        expect(result).toEqual({success: true})
    })
})
