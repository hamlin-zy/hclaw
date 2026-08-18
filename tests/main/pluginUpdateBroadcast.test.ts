import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * 插件更新红点跨窗口同步静态契约。
 *
 * 根因（与 dataSyncBroadcast 同类）：插件管理（PluginDialog）与关于（AboutDialog）
 * 迁为独立窗口后，各自持有独立 JS 堆与独立 store 实例：
 *   - 插件管理窗口打开时不拉缓存、不订阅推送 → 有更新的插件红点不显示；
 *   - 版本同步/切换/升级只发生在独立窗口自己的 store → 主窗口 MenuBar 红点残留；
 *   - 关于页打开时不拉 updater 缓存、不订阅推送 → 主进程已有检查结果也不显示。
 * 修复：主进程三个插件写 handler 成功后 broadcastToOtherWindows 广播
 * plugin:status-update；两个独立窗口 mount 时拉缓存 + 订阅推送。
 * 广播统一走 utils/windowBroadcast.ts 的 broadcastToOtherWindows（已支持第三参 payload）。
 */

const PLUGIN_IPC_TS = path.resolve(process.cwd(), 'src/main/plugin/ipc.ts')
const PLUGIN_DIALOG_TSX = path.resolve(process.cwd(), 'src/renderer/components/dialogs/PluginDialog.tsx')
const ABOUT_DIALOG_TSX = path.resolve(process.cwd(), 'src/renderer/components/dialogs/AboutDialog.tsx')
const PRELOAD_TS = path.resolve(process.cwd(), 'src/preload/index.ts')

const BROADCAST_CALL = "broadcastToOtherWindows(event, 'plugin:status-update', versionManager.getAllVersionMeta())"

describe('plugin/ipc.ts — plugin:status-update 跨窗口广播', () => {
    it('3 个写 handler（handleSyncVersions/handleSwitchVersion/handleUpdate）成功路径均广播', () => {
        const src = fs.readFileSync(PLUGIN_IPC_TS, 'utf-8')
        expect(src).toContain("import {broadcastToOtherWindows} from '../utils/windowBroadcast'")
        // 成功路径广播调用恰好 3 处（每个写 handler 一处）
        const count = src.split(BROADCAST_CALL).length - 1
        expect(count).toBe(3)
    })

    it('三个 handler 均使用 event（而非 _event）参数以支持跳过发起窗口', () => {
        const src = fs.readFileSync(PLUGIN_IPC_TS, 'utf-8')
        expect(src).toContain('async function handleUpdate(\n  event: IpcMainInvokeEvent,')
        expect(src).toContain('async function handleSyncVersions(\n  event: IpcMainInvokeEvent,')
        expect(src).toContain('async function handleSwitchVersion(\n  event: IpcMainInvokeEvent,')
    })
})

describe('PluginDialog.tsx — 独立窗口红点同步链路', () => {
    it('mount 时订阅 onPluginStatusUpdate 推送 + refreshFromCache 拉取缓存', () => {
        const src = fs.readFileSync(PLUGIN_DIALOG_TSX, 'utf-8')
        expect(src).toContain('window.electronAPI?.plugin?.onPluginStatusUpdate?.((data: any) =>')
        expect(src).toContain('usePluginUpdateStore.getState().setVersionMeta(data)')
        expect(src).toContain('usePluginUpdateStore.getState().refreshFromCache()')
        expect(src).toContain('return () => unsubscribe?.()')
    })
})

describe('AboutDialog.tsx — 关于页更新状态同步链路', () => {
    it('mount 时 updaterGetStatus 拉取缓存 + 订阅 onUpdaterStatusChanged 推送', () => {
        const src = fs.readFileSync(ABOUT_DIALOG_TSX, 'utf-8')
        expect(src).toContain('window.electronAPI?.updaterGetStatus?.().then((result) => {')
        expect(src).toContain('useUpdaterStore.getState().setResult(result)')
        expect(src).toContain('window.electronAPI?.onUpdaterStatusChanged?.((result) => {')
        expect(src).toContain('return () => unsubscribe?.()')
    })
})

describe('preload — 桥接完整性', () => {
    it('暴露 onPluginStatusUpdate / onUpdaterStatusChanged 订阅', () => {
        const src = fs.readFileSync(PRELOAD_TS, 'utf-8')
        expect(src).toContain('onPluginStatusUpdate')
        expect(src).toContain("ipcRenderer.on('plugin:status-update', handler)")
        expect(src).toContain('onUpdaterStatusChanged')
        expect(src).toContain("ipcRenderer.on('updater:status-changed', handler)")
    })
})
