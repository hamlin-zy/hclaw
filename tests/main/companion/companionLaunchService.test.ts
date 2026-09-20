// tests/main/companion/companionLaunchService.test.ts
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {EventEmitter} from 'events'

const mocks = vi.hoisted(() => ({
    readCompanionConfig: vi.fn(),
    isProcessRunning: vi.fn(),
    notificationShow: vi.fn(),
    notificationSupported: true,
    spawn: vi.fn(),
}))

vi.mock('../../../src/main/companion/companionConfig', () => ({readCompanionConfig: mocks.readCompanionConfig}))
vi.mock('../../../src/main/companion/processDetector', () => ({isProcessRunning: mocks.isProcessRunning}))
vi.mock('electron', () => ({
    Notification: class {
        static isSupported() { return mocks.notificationSupported }
        show() { mocks.notificationShow() }
        constructor(public opts: unknown) {}
    },
}))
vi.mock('child_process', () => ({spawn: mocks.spawn}))

import {launchBeforeApps, launchAfterApps, MAX_BEFORE_WAIT_MS} from '../../../src/main/companion/companionLaunchService'
import type {CompanionApp} from '../../../src/shared/types/companion'

function makeChild(event: 'spawn' | 'error'): EventEmitter & {unref: () => void} {
    const child = new EventEmitter() as EventEmitter & {unref: () => void}
    child.unref = vi.fn()
    if (event) queueMicrotask(() => child.emit(event, event === 'error' ? new Error('ENOENT') : undefined))
    return child
}

function makeApp(overrides: Partial<CompanionApp> = {}): CompanionApp {
    return {
        id: 'companion-1', name: 'Obsidian', exePath: 'C:\\apps\\Obsidian.exe', args: [],
        processName: 'Obsidian.exe', launchTiming: 'before',
        waitForReady: false, enabled: true, ...overrides,
    }
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.notificationSupported = true
    mocks.spawn.mockImplementation(() => makeChild('spawn'))
})
afterEach(() => {
    vi.useRealTimers()
})

describe('launchBeforeApps', () => {
    it('【Review Focus 5】配置缺失/空列表：立即返回，不查进程不 spawn', async () => {
        mocks.readCompanionConfig.mockReturnValue([])
        await launchBeforeApps()
        expect(mocks.isProcessRunning).not.toHaveBeenCalled()
        expect(mocks.spawn).not.toHaveBeenCalled()
        expect(mocks.notificationShow).not.toHaveBeenCalled()
    })
    it('【Review Focus 5】全 disabled：立即返回，不查进程', async () => {
        mocks.readCompanionConfig.mockReturnValue([makeApp({enabled: false})])
        await launchBeforeApps()
        expect(mocks.isProcessRunning).not.toHaveBeenCalled()
    })
    it('已运行项跳过：already-running，不 spawn，不发通知', async () => {
        mocks.readCompanionConfig.mockReturnValue([makeApp()])
        mocks.isProcessRunning.mockResolvedValue(true)
        await launchBeforeApps()
        expect(mocks.spawn).not.toHaveBeenCalled()
        expect(mocks.notificationShow).not.toHaveBeenCalled()
    })
    it('waitForReady=false：spawn 成功即 launched，不轮询', async () => {
        mocks.readCompanionConfig.mockReturnValue([makeApp({launchTiming: 'before', waitForReady: false})])
        mocks.isProcessRunning.mockResolvedValue(false)
        const p = launchBeforeApps()
        await vi.runAllTimersAsync()
        await p
        expect(mocks.spawn).toHaveBeenCalledTimes(1)
        expect(mocks.spawn).toHaveBeenCalledWith('cmd.exe', ['/c', 'start', '', 'C:\\apps\\Obsidian.exe'], expect.objectContaining({detached: true, stdio: 'ignore', windowsHide: true}))
        expect(mocks.isProcessRunning).toHaveBeenCalledTimes(1) // 仅启动前的跳过检测
    })
    it('spawn ENOENT：status=failed + 发通知', async () => {
        mocks.readCompanionConfig.mockReturnValue([makeApp()])
        mocks.isProcessRunning.mockResolvedValue(false)
        mocks.spawn.mockImplementation(() => makeChild('error'))
        const p = launchBeforeApps()
        await vi.runAllTimersAsync()
        await p
        expect(mocks.notificationShow).toHaveBeenCalledTimes(1)
    })
    it('waitForReady=true：轮询命中进程 → launched', async () => {
        mocks.readCompanionConfig.mockReturnValue([makeApp({waitForReady: true, waitTimeoutMs: 10000})])
        mocks.isProcessRunning
            .mockResolvedValueOnce(false)  // 启动前检测：未运行
            .mockResolvedValueOnce(false)  // 轮询 1：未出现
            .mockResolvedValue(true)       // 轮询 2：出现
        const p = launchBeforeApps()
        await vi.advanceTimersByTimeAsync(1100)
        await p
        expect(mocks.notificationShow).not.toHaveBeenCalled()
    })
    it('【Review Focus 3】spawn 成功但进程秒退：轮询到超时 → timeout，不崩溃不重启', async () => {
        mocks.readCompanionConfig.mockReturnValue([makeApp({waitForReady: true, waitTimeoutMs: 2000})])
        mocks.isProcessRunning.mockResolvedValue(false)
        const p = launchBeforeApps()
        await vi.advanceTimersByTimeAsync(2600)
        await p
        expect(mocks.spawn).toHaveBeenCalledTimes(1) // 不反复重启
        expect(mocks.notificationShow).toHaveBeenCalledTimes(1) // timeout 计入失败通知
    })
    it('【全局上限】单 60s 项实际最多等 30s（MAX_BEFORE_WAIT_MS）', async () => {
        expect(MAX_BEFORE_WAIT_MS).toBe(30000)
        mocks.readCompanionConfig.mockReturnValue([makeApp({waitForReady: true, waitTimeoutMs: 60000})])
        mocks.isProcessRunning.mockResolvedValue(false)
        const p = launchBeforeApps()
        // 推进 31s 后 promise 必须已结算（若真等 60s 则未结算）
        await vi.advanceTimersByTimeAsync(31000)
        await p
        // 30s 配额 → 60 次 500ms 轮询 + 1 次启动前检测 ≤ 62
        expect(mocks.isProcessRunning.mock.calls.length).toBeLessThanOrEqual(62)
        expect(mocks.notificationShow).toHaveBeenCalledTimes(1)
    })
    it('before 项并行：两项同时处理', async () => {
        mocks.readCompanionConfig.mockReturnValue([makeApp({name: 'A'}), makeApp({id: 'b', name: 'B', processName: 'B.exe'})])
        mocks.isProcessRunning.mockResolvedValue(false)
        const p = launchBeforeApps()
        await vi.runAllTimersAsync()
        await p
        expect(mocks.spawn).toHaveBeenCalledTimes(2)
    })
    it('无失败项不发通知', async () => {
        mocks.readCompanionConfig.mockReturnValue([makeApp()])
        mocks.isProcessRunning.mockResolvedValue(true)
        await launchBeforeApps()
        expect(mocks.notificationShow).not.toHaveBeenCalled()
    })
})

describe('非 win32 平台分派（task-e9b47ac7）', () => {
    const realPlatform = process.platform
    afterEach(() => {
        Object.defineProperty(process, 'platform', {value: realPlatform})
    })

    function stubPlatform(platform: NodeJS.Platform): void {
        Object.defineProperty(process, 'platform', {value: platform, configurable: true})
    }

    it('darwin：spawn open [exePath, ...args]', async () => {
        stubPlatform('darwin')
        mocks.readCompanionConfig.mockReturnValue([makeApp({args: ['--foo']})])
        mocks.isProcessRunning.mockResolvedValue(false)
        const p = launchBeforeApps()
        await vi.runAllTimersAsync()
        await p
        expect(mocks.spawn).toHaveBeenCalledWith('open', ['C:\\apps\\Obsidian.exe', '--foo'], expect.objectContaining({
            detached: true, stdio: 'ignore', windowsHide: false,
        }))
    })
    it('linux：spawn xdg-open [exePath, ...args]', async () => {
        stubPlatform('linux')
        mocks.readCompanionConfig.mockReturnValue([makeApp()])
        mocks.isProcessRunning.mockResolvedValue(false)
        const p = launchBeforeApps()
        await vi.runAllTimersAsync()
        await p
        expect(mocks.spawn).toHaveBeenCalledWith('xdg-open', ['C:\\apps\\Obsidian.exe'], expect.objectContaining({
            detached: true, stdio: 'ignore', windowsHide: false,
        }))
    })
    it('win32：保持 cmd.exe /c start 语义', async () => {
        stubPlatform('win32')
        mocks.readCompanionConfig.mockReturnValue([makeApp()])
        mocks.isProcessRunning.mockResolvedValue(false)
        const p = launchBeforeApps()
        await vi.runAllTimersAsync()
        await p
        expect(mocks.spawn).toHaveBeenCalledWith('cmd.exe', ['/c', 'start', '', 'C:\\apps\\Obsidian.exe'], expect.objectContaining({windowsHide: true}))
    })
})

describe('launchAfterApps', () => {
    it('只处理 after 项，不等待（fire-and-forget 语义：立即返回）', async () => {
        mocks.readCompanionConfig.mockReturnValue([
            makeApp({launchTiming: 'after'}),
            makeApp({id: 'b', name: 'B', processName: 'B.exe', launchTiming: 'before'}),
        ])
        mocks.isProcessRunning.mockResolvedValue(false)
        const p = launchAfterApps()
        await vi.runAllTimersAsync()
        await p
        // 只 spawn after 项（A），before 项（B）被过滤
        expect(mocks.spawn).toHaveBeenCalledTimes(1)
        expect(mocks.spawn).toHaveBeenCalledWith('cmd.exe', expect.arrayContaining(['/c', 'start', 'C:\\apps\\Obsidian.exe']), expect.anything())
    })
    it('Notification 不支持时静默', async () => {
        mocks.readCompanionConfig.mockReturnValue([makeApp({launchTiming: 'after'})])
        mocks.isProcessRunning.mockResolvedValue(false)
        mocks.spawn.mockImplementation(() => makeChild('error'))
        mocks.notificationSupported = false
        const p = launchAfterApps()
        await vi.runAllTimersAsync()
        await p
        expect(mocks.notificationShow).not.toHaveBeenCalled()
    })
    it('launchSingle 内部抛异常被兜底：整体不抛且发通知', async () => {
        mocks.readCompanionConfig.mockReturnValue([makeApp({launchTiming: 'after'})])
        mocks.isProcessRunning.mockRejectedValue(new Error('boom'))
        await expect(launchAfterApps()).resolves.toBeUndefined()
        expect(mocks.notificationShow).toHaveBeenCalledTimes(1)
    })
})
