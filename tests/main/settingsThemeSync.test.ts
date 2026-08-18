import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * 设置窗口主题同步链路静态契约（回归修复闭环）。
 *
 * 根因：配置对话框迁为独立窗口（settings-config）后，
 * - saveSettings/updateSettings 只落库 + 同步 Worker（settingsUpdate 不广播渲染窗口），
 *   主窗口与其他独立窗口无法感知主题变更（stale）；
 * - 设置窗口打开时 settingsStore 无 persist 中间件（初始值 = DEFAULT_SETTINGS），
 *   加载的是默认值而非已保存值。
 *
 * 修复闭环（走渲染侧既有 setWindowTheme 权威通道，不改主进程）：
 * - settingsStore 保存成功后调用 setWindowTheme(theme) → 主进程 set-window-theme handler
 *   更新 titleBarOverlay 并广播 theme-changed 给所有窗口；
 * - 主窗口 App.tsx 订阅 theme-changed → resolveAndApplyTheme 刷新 themeStore
 *   （useEffect([theme]) 自动 applyThemeClass + setWindowTheme，重发广播幂等无害，无回环）；
 * - 设置窗口 SettingsDialog 挂载时 loadSettings 显式加载已保存设置。
 */

const SETTINGS_STORE_TS = path.resolve(process.cwd(), 'src/renderer/stores/settingsStore.ts')
const APP_TS = path.resolve(process.cwd(), 'src/renderer/App.tsx')
const SETTINGS_DIALOG_TS = path.resolve(process.cwd(), 'src/renderer/components/dialogs/SettingsDialog.tsx')
const PRELOAD_TS = path.resolve(process.cwd(), 'src/preload/index.ts')
const WINDOW_TS = path.resolve(process.cwd(), 'src/main/window.ts')

describe('settingsStore.ts — 保存成功后触发主题广播', () => {
    it('saveSettings 在 configWrite 成功后调用 setWindowTheme(themeStore 解析后的值)', () => {
        const src = fs.readFileSync(SETTINGS_STORE_TS, 'utf-8')
        // 用 `: async` 锚定函数实现（interface 声明行的 saveSettings:/updateSettings: 不匹配 async 前缀）
        const bodyStart = src.indexOf('saveSettings: async')
        const bodyEnd = src.indexOf('updateSettings: async')
        expect(bodyStart).toBeGreaterThan(-1)
        expect(bodyEnd).toBeGreaterThan(bodyStart)
        const body = src.slice(bodyStart, bodyEnd)
        const count = body.split('setWindowTheme?.(useThemeStore.getState().theme)').length - 1
        expect(count).toBeGreaterThanOrEqual(1)
    })

    it('updateSettings 在 configWrite 成功后调用 setWindowTheme(themeStore 解析后的值)', () => {
        const src = fs.readFileSync(SETTINGS_STORE_TS, 'utf-8')
        const bodyStart = src.indexOf('updateSettings: async')
        expect(bodyStart).toBeGreaterThan(-1)
        const body = src.slice(bodyStart)
        const count = body.split('setWindowTheme?.(useThemeStore.getState().theme)').length - 1
        expect(count).toBeGreaterThanOrEqual(1)
    })

    it('导入 useThemeStore（取解析后主题，避免 \'system\' 原值广播）', () => {
        const src = fs.readFileSync(SETTINGS_STORE_TS, 'utf-8')
        expect(src).toContain('useThemeStore')
        expect(src).toMatch(/import\s*\{[^}]*useThemeStore[^}]*\}\s*from\s*'\.\/themeStore'/)
        // 不允许把原始 ui.theme 直接广播（'system' 会走 titleBarOverlay 浅色兜底/applyThemeClass 不解析）
        expect(src).not.toContain('setWindowTheme?.(pendingSettings.ui.theme)')
        expect(src).not.toContain('setWindowTheme?.(newSettings.ui.theme)')
    })
})

describe('App.tsx — 主窗口订阅 theme-changed', () => {
    it('订阅 onThemeChanged 并在回调中 resolveAndApplyTheme 刷新 themeStore', () => {
        const src = fs.readFileSync(APP_TS, 'utf-8')
        const startIdx = src.indexOf('onThemeChanged')
        expect(startIdx).toBeGreaterThan(-1)
        const block = src.slice(startIdx, startIdx + 500)
        expect(block).toContain('resolveAndApplyTheme')
        // 订阅回调带主题参数，刷新 themeStore 后由 useEffect([theme]) 自动应用 CSS
        expect(block).toContain('(theme: string)')
    })
})

describe('SettingsDialog.tsx — 打开时加载已保存设置', () => {
    it('mount 时调用 loadSettings', () => {
        const src = fs.readFileSync(SETTINGS_DIALOG_TS, 'utf-8')
        expect(src).toContain('useSettingsStore.getState().loadSettings()')
    })
})

describe('preload — 主题 API 暴露', () => {
    it('暴露 setWindowTheme / onThemeChanged 并桥接对应 IPC 通道', () => {
        const src = fs.readFileSync(PRELOAD_TS, 'utf-8')
        expect(src).toContain('setWindowTheme')
        expect(src).toContain('onThemeChanged')
        expect(src).toContain("'set-window-theme'")
        expect(src).toContain("'theme-changed'")
    })
})

describe('window.ts — set-window-theme 广播所有窗口', () => {
    it('set-window-theme handler 块内含 BrowserWindow.getAllWindows() 与 theme-changed', () => {
        const src = fs.readFileSync(WINDOW_TS, 'utf-8')
        const startIdx = src.indexOf("ipcMain.handle('set-window-theme'")
        expect(startIdx).toBeGreaterThan(-1)
        const block = src.slice(startIdx, startIdx + 500)
        expect(block).toContain('BrowserWindow.getAllWindows()')
        expect(block).toContain("'theme-changed'")
    })
})
