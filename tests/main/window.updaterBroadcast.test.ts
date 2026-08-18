import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * updater 结果广播静态契约（回归 5.2.1 闭环）。
 *
 * 根因：about 迁为独立窗口后，「关于页点检查更新」只经 invoke 返回，主窗口感知不到，
 * 主窗口 update-notice 不再弹出。修复：updater:check-for-update handler 检查完成后
 * 广播 updater:status-changed 给所有窗口；启动时静默检查的推送统一走同一 helper。
 */

const WINDOW_TS = path.resolve(process.cwd(), 'src/main/window.ts')
const INDEX_TS = path.resolve(process.cwd(), 'src/main/index.ts')

describe('window.ts — updater 结果广播', () => {
    it('存在 broadcastUpdaterStatus helper（遍历 BrowserWindow.getAllWindows 发送）', () => {
        const src = fs.readFileSync(WINDOW_TS, 'utf-8')
        expect(src).toContain('export function broadcastUpdaterStatus')
        expect(src).toContain('BrowserWindow.getAllWindows()')
        expect(src).toContain("'updater:status-changed'")
    })

    it('updater:check-for-update handler 在检查完成后调用广播', () => {
        const src = fs.readFileSync(WINDOW_TS, 'utf-8')
        const startIdx = src.indexOf("ipcMain.handle('updater:check-for-update'")
        expect(startIdx).toBeGreaterThan(-1)
        const block = src.slice(startIdx, startIdx + 500)
        expect(block).toContain('checkForUpdate()')
        expect(block).toContain('broadcastUpdaterStatus')
    })

    it('index.ts 启动时静默检查推送统一走 broadcastUpdaterStatus', () => {
        const src = fs.readFileSync(INDEX_TS, 'utf-8')
        expect(src).toContain('broadcastUpdaterStatus')
        expect(src).not.toContain("win.webContents.send('updater:status-changed'")
    })
})
