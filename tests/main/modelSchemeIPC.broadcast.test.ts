import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * model-schemes-changed 广播静态契约（回归跨窗口数据一致性）。
 *
 * 根因：方案管理迁为独立窗口后，禁用/删除/切换方案发生在独立 JS 堆，
 * 主窗口 modelSchemeStore 无刷新机制 → 主窗口方案下拉（SchemeSelector）显示 stale 数据
 * （已禁用方案仍显示）。修复：主进程 model-scheme 写路径（save/delete/set-active）
 * 成功后广播 model-schemes-changed 给其他窗口；主窗口订阅后重新 hydration。
 * 广播模式对齐 theme-changed（window.ts set-window-theme）。
 */

const IPC_TS = path.resolve(process.cwd(), 'src/main/modelSchemeIPC.ts')
const PRELOAD_TS = path.resolve(process.cwd(), 'src/preload/index.ts')
const APP_TS = path.resolve(process.cwd(), 'src/renderer/App.tsx')

describe('modelSchemeIPC.ts — model-schemes-changed 广播', () => {
    it('写路径统一走公共 helper broadcastToOtherWindows（getAllWindows + 跳过 sender）', () => {
        const src = fs.readFileSync(IPC_TS, 'utf-8')
        expect(src).toContain("broadcastToOtherWindows(event, 'model-schemes-changed')")
        expect(src).not.toContain('function broadcastModelSchemesChanged')
    })

    it('model-scheme:save handler 成功后调用广播', () => {
        const src = fs.readFileSync(IPC_TS, 'utf-8')
        const startIdx = src.indexOf("ipcMain.handle('model-scheme:save'")
        expect(startIdx).toBeGreaterThan(-1)
        const block = src.slice(startIdx, startIdx + 800)
        expect(block).toContain("broadcastToOtherWindows(event, 'model-schemes-changed')")
    })

    it('model-scheme:delete handler 成功后调用广播', () => {
        const src = fs.readFileSync(IPC_TS, 'utf-8')
        const startIdx = src.indexOf("ipcMain.handle('model-scheme:delete'")
        expect(startIdx).toBeGreaterThan(-1)
        const block = src.slice(startIdx, startIdx + 600)
        expect(block).toContain("broadcastToOtherWindows(event, 'model-schemes-changed')")
    })

    it('model-scheme:set-active handler 成功后调用广播', () => {
        const src = fs.readFileSync(IPC_TS, 'utf-8')
        const startIdx = src.indexOf("ipcMain.handle('model-scheme:set-active'")
        expect(startIdx).toBeGreaterThan(-1)
        // set-active handler 较长（含工具状态同步），断言到下一个 handler 为止
        const endIdx = src.indexOf("model-scheme:get-active-id")
        const block = src.slice(startIdx, endIdx)
        expect(block).toContain("broadcastToOtherWindows(event, 'model-schemes-changed')")
    })
})

describe('跨窗口订阅链路', () => {
    it('preload 暴露 onModelSchemesChanged（订阅 model-schemes-changed）', () => {
        const src = fs.readFileSync(PRELOAD_TS, 'utf-8')
        expect(src).toContain('onModelSchemesChanged')
        expect(src).toContain("'model-schemes-changed'")
    })

    it('App.tsx 订阅 onModelSchemesChanged 并触发 modelSchemeStore 重新 hydration', () => {
        const src = fs.readFileSync(APP_TS, 'utf-8')
        expect(src).toContain('onModelSchemesChanged')
        expect(src).toContain('useModelSchemeStore.persist.rehydrate')
    })
})
