import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * backgroundThrottling 回归测试（静态契约）。
 *
 * 根因：窗口最小化期间 Electron 默认节流渲染进程 rAF/timer，但 agent-stream
 * 流式事件处理（queueMicrotask）不受节流，导致事件积压，恢复瞬间一次性涌入
 * 主线程造成 UI 卡死（数分钟无响应）。
 *
 * 修复：主窗口 webPreferences 显式设置 backgroundThrottling: false。
 * 此测试静态断言配置存在且作用于主窗口 BrowserWindow 的 webPreferences，
 * 防止后续重构（如提取配置、改动 webPreferences 结构）时丢失该设置。
 */

const WINDOW_TS = path.resolve(process.cwd(), 'src/main/window.ts')

describe('window.ts — backgroundThrottling 配置', () => {
    it('webPreferences 中显式禁用 backgroundThrottling', () => {
        const src = fs.readFileSync(WINDOW_TS, 'utf-8')
        expect(src).toContain('backgroundThrottling: false')
    })

    it('backgroundThrottling 位于主窗口创建（new BrowserWindow）的 webPreferences 内', () => {
        const src = fs.readFileSync(WINDOW_TS, 'utf-8')
        // 主窗口创建块的边界：找到 new BrowserWindow 到该对象结束
        const startIdx = src.indexOf('mainWindow = new BrowserWindow(')
        expect(startIdx).toBeGreaterThan(-1)
        const block = src.slice(startIdx, startIdx + 4000)
        // 在创建块内必须同时包含 webPreferences 与 backgroundThrottling
        expect(block).toContain('webPreferences:')
        expect(block).toContain('backgroundThrottling: false')
    })

    it('backgroundThrottling 声明在 sandbox/webSecurity 附近（主窗口 webPreferences 集合内）', () => {
        const src = fs.readFileSync(WINDOW_TS, 'utf-8')
        const sandboxIdx = src.indexOf('sandbox: true')
        expect(sandboxIdx).toBeGreaterThan(-1)
        const near = src.slice(sandboxIdx, sandboxIdx + 1200)
        expect(near).toContain('backgroundThrottling: false')
    })
})
