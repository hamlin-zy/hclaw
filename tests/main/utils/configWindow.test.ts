// 主进程测试（node 环境）
import {describe, it, expect, vi, beforeEach} from 'vitest'

const state = vi.hoisted(() => ({
    created: [] as Array<{id: string; options: any; close: () => void; isDestroyed: () => boolean}>,
    closed: [] as string[],
    focused: [] as string[],
    handlers: new Map<string, Function>(),
}))

vi.mock('electron', () => ({
    ipcMain: {
        handle: (channel: string, fn: Function) => { state.handlers.set(channel, fn) },
        removeHandler: () => {},
    },
}))

// mock 工厂：返回可观测的假窗口
vi.mock('../../../src/main/utils/windowFactory', () => ({
    createAppWindow: (options: any) => {
        const win = {
            id: options.id,
            options,
            destroyed: false,
            focus: () => { state.focused.push(options.id) },
            close: () => {
                state.closed.push(options.id)
                win.destroyed = true
                win.emitClosed?.()
            },
            isDestroyed: () => win.destroyed,
            on: (_e: string, fn: Function) => { if (_e === 'closed') win.emitClosed = fn },
        } as any
        state.created.push(win)
        return win
    },
}))

// configWindow 维护模块级注册表（同类型单例），跨用例会互相污染；
// 因此每个用例前 vi.resetModules + 重新动态 import 拿到全新实例。
let openConfigWindow: typeof import('../../../src/main/utils/configWindow').openConfigWindow
let closeConfigWindow: typeof import('../../../src/main/utils/configWindow').closeConfigWindow
let initConfigWindowIPC: typeof import('../../../src/main/utils/configWindow').initConfigWindowIPC
let CONFIG_DIALOG_TYPES: Set<string>

beforeEach(async () => {
    state.created.length = 0
    state.closed.length = 0
    state.focused.length = 0
    state.handlers.clear()
    vi.resetModules()
    const mod = await import('../../../src/main/utils/configWindow')
    openConfigWindow = mod.openConfigWindow
    closeConfigWindow = mod.closeConfigWindow
    initConfigWindowIPC = mod.initConfigWindowIPC
    CONFIG_DIALOG_TYPES = mod.CONFIG_DIALOG_TYPES
})

describe('configWindow 注册表', () => {
    it('白名单含 17 种 dialogType', () => {
        expect(CONFIG_DIALOG_TYPES.size).toBe(17)
        expect(CONFIG_DIALOG_TYPES.has('llm-config')).toBe(true)
        expect(CONFIG_DIALOG_TYPES.has('about')).toBe(true)
        expect(CONFIG_DIALOG_TYPES.has('update-notice')).toBe(false)
    })

    it('同类型重复 open → focus 不新建', () => {
        openConfigWindow('mcp')
        openConfigWindow('mcp')
        expect(state.created).toHaveLength(1)
        expect(state.focused).toEqual(['mcp'])
    })

    it('不同类型 → 各自新建、可并行', () => {
        openConfigWindow('llm-config')
        openConfigWindow('mcp')
        expect(state.created.map(c => c.id)).toEqual(['llm-config', 'mcp'])
    })

    it('窗口 closed → 从注册表删除，可重建', () => {
        openConfigWindow('tools')
        const win = state.created[0]
        win.close()
        openConfigWindow('tools')
        expect(state.created).toHaveLength(2)
    })

    it('白名单外 type → 不创建', () => {
        openConfigWindow('update-notice')
        openConfigWindow('unknown-type')
        expect(state.created).toHaveLength(0)
    })

    it('open-config-window IPC 注册', () => {
        initConfigWindowIPC()
        expect(state.handlers.has('open-config-window')).toBe(true)
    })

    it('配置窗口传 --hclaw-dialog=<type> 且 devTools 关闭', () => {
        openConfigWindow('llm-config')
        expect(state.created[0].options.additionalArguments).toContain('--hclaw-dialog=llm-config')
        expect(state.created[0].options.devTools).toBe(false)
    })

    it('about 用专属尺寸 400x430，其他用 DIALOG_CONFIG initialWidth', () => {
        openConfigWindow('about')
        expect(state.created[0].options.width).toBe(400)
        expect(state.created[0].options.height).toBe(430)
    })

    it('closeConfigWindow 关闭指定类型窗口', () => {
        openConfigWindow('mcp')
        closeConfigWindow('mcp')
        expect(state.closed).toEqual(['mcp'])
    })
})
