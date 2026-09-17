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
const MANAGER_IMPL_TS = path.resolve(process.cwd(), 'src/main/agent/manager.impl.ts')

describe('windowBroadcast.ts — 可选 payload 支持', () => {
    it('broadcastToOtherWindows 支持第三参 payload：未传时等价 send(channel)，有值时 send(channel, payload)', () => {
        const src = fs.readFileSync(HELPER_TS, 'utf-8')
        expect(src).toContain('export function broadcastToOtherWindows(event: Electron.IpcMainInvokeEvent, channel: string, payload?: unknown): void')
        expect(src).toContain('win.webContents.send(channel, payload)')
    })
})

describe('config.ts — settings-update 走统一传播助手', () => {
    it('handler 调用 propagateSystemSettings 并排除发起窗口', () => {
        const src = fs.readFileSync(CONFIG_IPC_TS, 'utf-8')
        expect(src).toContain('propagateSystemSettings(settings')
        expect(src).toContain('excludeWebContentsId: event.sender.id')
        expect(src).not.toContain("broadcastToOtherWindows(event, 'settings-changed'")
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

    it('App.tsx 订阅 onSettingsChanged：应用主题 + 刷新快捷键；不再消费 settings-updated 通道', () => {
        const src = fs.readFileSync(APP_TS, 'utf-8')
        expect(src).toContain('onSettingsChanged')
        expect(src).toContain('resolveAndApplyTheme')
        expect(src).toContain('reloadShortcutBindings()')
        expect(src).not.toContain("'settings-updated'")
    })
})

describe('manager.impl — settings-updated 走统一传播助手', () => {
    it('分支调用 propagateSystemSettings，且不再 sendToMainWindow 转发', () => {
        const src = fs.readFileSync(MANAGER_IMPL_TS, 'utf-8')
        expect(src).toContain('propagateSystemSettings(')
        expect(src).not.toMatch(/sendToMainWindow\('settings-updated'/)
    })
})
