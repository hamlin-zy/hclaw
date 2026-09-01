// 主进程测试（node 环境，无需 jsdom）
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

// vi.hoisted 共享状态（vi.mock 工厂被提升，无法引用外部变量）
const state = vi.hoisted(() => ({
    instances: [] as Array<{options: any; loadURL: any; loadFile: any}>,
    handlers: new Map<string, Function>(),
    removed: [] as string[],
    sent: [] as Array<{channel: string; payload: any}>,
    events: [] as Array<{event: string; handler: Function}>,
}))

vi.mock('electron', () => {
    class MockBrowserWindow {
        options: any
        constructor(options: any) {
            this.options = options
            state.instances.push(this)
        }
        setMenu() {}
        setMenuBarVisibility() {}
        once() {}
        on(event: string, fn: Function) {
            state.events.push({event, handler: fn})
            if (event === 'maximize') fn()
            if (event === 'unmaximize') fn()
            // page-title-updated 处理器需要 event 参数（调用 preventDefault）
            if (event === 'page-title-updated') fn({preventDefault: vi.fn()})
        }
        loadURL = vi.fn()
        loadFile = vi.fn()
        minimize() {}
        maximize() {}
        unmaximize() {}
        isMaximized() { return false }
        close() {}
        isDestroyed() { return false }
        get webContents() {
            return {
                send: (channel: string, payload: any) => state.sent.push({channel, payload}),
                openDevTools: () => {},
            }
        }
    }
    return {
        BrowserWindow: MockBrowserWindow,
        ipcMain: {
            handle: (channel: string, fn: Function) => { state.handlers.set(channel, fn) },
            removeHandler: (channel: string) => { state.removed.push(channel) },
        },
    }
})

import {createAppWindow} from '../../../src/main/utils/windowFactory'

// electron-vite 在构建期用 define 注入的全局、Electron 运行时注入的 resourcesPath，
// vitest(node) 环境均不存在，这里补齐使 icon.ts 可运行。
(globalThis as any)['MAIN_WINDOW_VITE_DEV_SERVER_URL'] = undefined
;(process as any).resourcesPath = ''

const BASE_OPTS = {id: 'test-win', title: '测试', entryHtml: 'test.html', width: 800, height: 600, minWidth: 400, minHeight: 300}

function restorePlatform(value: string) {
    Object.defineProperty(process, 'platform', {value, configurable: true})
}

beforeEach(() => {
    state.instances.length = 0
    state.handlers.clear()
    state.removed.length = 0
    state.sent.length = 0
    restorePlatform('win32')
})

afterEach(() => {
    vi.clearAllMocks()
})

describe('windowFactory.createAppWindow', () => {
    it('Windows 用 frame:false，不设 titleBarStyle', () => {
        restorePlatform('win32')
        createAppWindow({...BASE_OPTS})
        const opts = state.instances[0].options
        expect(opts.frame).toBe(false)
        expect(opts.titleBarStyle).toBeUndefined()
    })

    it('macOS 用 titleBarStyle: hiddenInset，不设 frame', () => {
        restorePlatform('darwin')
        createAppWindow({...BASE_OPTS})
        const opts = state.instances[0].options
        expect(opts.titleBarStyle).toBe('hiddenInset')
        expect(opts.frame).toBeUndefined()
    })

    it('additionalArguments 注入 theme + win11 + darwin + window-id 四参数', () => {
        createAppWindow({...BASE_OPTS})
        const args = state.instances[0].options.webPreferences.additionalArguments
        expect(args.some((a: string) => a.startsWith('--hclaw-theme='))).toBe(true)
        expect(args.some((a: string) => a.startsWith('--hclaw-win11='))).toBe(true)
        expect(args.some((a: string) => a.startsWith('--hclaw-darwin='))).toBe(true)
        expect(args).toContain('--hclaw-window-id=test-win')
    })

    it('additionalArguments 透传 extra 参数（如 --hclaw-dialog）', () => {
        createAppWindow({...BASE_OPTS, additionalArguments: ['--hclaw-dialog=llm-config']})
        const args = state.instances[0].options.webPreferences.additionalArguments
        expect(args).toContain('--hclaw-dialog=llm-config')
    })

    it('注册 <id>:minimize/maximize/close/is-maximized 四个 IPC handler', () => {
        createAppWindow({...BASE_OPTS})
        expect(state.handlers.has('test-win:minimize')).toBe(true)
        expect(state.handlers.has('test-win:maximize')).toBe(true)
        expect(state.handlers.has('test-win:close')).toBe(true)
        expect(state.handlers.has('test-win:is-maximized')).toBe(true)
    })

    it('重复创建同 id 不抛错（先 removeHandler 再注册，幂等）', () => {
        createAppWindow({...BASE_OPTS})
        createAppWindow({...BASE_OPTS})
        expect(state.removed).toContain('test-win:minimize')
        expect(state.handlers.has('test-win:minimize')).toBe(true)
    })

    it('最大化/还原时向渲染进程广播 <id>-maximized-changed', () => {
        createAppWindow({...BASE_OPTS})
        const sends = state.sent.filter(s => s.channel === 'test-win-maximized-changed')
        expect(sends.length).toBeGreaterThan(0)
    })

    it('拦截 page-title-updated，防止页面 <title> 覆盖构造标题（任务栏标题修复）', () => {
        createAppWindow({...BASE_OPTS})
        const evt = {preventDefault: vi.fn()}
        const entry = state.events.find(e => e.event === 'page-title-updated')
        expect(entry).toBeTruthy()
        entry!.handler(evt)
        expect(evt.preventDefault).toHaveBeenCalled()
    })

    it('生产模式 loadFile 到 renderer/main_window/<entryHtml>', () => {
        vi.stubEnv('NODE_ENV', 'production')
        createAppWindow({...BASE_OPTS})
        const win = state.instances[0]
        expect(win.loadFile).toHaveBeenCalled()
        vi.unstubAllEnvs()
    })
})
