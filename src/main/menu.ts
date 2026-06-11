import {app, Menu, MenuItemConstructorOptions, shell} from 'electron';

/**
 * 创建应用程序菜单
 *
 * ⚠️ 为什么需要这个函数？
 * Electron 会为未显式设置菜单的窗口自动创建默认菜单，
 * 其中包含多个全局快捷键加速器（如 Ctrl+N "新建窗口"）。
 * 这些加速器在主进程拦截键盘事件，导致渲染进程收不到 keydown 事件，
 * 从而让 useGlobalHotkeys 中的同名快捷键失效。
 *
 * 本函数创建一个最小菜单，移除与程序快捷键冲突的加速器，
 * 同时保留平台常见操作（macOS "关于"、"退出"）。
 */
export function createAppMenu(): void {
    const isMac = process.platform === 'darwin';

    const template: MenuItemConstructorOptions[] = [
        // macOS 应用菜单（系统要求必须有）
        ...(isMac ? [{
            label: app.name,
            submenu: [
                {role: 'about' as const},
                {type: 'separator' as const},
                {role: 'hide' as const},
                {role: 'hideOthers' as const},
                {role: 'unhide' as const},
                {type: 'separator' as const},
                {role: 'quit' as const},
            ],
        }] : []),

        // 文件菜单：移除 Ctrl+N 加速器（与"新建会话"冲突）
        {
            label: '文件',
            submenu: [
                ...(isMac ? [{role: 'close' as const}] : [{role: 'quit' as const}]),
            ],
        },

        // 编辑菜单：保留标准加速器（Ctrl+C/V/X/A 等）
        {
            label: '编辑',
            submenu: [
                {role: 'undo' as const},
                {role: 'redo' as const},
                {type: 'separator' as const},
                {role: 'cut' as const},
                {role: 'copy' as const},
                {role: 'paste' as const},
                {role: 'selectAll' as const},
            ],
        },

        // 视图菜单：移除 Ctrl+R（刷新）和 Ctrl+Shift+I（DevTools）等冲突加速器
        {
            label: '视图',
            submenu: [
                {role: 'resetZoom' as const},
                {role: 'zoomIn' as const},
                {role: 'zoomOut' as const},
                {type: 'separator' as const},
                {role: 'togglefullscreen' as const},
            ],
        },

        // 窗口菜单：移除 Ctrl+M（最小化），统一由 Ctrl+Shift+Space 控制隐藏/显示
        {
            label: '窗口',
            submenu: [
                {role: 'zoom' as const},
                ...(isMac ? [
                    {type: 'separator' as const},
                    {role: 'front' as const},
                ] : [{role: 'close' as const}]),
            ],
        },

        // 帮助菜单：移除默认的"切换开发者工具"
        {
            label: '帮助',
            submenu: [
                {
                    label: '关于 HClaw',
                    click: () => {
                        shell.openExternal('https://github.com/hclaw/hclaw');
                    },
                },
            ],
        },
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}
