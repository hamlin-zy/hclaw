import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * close-window IPC 静态契约测试。
 *
 * 根因：`ipcMain.handle('close-window', () => { mainWindow?.close() })` 无条件
 * 关闭主窗口——MemoEditDialog 等配置子窗口（TitleBar 无关）调用 closeWindow
 * 保存/取消时会错误地连带隐藏/关闭主窗口。
 *
 * 修复契约：handler 必须通过 `BrowserWindow.fromWebContents(event.sender)`
 * 关闭"发起调用的窗口自身"，不得引用 mainWindow。
 */
const WINDOW_TS = path.resolve(process.cwd(), 'src/main/window.ts')

function readHandlerBlock(): string {
    const src = fs.readFileSync(WINDOW_TS, 'utf-8')
    const start = src.indexOf("ipcMain.handle('close-window'")
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf("ipcMain.handle('is-maximized'")
    return src.slice(start, end)
}

describe('window.ts — close-window IPC', () => {
    it('handler 通过 event.sender 定位调用方窗口（fromWebContents）', () => {
        const block = readHandlerBlock()
        expect(block).toContain('(event)')
        expect(block).toContain('BrowserWindow.fromWebContents(event.sender)')
    })

    it('handler 不再无条件关闭主窗口（不引用 mainWindow）', () => {
        const block = readHandlerBlock()
        expect(block).not.toContain('mainWindow')
    })
})
