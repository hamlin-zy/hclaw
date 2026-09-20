/**
 * 通用独立窗口工厂
 *
 * 收敛 usageWindow / 配置窗口等独立窗口创建的复制粘贴：
 * 无边框创建、主题三参数注入、窗口控制 IPC 注册、加载入口统一在此实现。
 * 数据 IPC 留在各窗口模块，不并入工厂。
 * 职责边界：工厂只负责「窗口创建 + 窗口控制 IPC + 加载」；单例/注册表由调用方维护。
 */
import {BrowserWindow, ipcMain} from 'electron'
import path from 'path'
import os from 'os'
import {getAppIconPath} from './icon'
import {readThemeSetting} from './theme'
import {createLogger} from '../agent/logger'
import {isDevMode, isViteDevServer} from './devMode'
import {safeHandle} from '../lib/safeHandle'

const logger = createLogger('windowFactory')

export interface AppWindowOptions {
    /** 窗口 id：IPC 命名空间 + 渲染进程身份（--hclaw-window-id） */
    id: string
    /** 窗口标题 */
    title: string
    /** 渲染入口 html 文件名（如 'usage.html'），开发模式走 Vite dev server */
    entryHtml: string
    width: number
    height: number
    minWidth: number
    minHeight: number
    /** 追加到 additionalArguments 的参数（如 --hclaw-dialog=<type>） */
    additionalArguments?: string[]
    /** 开发模式是否自动打开 DevTools（默认开；配置窗口传 false 关闭） */
    devTools?: boolean
}

export function createAppWindow(options: AppWindowOptions): BrowserWindow {
    const {id, title, entryHtml, additionalArguments = [], devTools = true} = options
    const iconPath = getAppIconPath()
    const {backgroundColor, rawTheme} = readThemeSetting()

    // 平台检测（与主窗口 window.ts 一致）
    const isMac = process.platform === 'darwin'
    let isWin11 = false
    if (process.platform === 'win32') {
        const winBuild = parseInt(os.release().split('.')[2] || '0', 10)
        isWin11 = winBuild >= 22000
    }

    const win = new BrowserWindow({
        width: options.width,
        height: options.height,
        minWidth: options.minWidth,
        minHeight: options.minHeight,
        icon: iconPath,
        backgroundColor: backgroundColor === 'dark' ? '#1e1e1e' : '#ffffff',
        // 无边框窗口（参考主窗口）：Windows/Linux 移除原生框架，macOS 保留交通灯
        ...(isMac
            ? {titleBarStyle: 'hiddenInset' as const}
            : {frame: false}
        ),
        transparent: false,
        roundedCorners: isMac || isWin11,

        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            additionalArguments: [
                `--hclaw-theme=${rawTheme}`,
                `--hclaw-win11=${isWin11 ? '1' : '0'}`,
                `--hclaw-darwin=${isMac ? '1' : '0'}`,
                `--hclaw-window-id=${id}`,
                `--hclaw-dev=${isDevMode() ? '1' : '0'}`,
                ...additionalArguments,
            ],
        },
        show: false,
        title,
    })

    win.setMenu(null)
    win.setMenuBarVisibility(false)
    // 拦截页面 document.title 覆盖：各窗口入口 html 的 <title> 是共享的静态文案，
    // 若不拦截，页面加载后任务栏会统一显示该文案而非构造时传入的 title
    win.on('page-title-updated', (event) => event.preventDefault())
    win.once('ready-to-show', () => {
        if (!win.isDestroyed()) win.show()
    })

    // 最大化状态广播给渲染进程（更新最大化/还原按钮）
    win.on('maximize', () => win.webContents.send(`${id}-maximized-changed`, true))
    win.on('unmaximize', () => win.webContents.send(`${id}-maximized-changed`, false))

    // dev-only：转发渲染进程内存水位日志到主进程 logger 落盘（spec §3.1 泄漏诊断链路）
    // Electron 43 WebContents 新签名：单对象参数 Event<WebContentsConsoleMessageEventParams>
    if (process.env.NODE_ENV === 'development' || process.argv.includes('--inspect')) {
        win.webContents.on('console-message', (details) => {
            const {message} = details
            if (typeof message === 'string' && message.startsWith('[mem-watermark]')) {
                logger.info('watermark', {payload: message.slice('[mem-watermark]'.length).trim()})
            }
        })
    }

    // 关窗拦截（opt-in，Spec §4.5 记忆管理关窗结算）：渲染层 setCloseIntercept(true)
    // 武装后，close 事件被 preventDefault 并向渲染层发 `${id}-close-request`，
    // 渲染层结算后调 confirm-close 真正关窗；2s 内未响应则主进程兜底强关防挂死。
    // 未武装（默认）时 close 直接放行，行为与其余窗口一致。
    let closeInterceptArmed = false
    let closeConfirmed = false
    let closeFallbackTimer: ReturnType<typeof setTimeout> | null = null

    win.on('close', (e) => {
        if (!closeInterceptArmed || closeConfirmed) return
        // 渲染层已销毁/不可达：无法结算，直接放行防挂死
        if (win.webContents.isDestroyed()) {
            closeConfirmed = true
            return
        }
        e.preventDefault()
        win.webContents.send(`${id}-close-request`)
        if (closeFallbackTimer === null) {
            closeFallbackTimer = setTimeout(() => {
                closeFallbackTimer = null
                if (!win.isDestroyed()) {
                    closeConfirmed = true
                    win.close()
                }
            }, 2000)
        }
    })
    win.on('closed', () => {
        if (closeFallbackTimer !== null) {
            clearTimeout(closeFallbackTimer)
            closeFallbackTimer = null
        }
    })

    // 窗口控制 IPC：按 event.sender 解析目标窗口，而非闭包 win —— 同 id 可开多实例
    // （如项目管理窗口），固定 channel + 闭包会让 handler 永远指向最后创建的窗口，
    // 其他实例的关闭/最小化按钮全部失效。fromWebContents 兜底闭包 win（重开竞态时
    // sender 可能已销毁，与旧行为一致地 no-op）。
    safeHandle(`${id}:set-close-intercept`, (event, enabled: boolean) => {
        const target = BrowserWindow.fromWebContents(event.sender) ?? win
        if (target !== win) return
        closeInterceptArmed = !!enabled
    })
    safeHandle(`${id}:confirm-close`, (event) => {
        const target = BrowserWindow.fromWebContents(event.sender) ?? win
        if (target.isDestroyed()) return
        // 置位收进 target === win 分支：channel 绑定最后创建实例的闭包，
        // 早期实例（target !== win）的 confirm-close 不得污染本闭包的
        // closeConfirmed，否则本实例的关窗拦截被旁路、结算流程被跳过。
        if (target === win) {
            if (closeFallbackTimer !== null) {
                clearTimeout(closeFallbackTimer)
                closeFallbackTimer = null
            }
            closeConfirmed = true
        }
        target.close()
    })
    safeHandle(`${id}:cancel-close`, (event) => {
        const target = BrowserWindow.fromWebContents(event.sender) ?? win
        if (target !== win) return
        if (closeFallbackTimer !== null) {
            clearTimeout(closeFallbackTimer)
            closeFallbackTimer = null
        }
    })
    safeHandle(`${id}:minimize`, (event) => {
        const target = BrowserWindow.fromWebContents(event.sender) ?? win
        if (!target.isDestroyed()) target.minimize()
    })
    safeHandle(`${id}:maximize`, (event) => {
        const target = BrowserWindow.fromWebContents(event.sender) ?? win
        if (target.isDestroyed()) return
        if (target.isMaximized()) {
            target.unmaximize()
        } else {
            target.maximize()
        }
    })
    safeHandle(`${id}:close`, (event) => {
        const target = BrowserWindow.fromWebContents(event.sender) ?? win
        if (!target.isDestroyed()) target.close()
    })
    safeHandle(`${id}:is-maximized`, (event) => {
        const target = BrowserWindow.fromWebContents(event.sender) ?? win
        return target.isDestroyed() ? false : target.isMaximized()
    })

    // 加载页面（加载决策用 isViteDevServer：不含 --devtools，否则打包版 --devtools 启动时
    // 会尝试连不存在的 dev server 导致所有独立窗口黑屏）
    const isDev = isViteDevServer()
    if (isDev) {
        win.loadURL(`http://localhost:5173/${entryHtml}`)
        if (devTools) win.webContents.openDevTools({mode: 'detach'})
    } else {
        win.loadFile(path.join(__dirname, `../renderer/main_window/${entryHtml}`))
    }

    return win
}
