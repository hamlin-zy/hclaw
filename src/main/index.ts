import {app, BrowserWindow, globalShortcut, protocol} from 'electron';
import path from 'path';
import * as fsPromises from 'fs/promises';

// IMPORTANT: Database must be initialized before any other database-dependent modules
import './repositories/init';

import {ensureConfigLayout, initConfigIPC} from './config';
import {createWindow, getMainWindow, initWindowIPC, setIsQuitting} from './window';
import {createTray} from './tray';
import {registerGlobalShortcuts} from './shortcuts';
import {createAppMenu} from './menu';
import {initConversationIPC} from './conversation';
import {agentManager, initAgent, registerAgentIPC} from './agent';
import {registerMCPEventForwarding, registerMCPIPC, setMainWindow} from './agent/mcp/ipc';
import {migrateHooksFromSqlite, migrateMcpFromSqlite} from './config/migrateMcpHookFromSqlite';
import {mcpService} from './services/mcpService';
import {initLlmCallLogIPC} from './utils/llmCallLogStore';
import {initLlmLogIPC} from './utils/llmCallBuffer';
import {startConfigWatcher} from './config-watcher';
import {initializePlugins, registerPluginIPC} from './plugin/ipc';
import {registerCapabilityIPC} from './capability/ipc';
import {registerHookIPC} from './plugin/hooks/ipc';
import {hookExecutor, registerBuiltinHandlers} from './plugin/hooks';
import {loadHooksFromDirectory} from './agent/hooks/loader';
import {GoogleAuthService, initGoogleAuthIPC} from './auth/googleAuth';
import {initProviderIPC} from './llmProviderIPC';
import {initModelSchemeIPC} from './modelSchemeIPC';
import {initPromptSchemeIPC} from './promptSchemeIPC';
import {promptSchemeRepo} from './repositories/sqlite/promptSchemeRepository';
import {initToolIPC} from './toolIPC';
import {initScheduleIPC} from './scheduler/scheduleIPC';
import {schedulerManager} from './scheduler';
import {channelManager} from './channel/ChannelManager';
import {initChannelIPC} from './channel/channelIPC';
import {createLogger} from './agent/logger';
import {powerManager} from './agent/powerManager';
import {mcpWorkerManager} from './agent/mcp/mcpWorkerManager';
import {runtimeConfigManager} from './agent/runtimeConfigManager';
import {setConfigBridge} from './agent/common/configBridge';
import {permissionEngine} from './agent/tools/permission';
import {createConversationRepository} from './repositories';

const logger = createLogger('app')

// ── 全局未捕获异常/拒绝处理器 ──
process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', {error: err.message, stack: err.stack || ''})
    // 不让 Electron 弹出默认错误对话框
    // 5 秒后退出，让日志有机会刷盘
    setTimeout(() => process.exit(1), 5000)
})

process.on('unhandledRejection', (reason) => {
    const errMsg = reason instanceof Error ? reason.message : String(reason)
    const errStack = reason instanceof Error ? reason.stack : undefined
    logger.error('unhandledRejection', {error: errMsg, stack: errStack || ''})
})

// 注册自定义协议
if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('hclaw', process.execPath, [path.resolve(process.argv[1])]);
    }
} else {
    app.setAsDefaultProtocolClient('hclaw');
}

// 注册 hclaw-media:// 为特权协议（必须在 app.ready 之前注册，否则渲染进程会拒绝加载）
protocol.registerSchemesAsPrivileged([
    {
        scheme: 'hclaw-media',
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true,
        }
    }
])

// ── V8 堆参数优化 ──
// 影响渲染进程 ChildProcess；main process 已在 dev.js 的 --js-flags 中配置
// 注意：不设 max-old-space-size（64 位默认 ~2GB 足够），设大会推迟 GC 掩盖泄漏
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=2048 --max-semi-space-size=64 --gc-interval=2048 --expose-gc')

// Handle Squirrel Windows installer events (inline to avoid module resolution issues)
// Returns true if app should quit (installer is handling a setup event)
function checkSquirrelStartup(): boolean {
    if (process.platform !== 'win32') return false;
    const cmd = process.argv[1];
    return ['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall', '--squirrel-obsolete'].includes(cmd);
}

if (checkSquirrelStartup()) {
  app.quit();
}

/** Handle custom protocol URL */
async function handleProtocolUrl(url: string) {
    if (url.startsWith('hclaw://auth-google-callback')) {
        const code = new URL(url).searchParams.get('code');
        if (code) {
            try {
                const tokens = await GoogleAuthService.exchangeCodeForToken(code, 0);
                const userInfo = await GoogleAuthService.getUserInfo(tokens.accessToken);

                const win = getMainWindow();
                if (win && !win.isDestroyed()) {
                    logger.info('oauth-callback', {success: true, email: userInfo.email});
                    win.webContents.send('google-auth-success', {
                        ...tokens,
                        email: userInfo.email,
                        name: userInfo.name,
                        picture: userInfo.picture
                    });
                }
            } catch (err) {
                logger.error('oauth-callback', {success: false, error: String(err)});
            }
        }
    }
}

// 单例锁定
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (_event, commandLine) => {
        // 当第二个实例启动时，唤起主窗口
        const win = getMainWindow();
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }

        // 处理协议 URL (Windows/Linux)
        const url = commandLine.pop();
        if (url) handleProtocolUrl(url);
    });
}

// 处理 macOS 协议 URL
app.on('open-url', (event, url) => {
    event.preventDefault();
    handleProtocolUrl(url);
});

// 注册所有 IPC handlers（在 ready 之前注册，确保渲染进程加载时 handler 已就绪）

initWindowIPC();
initConfigIPC();
initConversationIPC();

registerPluginIPC();
registerCapabilityIPC();
registerHookIPC();
registerAgentIPC();
initGoogleAuthIPC();
initProviderIPC();
initModelSchemeIPC();
initPromptSchemeIPC();
initToolIPC();
initScheduleIPC();
initChannelIPC();
channelManager.init();

app.on('ready', async () => {
  // DB is initialized at module import time via ./repositories/init

  ensureConfigLayout();

    // MIME 类型映射表（用于自定义协议返回正确的 Content-Type）
    const MIME_MAP: Record<string, string> = {
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.flac': 'audio/flac',
        '.aac': 'audio/aac',
        '.m4a': 'audio/mp4',
        '.wma': 'audio/x-ms-wma',
        '.webm': 'audio/webm',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp',
        '.mp4': 'video/mp4',
        '.avi': 'video/x-msvideo',
        '.mov': 'video/quicktime',
        '.mkv': 'video/x-matroska',
        '.ts': 'video/mp2t',
        '.m3u8': 'application/vnd.apple.mpegurl',
    }

    // 注册 hclaw-media:// 自定义协议
    // URL 格式: hclaw-media:///C:/path/to/file.mp3
    // 正确支持 Range 请求，<audio>/<video> 可以流式播放
    protocol.handle('hclaw-media', async (request) => {
        const rawUrl = request.url
        // 使用 URL 解析提取 pathname，避免手动切片导致路径错误
        let filePath = ''
        try {
            filePath = decodeURIComponent(new URL(rawUrl).pathname)
        } catch {
            // fallback: 手动提取（兼容 URL 解析失败的情况）
            const afterScheme = rawUrl.slice('hclaw-media://'.length)
            filePath = decodeURIComponent(afterScheme.includes('/') ? afterScheme.slice(afterScheme.indexOf('/')) : afterScheme)
        }
        // Windows 上去掉前导斜杠（pathname 为 /E:/path → E:/path）
        if (process.platform === 'win32') {
            filePath = filePath.replace(/^[/\\]+/, '')
        }

        try {
            const ext = path.extname(filePath).toLowerCase()
            const mimeType = MIME_MAP[ext] || 'application/octet-stream'

            const stat = await fsPromises.stat(filePath)
            const fileSize = stat.size

            // 处理 Range 请求——<audio>/<video> 必须正确支持否则会反复从头加载
            const rangeHeader = request.headers.get('Range')
            if (rangeHeader) {
                const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
                if (match) {
                    const start = parseInt(match[1], 10)
                    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
                    const chunkSize = end - start + 1

                    const fd = await fsPromises.open(filePath, 'r')
                    const buffer = Buffer.alloc(chunkSize)
                    await fd.read(buffer, 0, chunkSize, start)
                    await fd.close()

                    return new Response(buffer, {
                        status: 206,
                        headers: {
                            'Content-Type': mimeType,
                            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                            'Content-Length': String(chunkSize),
                            'Accept-Ranges': 'bytes',
                        },
                    })
                }
            }

            // 无 Range 请求，返回完整文件
            const buffer = await fsPromises.readFile(filePath)
            return new Response(buffer, {
                status: 200,
                headers: {
                    'Content-Type': mimeType,
                    'Content-Length': String(fileSize),
                    'Accept-Ranges': 'bytes',
                    'Access-Control-Allow-Origin': '*',
                },
            })
        } catch (err) {
            logger.error('protocol-handle-error', {filePath, error: String(err)})
            return new Response('Not Found', {status: 404})
        }
    })

    // 注册 ConfigBridge（否则 model 模块在主进程不可用）
    setConfigBridge({
        getScheme: () => runtimeConfigManager.getScheme(),
        getProviders: () => runtimeConfigManager.getProviders(),
        onConfigChange: () => () => {
        },
    });

    // 一次性迁移：SQLite → JSON（仅在首次运行时执行）
    migrateMcpFromSqlite();
    migrateHooksFromSqlite();

  // MCP IPC handlers must be registered before createWindow
  // because renderer process rehydration calls mcp:list IPC
  registerMCPIPC();

  // Step 1: 从 mcp.json 加载用户 MCP 配置到内存缓存
  // 注意：此时 pluginMcpServers 可能不完整，插件 MCP 的完整配置
  // 稍后由 powerManager.initialize() → loadMcpServersFromPlugin() 回写
  await mcpService.initialize();

    // 初始化提示词方案（首次运行时创建默认方案）
    promptSchemeRepo.initializeDefaults();

  createWindow();
  setMainWindow(getMainWindow());

    // 设置自定义应用菜单，移除与渲染进程快捷键冲突的默认加速器（如 Ctrl+N）
    createAppMenu();

  // MCP event forwarding channel must be registered after createWindow (needs mainWindow)
  registerMCPEventForwarding();

  createTray();
  registerGlobalShortcuts();

  // ── Async block: Agent/Skills/MCP 顺序初始化 ──
  //
  // 架构说明：
  // MCP Worker 启动依赖 mcpService 缓存中已包含所有 MCP 配置。
  // powerManager.initialize() → loadMcpServersFromPlugin() 会将
  // 插件 MCP 的完整配置（command/args/url 等）回写到 mcp.json 的
  // pluginMcpServers 节点，同时加入 mcpService 缓存。
  // 因此 MCP Worker 必须在 Agent 初始化之后才能启动，
  // 以确保 collectConfigs() 能读到全部配置。

  // Step 2: Plugin system - discover plugins only (not internal agents/skills/mcps/hooks/commands)
  await initializePlugins();

  // Hook system: initialize builtin handlers + load legacy user scripts (via compat layer)
  registerBuiltinHandlers(hookExecutor);
  loadHooksFromDirectory().catch(() => {});

  // Step 3: Agent + Skills 初始化（含插件 MCP 配置加载 + 缓存回写）
  await initAgent();

  // Step 4: MCP Worker 初始化（此时 mcpService 缓存已包含所有 MCP 配置）
  mcpWorkerManager.init().catch((err: any) => {
    logger.info('[MCP] MCP Worker init failed:', err.message);
  });

  // Step 5b: Start config file watchers (mcp.json, hooks.json)
  startConfigWatcher();

  // ── Sync block 2: UI scene restoration (after sync block 1 completes) ──

  // 1. Current working directory
  const workingDir = runtimeConfigManager.getWorkingDir();

  // 2. Session list in current working directory
  const conversationRepo = createConversationRepository();
  const sessions = conversationRepo.list();
  const sortedSessions = sessions.sort((a: any, b: any) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const activeSession = sortedSessions[0]?.id || null;

  // 3. Current model scheme
  const activeScheme = runtimeConfigManager.getScheme();

  // 4. Current run mode
  const runMode = runtimeConfigManager.getMode();

  // 5. Permission rules
  const permissionRules = await permissionEngine.getRules();

  // 6. Todo list
  const todoList = powerManager.getTodoList ? powerManager.getTodoList() : [];

  // Agent system: register built-in tools + IPC handlers
  agentManager.setMainWindow(getMainWindow());

  // LLM call log IPC handlers
  initLlmCallLogIPC(getMainWindow);
  initLlmLogIPC();

  // Scheduler system initialization (loads enabled schedules into worker)
  schedulerManager.init()

    // Post-startup warmup
    setTimeout(() => powerManager.refresh().catch(() => {}), 0)

  // Startup complete
  logger.info('[App] HClaw ready');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', async () => {
  setIsQuitting(true);

    // 通知渲染进程刷盘未持久化的消息
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('flush-save');
  }
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  agentManager.abortAll();
  await mcpWorkerManager.shutdown();
  // Scheduler worker will be terminated by process exit; safe to ignore
});
