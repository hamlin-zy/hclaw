import {app, BrowserWindow, globalShortcut, protocol} from 'electron';
import path from 'path';
import * as fsPromises from 'fs/promises';

// IMPORTANT: Database must be initialized before any other database-dependent modules
import './repositories/init';

import {ensureConfigLayout, initConfigIPC} from './config';
import {initBackgroundIPC} from './ipc/background';
import {createWindow, getMainWindow, initWindowIPC, setIsQuitting, broadcastUpdaterStatus} from './window';
import {createTray} from './tray';
import {registerGlobalShortcuts} from './shortcuts';
import {createAppMenu} from './menu';
import {initConversationIPC} from './conversation';
import {agentManager, initAgent, registerAgentIPC} from './agent';
import {registerMCPEventForwarding, registerMCPIPC} from './agent/mcp/ipc';
import {migrateMcpFromSqlite} from './config/migrateMcpHookFromSqlite';
import {mcpService} from './services/mcpService';
import {initLlmTraceIPC} from './utils/llmCallLogStore';
import {initUsageStatsIPC} from './utils/usageWindow';
import {initConfigWindowIPC} from './utils/configWindow';
import {initTaskBatchIPC} from './ipc/taskBatches';
import {startConfigWatcher} from './config-watcher';
import {initializePlugins, registerPluginIPC} from './plugin/ipc';
import {registerCapabilityIPC} from './capability/ipc';
import {GoogleAuthService, initGoogleAuthIPC} from './auth/googleAuth';
import {initProviderIPC} from './llmProviderIPC';
import {modelMetaRegistry} from './modelMetaRegistry';
import {exchangeRateRegistry} from './exchangeRateRegistry';
import {initModelSchemeIPC} from './modelSchemeIPC';
import {initPromptSchemeIPC} from './promptSchemeIPC';
import {promptSchemeRepo} from './repositories/sqlite/promptSchemeRepository';
import {initToolIPC} from './toolIPC';
import {initScheduleIPC} from './scheduler/scheduleIPC';
import {schedulerManager} from './scheduler';
import {channelManager} from './channel/ChannelManager';
import {initChannelIPC} from './channel/channelIPC';
import {initMemoIPC} from './memo/memoIPC';
import {initPhraseIPC} from './phrase/phraseIPC';
import {memoStore} from './memo/memoStore';
import {createLogger} from './agent/logger';
import {powerManager} from './agent/powerManager';
import {mcpWorkerManager} from './agent/mcp/mcpWorkerManager';
import {runtimeConfigManager} from './agent/runtimeConfigManager';
import {setConfigBridge} from './agent/common/configBridge';
import {init as initUpdater} from './updater/updateChecker';
import {versionManager} from './plugin/versionManager';
import {getConversationPersistence} from './persistence/conversationPersistence';
import {registerRepoIPC, initializeRepoSystem} from './repo/ipc';
import {repoVersionManager} from './repo/versionManager';

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
// ★ 2026-08 实测修正：流式渲染高频分配（textBatch 每 24ms 拼接字符串 + 消息数组复制）
//   产生大量短期垃圾。原参数 --max-semi-space-size=64 + --gc-interval=2048 让新老生代
//   都囤积垃圾不回收，堆膨胀到 2GB 上限才触发 GC → 提交内存峰值、页面文件打满、
//   Chrome/WebStorm 连带崩溃。实测强制 gc() 后渲染进程 Private 1623MB → 604MB，
//   证明是"GC 太懒"而非硬泄漏。
//   修正：半空间回到默认 16MB（短命对象及时 scavenge）；移除非标准 --gc-interval=2048
//   （推迟 GC 掩盖泄漏）；保留 max-old-space-size 作安全上限与 expose-gc 供主动回收。
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=2048 --max-semi-space-size=16 --expose-gc')

// Enable remote debugging for renderer process (useful for debugging)
// This allows connecting Chrome DevTools to the Electron renderer
const remoteDebugPort = process.argv.find(arg => arg.startsWith('--remote-debugging-port='))?.split('=')[1]
if (remoteDebugPort) {
    app.commandLine.appendSwitch('remote-debugging-port', remoteDebugPort)
    console.log('[Main] Remote debugging enabled on port:', remoteDebugPort)
}

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
initBackgroundIPC();
initConversationIPC();

// 落库回执事件广播（§3.4 双通道第 2 条）：flush 级回执（message-finalized /
// persist-degraded），仅携带变更引用，不带全量消息（§3.6-6）。
// UI 流式 chunk 级事件保持现状不动（7.5）。
getConversationPersistence().onPersistEvent(e => {
  const win = getMainWindow();
  try { win?.webContents.send('agent-persist-event', e) } catch { /* 窗口未就绪/已销毁时忽略 */ }
});

registerPluginIPC();
registerRepoIPC();
registerCapabilityIPC();
registerAgentIPC();
initGoogleAuthIPC();
initProviderIPC();
initModelSchemeIPC();
initPromptSchemeIPC();
initToolIPC();
initScheduleIPC();
initMemoIPC();
initPhraseIPC();
// 应用启动时清理超 24h 的暂存附件残留（spec §4）
memoStore.cleanupStalePending();
initChannelIPC();
channelManager.init();

app.on('ready', async () => {
  // DB is initialized at module import time via ./repositories/init

  ensureConfigLayout();

  void modelMetaRegistry.init();
  void exchangeRateRegistry.init();

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
        let host = ''
        try {
            const u = new URL(rawUrl)
            host = u.host
            filePath = decodeURIComponent(u.pathname)
        } catch {
            // fallback: 手动提取（兼容 URL 解析失败的情况）
            const afterScheme = rawUrl.slice('hclaw-media://'.length)
            filePath = decodeURIComponent(afterScheme.includes('/') ? afterScheme.slice(afterScheme.indexOf('/')) : afterScheme)
        }
        // Windows 上去掉前导斜杠（pathname 为 /E:/path → E:/path）
        if (process.platform === 'win32') {
            filePath = filePath.replace(/^[/\\]+/, '')
            // 兼容单字母 host（盘符丢失场景）：hclaw-media://c/Users/... → c:/Users/...
            // Chromium 会把 hclaw-media:///C:/path 规范化为 host="c" + pathname="/path"，
            // 盘符 C: 进了 host，这里补回冒号（background.ts 已改用 hclaw-media://local/ 格式，
            // 此分支仅用于兼容旧数据）
            if (/^[a-zA-Z]$/.test(host)) {
                filePath = host + ':/' + filePath.replace(/^[\\/]+/, '')
            }
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

  // MCP IPC handlers must be registered before createWindow
  // because renderer process rehydration calls mcp:list IPC
  registerMCPIPC();

  // Step 1: 从 mcp.json 加载用户 MCP 配置到内存缓存
  // 注意：此时 pluginMcpServers 可能不完整，插件 MCP 的完整配置
  // 稍后由 powerManager.initialize() → loadMcpServersFromPlugin() 回写
  await mcpService.initialize();
  logger.info('init-checkpoint', {step: 'mcpService-done'})

    // 初始化提示词方案（首次运行时创建默认方案）
    promptSchemeRepo.initializeDefaults();

  createWindow();

    // 设置自定义应用菜单，移除与渲染进程快捷键冲突的默认加速器（如 Ctrl+N）
    createAppMenu();

  // MCP 事件转发广播给所有渲染窗口（须在窗口创建后注册）
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

  // Step 2: Plugin system - discover plugins only (not internal agents/skills/mcps/commands)
  logger.info('init-checkpoint', {step: 'initializePlugins-start'})
  await initializePlugins();
  logger.info('init-checkpoint', {step: 'initializePlugins-done'})

  // Plugin version check (fire-and-forget) - fetches latest tags for all git plugins
  // Results are pushed to renderer via plugin:status-update event
  versionManager.startupCheck().then((versionMap) => {
    const win = getMainWindow();
    const hasUpdates = Object.entries(versionMap).some(([, v]) => v.hasUpdate)
    const updatedPlugins = Object.keys(versionMap).filter(k => versionMap[k].hasUpdate)
    logger.info('plugin-version-startup-done', {hasUpdates, plugins: updatedPlugins})
    if (win && !win.isDestroyed()) {
      win.webContents.send('plugin:status-update', versionMap);
    }
  }).catch((err: any) => {
    logger.warn('plugin-version-check-failed', {error: String(err)});
  });

  // Skills/Agents repo startup check (fire-and-forget) — discover + fetch tags, push red-dot meta
  initializeRepoSystem().then(() => {
    const win = getMainWindow();
    const meta = repoVersionManager.getAllVersionMeta();
    if (win && !win.isDestroyed()) {
      win.webContents.send('repo:status-update', meta);
    }
  }).catch((err: any) => {
    logger.warn('repo-version-startup-failed', {error: String(err)});
  });

  // Step 3: Agent + Skills 初始化（含插件 MCP 配置加载 + 缓存回写）
  logger.info('init-checkpoint', {step: 'initAgent-start'})
  await initAgent();
  logger.info('init-checkpoint', {step: 'initAgent-done'})

  // Step 4: MCP Worker 初始化（此时 mcpService 缓存已包含所有 MCP 配置）
  mcpWorkerManager.init().catch((err: any) => {
    logger.info('[MCP] MCP Worker init failed:', err.message);
  });

  // Step 5b: Start config file watcher (mcp.json)
  startConfigWatcher();

  // Agent system: register built-in tools + IPC handlers
  agentManager.setMainWindow(getMainWindow());

  // LLM call log IPC handlers
  initLlmTraceIPC();

  // 全局用量统计窗口 + IPC
  initUsageStatsIPC();

  // 配置对话框独立窗口注册表 + open-config-window IPC
  initConfigWindowIPC();

  // 任务批次持久化查询/删除 IPC（历史任务组窗口数据源）
  initTaskBatchIPC();

  // Scheduler system initialization (loads enabled schedules into worker)
  schedulerManager.init()

    // Post-startup warmup
    setTimeout(() => powerManager.refresh().catch(() => {}), 0)

  // §4.2 崩溃恢复：启动完成时全库扫描一次未 finalize 的 assistant 消息，
  // 逐会话补终态（只做一次，不循环；§8 已接受增量丢失风险）
  try {
    const {getDatabase} = await import('./repositories/sqlite');
    const {getConversationPersistence} = await import('./persistence/conversationPersistence');
    const convs = getDatabase().prepare(
      "SELECT DISTINCT conversation_id AS id FROM messages WHERE role = 'assistant' AND ended_at IS NULL"
    ).all() as Array<{id: string}>;
    for (const {id} of convs) getConversationPersistence().recoverUnfinalized(id);
    if (convs.length > 0) logger.info('recover-unfinalized-done', {conversations: convs.length});
  } catch (err) {
    logger.warn('recover-unfinalized-failed', {error: String(err)});
  }

  // Startup complete
  logger.info('[App] HClaw ready');

  // 启动时静默检查更新（fire-and-forget，不阻塞主窗口显示）
  initUpdater()
    .then((result) => {
      broadcastUpdaterStatus(result);
    })
    .catch((err) => {
      logger.warn('updater-init-failed', {error: String(err)});
    });
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

  // §4.3 退出边界：全部会话未 flush 增量同步落库
  try { getConversationPersistence().flushAllSync() } catch (err) {
    console.error('[quit] flushAllSync failed:', err)
  }
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  agentManager.abortAll();
  await mcpWorkerManager.shutdown();
  // 退出前强制 checkpoint：把 WAL 合并回主库并截断
  const {flushDatabase} = await import('./repositories/sqlite');
  try { flushDatabase(); } catch { /* ignore */ }
  // Scheduler worker will be terminated by process exit; safe to ignore
});
