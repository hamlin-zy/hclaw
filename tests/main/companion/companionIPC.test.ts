import {describe, it, expect, vi, beforeEach} from 'vitest'

const mocks = vi.hoisted(() => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    return {
        handlers,
        removeHandler: vi.fn(),
        handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
        showOpenDialog: vi.fn(),
        getFileIcon: vi.fn(),
        readCompanionConfig: vi.fn(),
        upsertCompanionApp: vi.fn(),
        removeCompanionApp: vi.fn(),
        enumerateApps: vi.fn(),
    }
})

vi.mock('electron', () => ({
    ipcMain: {removeHandler: mocks.removeHandler, handle: mocks.handle},
    dialog: {showOpenDialog: mocks.showOpenDialog},
    app: {getFileIcon: mocks.getFileIcon},
    BrowserWindow: {fromWebContents: vi.fn(() => null)},
}))
vi.mock('../../../src/main/companion/companionConfig', () => ({
    readCompanionConfig: mocks.readCompanionConfig,
    upsertCompanionApp: mocks.upsertCompanionApp,
    removeCompanionApp: mocks.removeCompanionApp,
}))
vi.mock('../../../src/main/companion/appEnumerator', () => ({enumerateApps: mocks.enumerateApps}))

import {initCompanionIPC} from '../../../src/main/companion/companionIPC'

const fakeEvent = {sender: {}} as never

beforeEach(() => {
    mocks.handlers.clear()
    vi.clearAllMocks()
    initCompanionIPC()
})

describe('注册行为', () => {
    it('重复调用 initCompanionIPC 不抛异常（safeHandle：removeHandler + handle）', () => {
        expect(() => initCompanionIPC()).not.toThrow()
        expect(mocks.removeHandler).toHaveBeenCalledWith('companion:save')
    })
    it('6 个 channel 全部注册', () => {
        expect([...mocks.handlers.keys()].sort()).toEqual([
            'companion:browse', 'companion:enumerate', 'companion:get-icon',
            'companion:list', 'companion:remove', 'companion:save',
        ])
    })
})

describe('companion:save', () => {
    it('【新增】id 为空：返回 {success: true, id}', async () => {
        mocks.upsertCompanionApp.mockReturnValue('companion-new')
        const input = {id: '', name: 'Obsidian', exePath: 'C:\\a.exe', args: [], processName: 'a.exe', launchTiming: 'after', waitForReady: false, enabled: true}
        await expect(mocks.handlers.get('companion:save')!(fakeEvent, input)).resolves.toEqual({success: true, id: 'companion-new'})
    })
    it('【更新】id 非空：返回 {success: true} 不回传 id', async () => {
        mocks.upsertCompanionApp.mockReturnValue('companion-existing')
        const input = {id: 'companion-existing', name: 'Obsidian', exePath: 'C:\\a.exe', args: [], processName: 'a.exe', launchTiming: 'after', waitForReady: false, enabled: true}
        await expect(mocks.handlers.get('companion:save')!(fakeEvent, input)).resolves.toEqual({success: true})
    })
    it('异常返回 {success: false, error}', async () => {
        mocks.upsertCompanionApp.mockImplementation(() => { throw new Error('disk full') })
        const input = {id: '', name: 'x', exePath: '', args: [], processName: '', launchTiming: 'after', waitForReady: false, enabled: true}
        const result = await mocks.handlers.get('companion:save')!(fakeEvent, input) as {success: boolean; error?: string}
        expect(result.success).toBe(false)
        expect(result.error).toContain('disk full')
    })
})

describe('companion:remove', () => {
    it('【幂等】不存在 id 也返回 {success: true}', async () => {
        mocks.removeCompanionApp.mockImplementation(() => { /* no-op */ })
        await expect(mocks.handlers.get('companion:remove')!(fakeEvent, 'companion-nonexistent')).resolves.toEqual({success: true})
    })
    it('异常返回 {success: false, error}', async () => {
        mocks.removeCompanionApp.mockImplementation(() => { throw new Error('EACCES') })
        const result = await mocks.handlers.get('companion:remove')!(fakeEvent, 'x') as {success: boolean}
        expect(result.success).toBe(false)
    })
})

describe('companion:list / enumerate', () => {
    it('list 透传 readCompanionConfig', async () => {
        const apps = [{id: 'a'}]
        mocks.readCompanionConfig.mockReturnValue(apps)
        await expect(mocks.handlers.get('companion:list')!(fakeEvent)).resolves.toBe(apps)
    })
    it('enumerate 透传 enumerateApps', async () => {
        mocks.enumerateApps.mockResolvedValue([{name: 'A', exePath: 'C:\\a.exe', args: '', shortcutPath: ''}])
        const result = await mocks.handlers.get('companion:enumerate')!(fakeEvent) as unknown[]
        expect(result).toHaveLength(1)
    })
    it('enumerate 失败返回空数组不抛异常', async () => {
        mocks.enumerateApps.mockRejectedValue(new Error('ps failed'))
        await expect(mocks.handlers.get('companion:enumerate')!(fakeEvent)).resolves.toEqual([])
    })
})

describe('companion:browse', () => {
    it('【Review Focus 4】用户取消返回 null', async () => {
        mocks.showOpenDialog.mockResolvedValue({canceled: true, filePaths: []})
        await expect(mocks.handlers.get('companion:browse')!(fakeEvent)).resolves.toBeNull()
    })
    it('选中文件返回 EnumeratedApp 同构对象（name 去扩展名）', async () => {
        mocks.showOpenDialog.mockResolvedValue({canceled: false, filePaths: ['C:\\apps\\Obsidian.exe']})
        const result = await mocks.handlers.get('companion:browse')!(fakeEvent) as {name: string; exePath: string; args: string; shortcutPath: string}
        expect(result).toEqual({name: 'Obsidian', exePath: 'C:\\apps\\Obsidian.exe', args: '', shortcutPath: ''})
    })
    it('filters 为 exe/bat/cmd', async () => {
        mocks.showOpenDialog.mockResolvedValue({canceled: true, filePaths: []})
        await mocks.handlers.get('companion:browse')!(fakeEvent)
        expect(mocks.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
            filters: [{name: '应用程序', extensions: ['exe', 'bat', 'cmd']}],
        }))
    })
})

describe('companion:get-icon', () => {
    it('正常提取返回 data URL', async () => {
        mocks.getFileIcon.mockResolvedValue({toDataURL: () => 'data:image/png;base64,xxx'})
        await expect(mocks.handlers.get('companion:get-icon')!(fakeEvent, 'C:\\a.exe')).resolves.toEqual({iconDataUrl: 'data:image/png;base64,xxx'})
        expect(mocks.getFileIcon).toHaveBeenCalledWith('C:\\a.exe', {size: 'normal'})
    })
    it('空路径返回 null', async () => {
        await expect(mocks.handlers.get('companion:get-icon')!(fakeEvent, '')).resolves.toBeNull()
        expect(mocks.getFileIcon).not.toHaveBeenCalled()
    })
    it('无效路径（getFileIcon 拒绝）返回 null', async () => {
        mocks.getFileIcon.mockRejectedValue(new Error('invalid path'))
        await expect(mocks.handlers.get('companion:get-icon')!(fakeEvent, 'C:\\nope.exe')).resolves.toBeNull()
    })
})
