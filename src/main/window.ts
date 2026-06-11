import {app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell} from 'electron';
import fsPromises from 'fs/promises';
import path from 'path';
import os from 'os';
import {getTray, getTrayIconLoaded} from './tray';
import {getAppIcon} from './utils/icon';
import {createLogger} from './agent/logger';
import {systemSettingsRepo} from './repositories/sqlite/systemSettingsRepository';

const logger = createLogger('window');

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

/** 渲染进程崩溃恢复的冷却时间（ms），防止无限循环 */
const RECOVERY_COOLDOWN_MS = 5000;
/** 记录上次恢复时间，用于冷却判断 */
let lastRecoveryTime = 0;

// ========================================
// 类型定义
// ========================================
type ThemeMode = 'light' | 'dark';

// ========================================
// 常量配置
// ========================================

/** 标题栏高度 (px) - 必须与 CSS --titlebar-height 一致 */
export const TITLEBAR_HEIGHT = 33;

/** 窗口最小尺寸 */
export const WINDOW_MIN_WIDTH = 700;
export const WINDOW_MIN_HEIGHT = 700;

/** 窗口默认尺寸（在足够大的屏幕上使用的最大尺寸） */
export const WINDOW_DEFAULT_WIDTH = 1400;
export const WINDOW_DEFAULT_HEIGHT = 900;

/** 窗口占屏幕工作区的比例（0~1），用于自适应缩放 */
const WINDOW_SCREEN_RATIO = 0.75;

/** 根据当前主显示器分辨率计算自适应窗口尺寸 */
function getAdaptiveWindowSize(): { width: number; height: number } {
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    const ratioWidth = Math.round(workArea.width * WINDOW_SCREEN_RATIO);
    const ratioHeight = Math.round(workArea.height * WINDOW_SCREEN_RATIO);

    return {
        // 取 [min, ratio, default] 的中位数：满足最小要求，也不超过默认值和工作区
        width: Math.min(
            Math.max(ratioWidth, WINDOW_MIN_WIDTH),
            WINDOW_DEFAULT_WIDTH,
            workArea.width
        ),
        height: Math.min(
            Math.max(ratioHeight, WINDOW_MIN_HEIGHT),
            WINDOW_DEFAULT_HEIGHT,
            workArea.height
        ),
    };
}

// ========================================
// 窗口状态持久化（尺寸 + 最大化）
// ========================================
const WINDOW_STATE_KEY = 'window_state';

interface WindowState {
    width: number;
    height: number;
    isMaximized: boolean;
}

/** 持久化保存当前窗口状态到 SQLite */
function saveWindowState(): void {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
        const [width, height] = mainWindow.getSize();
        const isMaximized = mainWindow.isMaximized();
        systemSettingsRepo.setJson(WINDOW_STATE_KEY, {width, height, isMaximized});
    } catch {
        // 静默失败，不影响用户操作
    }
}

/**
 * 从 SQLite 恢复上次窗口状态
 * @returns 上次未最大化时的尺寸；若未保存或上次是最大化则返回 null
 */
function loadWindowState(): {width: number; height: number; shouldMaximize: boolean} | null {
    try {
        const state = systemSettingsRepo.getJson<WindowState>(WINDOW_STATE_KEY);
        if (!state) return null;

        // 上次是最大化 → 创建时用自适应尺寸，创建后再 maximize()
        if (state.isMaximized) {
            return {width: 0, height: 0, shouldMaximize: true};
        }

        // 防呆：保存的尺寸被最小值和当前工作区 clamp
        const workArea = screen.getPrimaryDisplay().workAreaSize;
        const width = Math.min(Math.max(state.width, WINDOW_MIN_WIDTH), workArea.width);
        const height = Math.min(Math.max(state.height, WINDOW_MIN_HEIGHT), workArea.height);

        return {width, height, shouldMaximize: false};
    } catch {
        return null;
    }
}

// ========================================
// 主题配置
// ========================================
const LIGHT_THEME_OVERLAY = {
    color: '#ffffff',
    symbolColor: '#6c757d',
};

const DARK_THEME_OVERLAY = {
    color: '#1a1a1a',
    symbolColor: '#a0a0a0',
};

/** 获取主题对应的 Overlay 配置 */
function getOverlayConfig(theme: ThemeMode) {
    return theme === 'dark' ? DARK_THEME_OVERLAY : LIGHT_THEME_OVERLAY;
}

// ========================================
// 窗口管理器
// ========================================

/** 获取主窗口引用 */
export function getMainWindow(): BrowserWindow | null {
    return mainWindow;
}

/** 设置主窗口引用（由 createWindow 内部使用） */
export function setMainWindow(win: BrowserWindow | null): void {
    mainWindow = win;
}

/** 获取退出标记 */
export function getIsQuitting(): boolean {
    return isQuitting;
}

/** 设置退出标记 */
export function setIsQuitting(value: boolean): void {
    isQuitting = value;
}

// ========================================
// 窗口创建
// ========================================

/** 更新窗口控制按钮 Overlay（Windows 专用） */
export function updateTitleBarOverlay(theme: ThemeMode): void {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    // 确保在 Windows 平台上执行
    if (process.platform !== 'win32') return;

    try {
        mainWindow.setTitleBarOverlay({
            ...getOverlayConfig(theme),
            height: TITLEBAR_HEIGHT,
        });
    } catch (err) {
        // Titlebar overlay 未启用时静默忽略（窗口需使用 frame:false + titleBarOverlay:true）
    }
}

/** 创建主窗口 */
export const createWindow = (): void => {
    const icon = getAppIcon();

    // ── 读取主题配置，渲染窗口前就确定正确主题，避免闪现 ──
    // initialTheme: 映射后的 dark/light，仅用于 backgroundColor
    // rawThemeForRenderer: 原始主题名（'dark'/'light'/'yuanshandai'/'shiyangjin'），传递给渲染进程
    let initialTheme: 'light' | 'dark' = 'light'
    let rawThemeForRenderer: string = 'light'
    try {
        const settings = systemSettingsRepo.getJson<{ ui?: { theme?: string } }>('settings')
        const themeSetting = settings?.ui?.theme
        if (themeSetting === 'dark') {
            initialTheme = 'dark'
            rawThemeForRenderer = 'dark'
        } else if (themeSetting === 'light') {
            initialTheme = 'light'
            rawThemeForRenderer = 'light'
        } else if (themeSetting === 'yuanshandai') {
            initialTheme = 'dark'        // 远山黛是深色主题 → dark bg
            rawThemeForRenderer = 'yuanshandai'  // 但传递给渲染进程的必须是原始名称
        } else if (themeSetting === 'shiyangjin') {
            initialTheme = 'light'       // 十样锦是浅色主题 → light bg
            rawThemeForRenderer = 'shiyangjin'   // 原始名称传递
        } else {
            initialTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
            rawThemeForRenderer = initialTheme
        }
    } catch {
        // SQLite 未就绪时使用默认值
    }

    // ── 平台检测 ──
    const isMac = process.platform === 'darwin'
    let isWin11 = false
    if (process.platform === 'win32') {
        const winBuild = parseInt(os.release().split('.')[2] || '0', 10)
        isWin11 = winBuild >= 22000
    }

    // ── 尝试从上次保存的状态恢复窗口尺寸，无保存则用自适应值 ──
    const savedState = loadWindowState();
    const adaptiveSize = getAdaptiveWindowSize();
    const [initWidth, initHeight] = savedState
        ? [savedState.width, savedState.height]
        : [adaptiveSize.width, adaptiveSize.height];

    const workArea = screen.getPrimaryDisplay().workAreaSize;
    // resize 最小约束也不能超出屏幕可用空间（小屏幕降级为屏幕宽度作为 minWidth）
    const adaptiveMinWidth = Math.min(WINDOW_MIN_WIDTH, workArea.width);
    const adaptiveMinHeight = Math.min(WINDOW_MIN_HEIGHT, workArea.height);

    mainWindow = new BrowserWindow({
        // ---- 尺寸配置 ----
        width: initWidth,
        height: initHeight,
        minWidth: adaptiveMinWidth,
        minHeight: adaptiveMinHeight,

        // ---- 窗口框架配置 ----
        /**
         * 平台差异化框架配置：
         *
         * macOS: 使用 titleBarStyle: 'hiddenInset'
         *   - 保留原生交通灯按钮（红绿灯），隐藏标题文字
         *   - 窗口阴影、磁吸边缘、全屏等原生行为均保留
         *   - 自定义 TitleBar 渲染在交通灯下方
         *
         * Windows/Linux: 使用 frame: false
         *   - 移除原生窗口框架，由渲染进程 TitleBar 完全接管
         *   - Win11 配合 roundedCorners: true 启用原生 DWM 圆角
         *   - Win10 方角窗口，无透明带来的软件渲染开销
         */
        ...(isMac
            ? {titleBarStyle: 'hiddenInset' as const}
            : {frame: false}
        ),

        /**
         * transparent: false
         * 作用：禁用透明窗口，避免强制软件合成（200-500MB 额外内存）
         *
         * Win11 使用 DWM 原生圆角（roundedCorners: true）
         * Win10 使用方角，与操作系统原生风格一致
         *
         * macOS: roundedCorners 默认 true，保留原生窗口圆角 + 交通灯按钮
         *   ⚠️ 注意：Electron 42+ 中 roundedCorners 在 macOS 上同样生效（@platform darwin,win32），
         *     设置 false 会禁用原生圆角并可能影响交通灯按钮渲染
         * Win11: 使用 DWM 原生圆角
         * 其他: 方角
         */
        transparent: false,
        backgroundColor: initialTheme === 'dark' ? '#1e1e1e' : '#ffffff',
        roundedCorners: isMac || isWin11,

        // ---- 图标配置 ----
        icon,

        // ---- WebPreferences ----
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            additionalArguments: [
                `--hclaw-theme=${rawThemeForRenderer}`,
                `--hclaw-win11=${isWin11 ? '1' : '0'}`,
                `--hclaw-darwin=${isMac ? '1' : '0'}`,
            ],
            // 允许渲染进程加载本地文件（file://），用于 Markdown 图片渲染
            // 注意：contextIsolation: true 已将主进程 Node.js 与渲染进程隔离，风险可控
            webSecurity: false,
        },

        // ---- 显示控制 ----
        show: false,
    });

    // 拦截 window.open()：转到内置浏览器窗口
    mainWindow.webContents.setWindowOpenHandler(({url}) => {
        createBrowserWindow(url);
        return {action: 'deny'};
    });

    // 优化：窗口准备好后再显示，避免白屏闪烁
    mainWindow.once('ready-to-show', () => {
        if (savedState?.shouldMaximize) {
            mainWindow?.maximize();
        }
        mainWindow?.show();
    });

    // ---- 加载内容 ----
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
        // 开发阶段如需 DevTools，手动 F12 打开即可
        // 自动打开 DevTools 会在空闲状态下额外消耗 CPU（DevTools 进程 95 线程 + IPC 开销）
        mainWindow.webContents.openDevTools({mode: 'detach'});
    } else {
        mainWindow.loadFile(
            path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
        );
    }

    // ---- 事件监听 ----
    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // 关闭前持久化窗口状态（无论退出还是隐藏到托盘，都先保存）
    mainWindow.on('close', () => {
        saveWindowState();
    });

    // 托盘逻辑：点击关闭按钮时最小化到托盘
    mainWindow.on('close', (event) => {
        if (!isQuitting && getTray() && getTrayIconLoaded()) {
            event.preventDefault();
            mainWindow?.hide();
        }
    });

    // 监听最大化状态变化（用于更新 UI + 持久化）
    mainWindow.on('maximize', () => {
        mainWindow?.webContents.send('window-maximized-changed', true);
        saveWindowState();
    });

    mainWindow.on('unmaximize', () => {
        mainWindow?.webContents.send('window-maximized-changed', false);
        saveWindowState();
    });

    // ---- 渲染进程崩溃/断连恢复 ----
    // 开发环境 Vite HMR WebSocket 断连、DevTools 内存溢出等都可能触发渲染进程崩溃
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        const {reason, exitCode} = details;
        logger.error('render-process-gone', {reason, exitCode});

        // 如果正在退出，不恢复
        if (isQuitting) return;

        // 冷却检查：防止无限循环 crash-reload
        const now = Date.now();
        if (now - lastRecoveryTime < RECOVERY_COOLDOWN_MS) {
            logger.warn('render-process-gone', {message: '恢复冷却中，跳过自动恢复', reason});
            // 通知托盘/用户：应用已崩溃，需要手动重启
            return;
        }
        lastRecoveryTime = now;

        // 延迟一小段时间再恢复，确保进程资源已完全释放
        setTimeout(() => {
            try {
                if (mainWindow?.isDestroyed()) {
                    // 窗口已销毁→重建
                    createWindow();
                } else {
                    // 窗口还在→重新加载
                    mainWindow?.webContents.reload();
                }
                logger.info('render-process-recovered', {reason});
            } catch (err: any) {
                logger.error('render-process-recovery-failed', {error: err.message});
            }
        }, 500);
    });

    // 加载失败时重试（常见于 Vite dev server 临时断连）
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        // 仅处理开发环境的加载失败（生产环境用户主动刷新即可）
        if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) return;
        // ABORTED 是用户主动导航取消，不需恢复
        if (errorCode === -3) return;

        logger.warn('did-fail-load', {errorCode, errorDescription});

        const now = Date.now();
        if (now - lastRecoveryTime < RECOVERY_COOLDOWN_MS) return;
        lastRecoveryTime = now;

        // 延迟重试，等 Vite dev server 恢复
        setTimeout(() => {
            try {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
                    logger.info('did-fail-load-retry', {url: MAIN_WINDOW_VITE_DEV_SERVER_URL});
                }
            } catch (err: any) {
                logger.error('did-fail-load-retry-failed', {error: err.message});
            }
        }, 2000);
    });

    // 进程无响应时尝试恢复
    mainWindow.webContents.on('unresponsive', () => {
        logger.warn('renderer-unresponsive', {message: '渲染进程无响应，等待恢复...'});
        // 给进程 10 秒恢复，如果还无响应则使用恢复冷却机制
        setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed() && !(mainWindow.webContents as any).isResponsive?.()) {
                logger.warn('renderer-unresponsive', {message: '渲染进程持续无响应，尝试恢复'});
                const now = Date.now();
                if (now - lastRecoveryTime < RECOVERY_COOLDOWN_MS) return;
                lastRecoveryTime = now;
                mainWindow.webContents.reload();
            }
        }, 10000);
    });

    // ---- DevTools hint (development only) ----
    if (process.env.NODE_ENV === 'development') {
        // DevTools enabled in development mode
    }
};

// ========================================
// IPC Handlers
// ========================================

/** 注册窗口控制相关 IPC handlers */
export function initWindowIPC(): void {
    // ---- 系统信息 ----
    ipcMain.handle('get-app-version', () => {
        return app.getVersion();
    });

    ipcMain.handle('get-platform', () => {
        return process.platform;
    });

    // ---- 窗口控制 ----
    ipcMain.handle('minimize-window', () => {
        mainWindow?.minimize();
    });

    ipcMain.handle('maximize-window', () => {
        if (mainWindow?.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow?.maximize();
        }
    });

    ipcMain.handle('close-window', () => {
        mainWindow?.close();
    });

    ipcMain.handle('is-maximized', () => {
        return mainWindow?.isMaximized();
    });

    /** 设置窗口主题（同步更新 titleBarOverlay） */
    ipcMain.handle('set-window-theme', (_event, theme: ThemeMode) => {
        updateTitleBarOverlay(theme);
    });

    /** 检测 Windows 11（渲染进程通过 preload 调用） */
    ipcMain.handle('is-windows-11', () => {
        if (process.platform !== 'win32') return false
        const winBuild = parseInt(os.release().split('.')[2] || '0', 10)
        return winBuild >= 22000
    });

    // ---- 文件对话框 ----
    ipcMain.handle('open-folder-dialog', async () => {
        if (!mainWindow) return null;
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
            title: '选择工作目录',
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
    });

    ipcMain.handle('select-file-path', async () => {
        if (!mainWindow) return null;
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile'],
            title: '选择文件',
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
    });

    ipcMain.handle('open-path', async (_event, filePath: string) => {
        try {
            const result = await shell.openPath(filePath);
            return result;
        } catch (error) {
            return String(error);
        }
    });

    // ---- 工作目录文件浏览 ----
    ipcMain.handle('workspace-read-dir', async (_event, dirPath: string) => {
        try {
            const entries = await fsPromises.readdir(dirPath, {withFileTypes: true});
            return entries.map(entry => ({
                name: entry.name,
                path: path.join(dirPath, entry.name),
                isDirectory: entry.isDirectory(),
            }));
        } catch {
            return [];
        }
    });

    /** 读取文件并返回 base64 Data URL（用于图片预览等） */
    ipcMain.handle('read-file-as-data-url', async (_event, filePath: string) => {
        try {
            const buffer = await fsPromises.readFile(filePath);
            const base64 = buffer.toString('base64');
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes: Record<string, string> = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
                '.bmp': 'image/bmp',
                '.svg': 'image/svg+xml',
                '.ico': 'image/x-icon',
                '.mp3': 'audio/mpeg',
                '.wav': 'audio/wav',
                '.flac': 'audio/flac',
                '.aac': 'audio/aac',
                '.ogg': 'audio/ogg',
                '.m4a': 'audio/mp4',
                '.wma': 'audio/x-ms-wma',
                '.opus': 'audio/opus',
            };
            const mime = mimeTypes[ext] || 'application/octet-stream';
            return `data:${mime};base64,${base64}`;
        } catch (error) {
            return null;
        }
    });

    // ---- 崩溃恢复 ----
    /** 强制重载渲染进程（渲染进程崩溃后，用户可通过托盘菜单触发） */
    ipcMain.handle('reload-window', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
                mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
            } else {
                mainWindow.webContents.reload();
            }
            mainWindow.show();
            mainWindow.focus();
            return {success: true};
        }
        return {success: false, error: '窗口已销毁'};
    });

    /** 强制关闭窗口（绕过 close-to-tray 逻辑） */
    ipcMain.handle('force-close-window', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.destroy();
            return {success: true};
        }
        return {success: false, error: '窗口已销毁'};
    });

    /** 读取文件并返回原始 Buffer（用于音频播放，避免 base64 / 协议处理器多次调用） */
    ipcMain.handle('read-file-buffer', async (_event, filePath: string) => {
        try {
            const buffer = await fsPromises.readFile(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes: Record<string, string> = {
                '.mp3': 'audio/mpeg',
                '.wav': 'audio/wav',
                '.flac': 'audio/flac',
                '.aac': 'audio/aac',
                '.ogg': 'audio/ogg',
                '.m4a': 'audio/mp4',
                '.wma': 'audio/x-ms-wma',
                '.opus': 'audio/opus',
            };
            const mimeType = mimeTypes[ext] || 'application/octet-stream';
            return {data: new Uint8Array(buffer), mimeType};
        } catch {
            return null;
        }
    });

    ipcMain.handle('show-item-in-folder', async (_event, filePath: string) => {
        try {
            shell.showItemInFolder(filePath);
            return {success: true};
        } catch (error) {
            return {success: false, error: String(error)};
        }
    });

    /** 内置浏览器打开链接 */
    ipcMain.handle('open-builtin', async (_event, url: string) => {
        try {
            const parsedUrl = new URL(url);
            if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
                createBrowserWindow(url);
                return {success: true};
            } else {
                return {success: false, error: 'Only http/https URLs are supported by built-in browser'};
            }
        } catch (error) {
            return {success: false, error: String(error)};
        }
    });

    /** 系统默认浏览器打开链接 */
    ipcMain.handle('open-system', async (_event, url: string) => {
        try {
            await shell.openExternal(url);
            return {success: true};
        } catch (error) {
            return {success: false, error: String(error)};
        }
    });

    /** 向后兼容的 open-external */
    ipcMain.handle('open-external', async (_event, url: string) => {
        try {
            const parsedUrl = new URL(url);
            if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
                createBrowserWindow(url);
                return {success: true};
            } else {
                return {success: false, error: 'Only http/https URLs are allowed'};
            }
        } catch (error) {
            return {success: false, error: String(error)};
        }
    });

    ipcMain.handle('open-skill-file-dialog', async () => {
        if (!mainWindow) return null;
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile'],
            filters: [{name: 'Skill ZIP', extensions: ['zip']}],
            title: '选择技能安装包 (.zip)',
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
    });
}

/**
 * 创建内置浏览器窗口
 *
 * 特性:
 * - 标题「HClaw 内置浏览器」，去除原生菜单栏
 * - 平台差异化框架：
 *   - macOS: frame: true (原生框架自带交通灯按钮，可直接关闭/缩放)
 *   - Windows: frameless + titleBarOverlay 优化边框样式
 *   - Linux: frameless
 * - 新窗口链接也在内置浏览器中打开
 */
function createBrowserWindow(url: string): BrowserWindow {
    const isMac = process.platform === 'darwin';
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 600,
        minHeight: 400,
        title: 'HClaw 内置浏览器',
        autoHideMenuBar: true,
        ...(isMac
            ? {frame: true}
            : {
                frame: false,
                titleBarOverlay: {
                    color: '#1e1e2e',
                    symbolColor: '#cdd6f4',
                    height: 36,
                },
            }
        ),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });

    win.loadURL(url);

    // 注入自定义滚动条样式（覆盖外部网站的系统原生滚动条）
    win.webContents.on('did-finish-load', () => {
        win.webContents.insertCSS(`
            ::-webkit-scrollbar { width: 6px !important; height: 6px !important; background: transparent !important; }
            ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15) !important; border-radius: 3px !important; }
            ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25) !important; }
            ::-webkit-scrollbar-button { display: none !important; }
        `).catch(() => {});
    });

    // 拦截新窗口：也在内置浏览器中打开
    win.webContents.setWindowOpenHandler(({url: targetUrl}) => {
        createBrowserWindow(targetUrl);
        return {action: 'deny'};
    });

    return win;
}
