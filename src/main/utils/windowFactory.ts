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

/** 幂等注册 ipcMain.handle：同 channel 重复创建时先移除旧 handler（窗口关闭后重开场景） */
function safeHandle(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any): void {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, listener)
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

    // 窗口控制 IPC：闭包引用当前 win 实例（同 id 重开时 safeHandle 幂等替换）
    safeHandle(`${id}:minimize`, () => {
        if (!win.isDestroyed()) win.minimize()
    })
    safeHandle(`${id}:maximize`, () => {
        if (win.isDestroyed()) return
        if (win.isMaximized()) {
            win.unmaximize()
        } else {
            win.maximize()
        }
    })
    safeHandle(`${id}:close`, () => {
        if (!win.isDestroyed()) win.close()
    })
    safeHandle(`${id}:is-maximized`, () => {
        return win.isDestroyed() ? false : win.isMaximized()
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
