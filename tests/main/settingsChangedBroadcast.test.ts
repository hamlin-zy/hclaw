import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * 跨窗口系统设置同步广播静态契约。
 *
 * 根因（与 llm/tools/prompt-schemes 同类）：设置窗口独立化后，修改背景图/遮罩/模糊
 * 等 ui.background 设置发生在独立 JS 堆，主窗口 settingsStore 无刷新机制（stale）。
 * 修复：settings-update handler 广播 Worker 之后，把完整 settings 广播给除发起窗口外的
 * 所有渲染窗口（'settings-changed'）；窗口订阅后调用 loadSettings 刷新 store。
 * 广播模式统一走 utils/windowBroadcast.ts 的 broadcastToOtherWindows（支持可选 payload）。
 */

const CONFIG_IPC_TS = path.resolve(process.cwd(), 'src/main/agent/ipc/config.ts')
const HELPER_TS = path.resolve(process.cwd(), 'src/main/utils/windowBroadcast.ts')
const PRELOAD_TS = path.resolve(process.cwd(), 'src/preload/index.ts')
const APP_TS = path.resolve(process.cwd(), 'src/renderer/App.tsx')

describe('windowBroadcast.ts — 可选 payload 支持', () => {
    it('broadcastToOtherWindows 支持第三参 payload：未传时等价 send(channel)，有值时 send(channel, payload)', () => {
        const src = fs.readFileSync(HELPER_TS, 'utf-8')
        expect(src).toContain('export function broadcastToOtherWindows(event: Electron.IpcMainInvokeEvent, channel: string, payload?: unknown): void')
        expect(src).toContain('win.webContents.send(channel, payload)')
    })
})

describe('config.ts — settings-update 广播 settings-changed', () => {
    it('广播 Worker 之后调用 broadcastToOtherWindows(event, settings-changed, settings)', () => {
        const src = fs.readFileSync(CONFIG_IPC_TS, 'utf-8')
        expect(src).toContain("broadcastToOtherWindows(event, 'settings-changed', settings)")
    })
})

describe('跨窗口订阅链路', () => {
    it('preload 暴露 onSettingsChanged 且桥接 settings-changed', () => {
        const src = fs.readFileSync(PRELOAD_TS, 'utf-8')
        expect(src).toContain('onSettingsChanged')
        expect(src).toContain("'settings-changed'")
        expect(src).toContain('ipcRenderer.on(\'settings-changed\'')
        expect(src).toContain('ipcRenderer.removeListener(\'settings-changed\'')
    })

    it('App.tsx 订阅 onSettingsChanged 并触发 loadSettings 刷新 store', () => {
        const src = fs.readFileSync(APP_TS, 'utf-8')
        expect(src).toContain('onSettingsChanged')
        expect(src).toContain('useSettingsStore.getState().loadSettings()')
    })
})
