/**
 * 配置对话框独立窗口注册表
 *
 * 同类型单例（重复打开 focus 已有窗口），不同类型并行。
 * 窗口创建走 windowFactory；数据层复用渲染进程 store + sqliteStorage，无需新 IPC 数据通道。
 */
import {BrowserWindow, ipcMain} from 'electron'
import {createAppWindow} from './windowFactory'

/** 迁移到独立窗口的 dialogType 白名单（17 种，来自 MenuDialogRenderer DIALOG_CONFIG 减去 update-notice） */
export const CONFIG_DIALOG_TYPES = new Set([
    'permission-rules',
    'llm-config', 'scheme-config', 'mcp', 'tools', 'agents', 'skills',
    'plugins', 'commands', 'schedules', 'channels',
    'prompt-config', 'settings', 'conversations',
    'tool-list', 'system-prompt', 'about',
    'llm-logs', 'usage',
])

/** 窗口标题（与 MenuDialogRenderer DIALOG_CONFIG 的 title 对齐） */
const DIALOG_TITLES: Record<string, string> = {
    'permission-rules': '权限规则',
    'llm-config': '模型配置',
    'scheme-config': '模型方案',
    'mcp': 'MCP 服务',
    'tools': '工具管理',
    'agents': 'Agents',
    'skills': 'Skills',
    'plugins': '插件管理',
    'commands': '命令管理',
    'schedules': '定时任务',
    'channels': '渠道管理',
    'prompt-config': '提示词方案',
    'settings': '系统设置',
    'conversations': '会话管理',
    'tool-list': '工具列表预览',
    'system-prompt': '系统提示词预览',
    'about': '关于 HClaw',
    'llm-logs': 'LLM 调用日志',
    'usage': '用量统计',
}

/** 窗口尺寸：沿用 MenuDialogRenderer DIALOG_CONFIG 的 initialWidth/minWidth/initialHeight */
const DIALOG_SIZES: Record<string, {width: number; minWidth?: number; height?: number}> = {
    'permission-rules': {width: 680},
    'llm-config': {width: 620},
    'scheme-config': {width: 770},
    'mcp': {width: 680},
    'tools': {width: 580},
    'agents': {width: 600},
    'skills': {width: 580},
    'plugins': {width: 640},
    'commands': {width: 580},
    'schedules': {width: 680},
    'channels': {width: 480},
    'prompt-config': {width: 720},
    'conversations': {width: 780, minWidth: 370},
    'settings': {width: 780},
    'tool-list': {width: 580},
    'system-prompt': {width: 680},
    'about': {width: 400, minWidth: 360, height: 430},
    'llm-logs': {width: 1200, height: 700, minWidth: 800},
    'usage': {width: 1200, height: 700, minWidth: 800},
}
const DEFAULT_DIALOG_SIZE = {width: 680, height: 700, minWidth: 420, minHeight: 400}

const configWindows = new Map<string, BrowserWindow>()

export function openConfigWindow(dialogType: string, onCreated?: (win: BrowserWindow) => void): void {
    if (!CONFIG_DIALOG_TYPES.has(dialogType)) return

    const existing = configWindows.get(dialogType)
    if (existing && !existing.isDestroyed()) {
        existing.focus()
        // 单例复用时同样回传，保证 setLogWindow 不丢引用
        if (onCreated) onCreated(existing)
        return
    }

    const size = DIALOG_SIZES[dialogType] ?? DEFAULT_DIALOG_SIZE
    const win = createAppWindow({
        id: dialogType,
        title: DIALOG_TITLES[dialogType] ?? dialogType,
        entryHtml: 'dialogWindow.html',
        width: size.width,
        height: size.height ?? DEFAULT_DIALOG_SIZE.height,
        minWidth: size.minWidth ?? DEFAULT_DIALOG_SIZE.minWidth,
        minHeight: DEFAULT_DIALOG_SIZE.minHeight,
        additionalArguments: [`--hclaw-dialog=${dialogType}`],
        devTools: false,
    })

    configWindows.set(dialogType, win)
    win.on('closed', () => {
        if (configWindows.get(dialogType) === win) configWindows.delete(dialogType)
    })
    if (onCreated) onCreated(win)
}

export function closeConfigWindow(dialogType: string): void {
    const win = configWindows.get(dialogType)
    if (win && !win.isDestroyed()) win.close()
}

/** 注册 IPC（main/index.ts 调用） */
export function initConfigWindowIPC(): void {
    ipcMain.handle('open-config-window', (_event, dialogType: string) => {
        openConfigWindow(dialogType)
    })
}
