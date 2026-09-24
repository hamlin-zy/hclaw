// ── 冷启动观测：必须保持为第一条 import（零依赖副作用模块，见文件内注释）──
// 它记录「主进程模块图开始求值」的时刻，供 startupTrace 量出模块图求值总耗时。
import './startupAnchor';

import {app, BrowserWindow, globalShortcut, ipcMain, protocol} from 'electron';
import path from 'path';
import * as fsPromises from 'fs/promises';

// IMPORTANT: Database must be initialized before any other database-dependent modules
import './repositories/init';

// 装配根：直接指向各职责模块（config.ts 已退化为兼容门面，见该文件头注释）
import {getHclawDir} from './hclawPaths';
import {ensureConfigLayout} from './config/ensureConfigLayout';
import {ensureDefaultLocale} from './settings/defaultLocale';
import {initConfigIPC} from './ipc/configIPC';
import {initProjectGroupIPC} from './ipc/projectGroupIPC';
import {initBackgroundIPC} from './ipc/background';
import {createWindow, getMainWindow, initWindowIPC, setIsQuitting, broadcastUpdaterStatus} from './window';
import {createTray} from './tray';
import {registerGlobalShortcutsAtStartup} from './shortcuts';
import {createAppMenu} from './menu';
import {initConversationIPC} from './conversation';
import {agentManager, initAgent, registerAgentIPC, disposeAgentManagerEvents} from './agent';
import {disposePowerManagerEvents} from './agent/powerManager';
import {registerMCPEventForwarding, registerMCPIPC} from './agent/mcp/ipc';
import {migrateMcpFromSqlite} from './config/migrateMcpHookFromSqlite';
import {mcpService} from './services/mcpService';
import {initLlmTraceIPC} from './utils/llmCallLogStore';
import {initUsageStatsIPC} from './utils/usageWindow';
import {initConfigWindowIPC} from './utils/configWindow';
import {initMemoryIPC} from './ipc/memoryIPC';
import {initTaskBatchIPC} from './ipc/taskBatches';
import {startConfigWatcher, stopConfigWatcher} from './config-watcher';
import {initProgress, setInitProgressTransport} from './initProgress';
import {broadcastToAllWindows} from './utils/windowBroadcast';
import {initializePlugins, registerPluginIPC} from './plugin/ipc';
import {registerCapabilityIPC, disposeCapabilityIPC} from './capability/ipc';
import {stopGitBranchWatch} from './workspace/gitBranch';
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
import {stopPendingAttachmentsCleanup} from './channel/messageHandler';
import {initChannelIPC} from './channel/channelIPC';
import {initMemoIPC} from './memo/memoIPC';
import {initProjectManagerIPC, stopAllWatchers} from './project-manager/window';
import {shutdownWatcherProcess} from './project-manager/watcher';
import {initPhraseIPC} from './phrase/phraseIPC';
import {memoStore} from './memo/memoStore';
import {createLogger} from './agent/logger';
import {mcpWorkerManager} from './agent/mcp/mcpWorkerManager';
import {runtimeConfigManager} from './agent/runtimeConfigManager';
import {setConfigBridge} from './agent/common/configBridge';
import {init as initUpdater} from './updater/updateChecker';
import {initCompanionIPC} from './companion/companionIPC';
import {launchBeforeApps, launchAfterApps} from './companion/companionLaunchService';
import {versionManager} from './plugin/versionManager';
import {mcpVersionManager} from './agent/mcp/versionManager';
import {getConversationPersistence} from './persistence/conversationPersistence';
import {registerRepoIPC, initializeRepoSystem} from './repo/ipc';
import {repoVersionManager} from './repo/versionManager';
import {trace, flushStartupTraceSync, setStartupTraceDir} from './startupTrace';

// ── 冷启动观测：注入日志目录（startupTrace 刻意不 import config，避免新增循环依赖）──
setStartupTraceDir(path.join(getHclawDir(), 'logs'))

// ── 冷启动观测：所有 import 求值完成后的第一处打点（模块评估阶段结束）──
trace('main:module-eval-start')

const logger = createLogger('app')

// ── 冷启动观测：渲染进程打点 IPC（fire-and-forget，仅记录日志，不影响任何行为）──
ipcMain.on('startup:mark', (_e, label: string, data?: Record<string, unknown>) => trace(label, data))

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
initProjectGroupIPC();
initBackgroundIPC();
initConversationIPC();

// 落库回执事件广播（§3.4 双通道第 2 条）：flush 级回执（message-finalized /
// persist-degraded），仅携带变更引用，不带全量消息（§3.6-6）。
// UI 流式 chunk 级事件保持现状不动（7.5）。
const unsubscribePersistEvent = getConversationPersistence().onPersistEvent(e => {
  // ★ C1 前置：message-flushed 是进程内 ACK 信号（仅供主进程侧消费，渲染端不消费），
  // 每次节流 flush 都会发，若透传会产生大量无意义 IPC。故显式白名单只转发既有渲染端事件。
  if (e.type !== 'message-finalized' && e.type !== 'persist-degraded') return
  const win = getMainWindow();
  try { win?.webContents.send('agent-persist-event', e) } catch { /* 窗口未就绪/已销毁时忽略 */ }
});

/** registerMCPEventForwarding() 返回的注销函数（须在 will-quit 调用，否则模块级订阅残留）。
 *  声明在模块作用域：注册点在 app.on('ready') 内，注销点在 will-quit 内。 */
let unsubscribeMCPEventForwarding: (() => void) | null = null;

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
initProjectManagerIPC();

/**
 * 等待主窗口真正可见（BrowserWindow 的 'show' 事件），最多 timeoutMs。
 *
 * 用途：把重活（插件/能力/MCP 初始化）排到窗口首帧之后。
 * Electron 主进程与浏览器进程同线程，能力加载里的同步 fs/DB 段会连续饿死事件循环
 * （实测 main:loop-stall gapMs=5050），渲染进程 spawn 与 ready-to-show 的 IPC
 * 会一起被推迟 —— 现象就是「托盘先出现，主窗口几秒后才出来」。
 *
 * 超时兜底：窗口因故未能显示（显示失败等）时不能让启动流程永久挂起。
 */
function waitForWindowShown(timeoutMs: number): Promise<void> {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || win.isVisible()) return Promise.resolve();
    return new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout;
        const done = (): void => {
            clearTimeout(timer);
            win.removeListener('show', done);
            resolve();
        };
        timer = setTimeout(done, timeoutMs);
        win.once('show', done);
    });
}

app.on('ready', async () => {
  trace('main:app-ready')
  // DB is initialized at module import time via ./repositories/init

  // 注入初始化进度的广播传输（必须在任何 initProgress.stage() 之前）
  setInitProgressTransport(broadcastToAllWindows);

  // 渲染进程挂载后主动拉取进度快照：createWindow() 之后立即发出的前几帧
  // 渲染端监听尚未注册，会被 IPC 丢弃，需要靠这个拉取接口补齐。
  ipcMain.handle('system:get-init-progress', () => initProgress.getSnapshot());

  ensureConfigLayout();

  // 语言守卫（spec §6.4）：母语缺失时写入系统语言。必须在 app ready 之后
  // （app.getLocale 依赖 ready），且早于任何会话启动。
  ensureDefaultLocale({getLocale: () => app.getLocale()});

  // 跟随启动（before）：阻塞直到全部就绪或超时（全局上限 MAX_BEFORE_WAIT_MS=30s；空配置 near-zero）
  await launchBeforeApps();

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

                    // fd 必须在所有路径下关闭：read 失败时若不 finally 释放，fd 会泄漏
                    const fd = await fsPromises.open(filePath, 'r')
                    let buffer: Buffer<ArrayBuffer>
                    try {
                        buffer = Buffer.alloc(chunkSize)
                        await fd.read(buffer, 0, chunkSize, start)
                    } finally {
                        try {
                            await fd.close()
                        } catch { /* close 失败不覆盖原异常 */ }
                    }

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
  trace('main:mcpService-initialized')

    // 初始化提示词方案（首次运行时创建默认方案）
    promptSchemeRepo.initializeDefaults();

  // 任务批次查询/删除 IPC（历史任务组窗口数据源）
  // ★ 必须在 createWindow 之前注册：渲染进程启动后会立即 invoke
  //   task-batches:get-active，注册晚了会报 "No handler registered"
  initTaskBatchIPC();

  trace('main:before-createWindow')
  createWindow();
  trace('main:after-createWindow')

    // 设置自定义应用菜单，移除与渲染进程快捷键冲突的默认加速器（如 Ctrl+N）
    createAppMenu();

  // MCP 事件转发广播给所有渲染窗口（须在窗口创建后注册）
  // ★ 接住返回的注销函数（此前直接丢弃 → mcpService.onEvent 订阅在 will-quit 后残留）
  unsubscribeMCPEventForwarding = registerMCPEventForwarding();

  registerGlobalShortcutsAtStartup();
  trace('main:shortcuts-registered');

  // ── 窗口优先：先让主窗口的首帧落地，再开始插件/能力/MCP 初始化 ──
  // 窗口「创建」虽然在这个 async 块之前，但窗口「可见」取决于渲染进程首帧；
  // 而下面这段初始化里的同步段会连续饿死主线程（实测 main:loop-stall gapMs=5050），
  // 把 renderer spawn 与 ready-to-show 的 IPC 一起推迟 —— 用户看到的就是
  // 「托盘已经出来了，主窗口却要几秒后才出现」。
  // 改为首帧落地后再跑重活；进度经 initProgress 广播给渲染端（左下角「初始化阶段」文案）。
  const windowGateStart = Date.now();
  await waitForWindowShown(8000);
  trace('main:window-gate-released', {waitedMs: Date.now() - windowGateStart});

  // ── 托盘延后到窗口可见之后 ──
  // new Tray() 是同步的 Shell_NotifyIcon 调用，实测阻塞 25ms ~ 2.6s（随系统/explorer 负载剧烈波动）。
  // 它若排在窗口之前，会把渲染进程 spawn 一并推迟 —— 这正是「托盘先出现、主窗口几秒后才出」的成因之一。
  // 移到窗口可见之后：窗口优先，托盘紧随其后，不再影响首帧。
  trace('main:before-createTray')
  createTray();
  trace('main:after-createTray')

  // ── 冷启动观测：事件循环阻塞探针 ──
  // 0ms 定时器若不能及时派发，说明主线程被同步代码连续占用（渲染进程 spawn /
  // ready-to-show 的 IPC 都会被推迟）；若 delayMs 很小，则说明该阶段是纯 I/O 等待，
  // 不阻塞事件循环 —— 窗口延迟就要从别处找原因。
  const loopProbe = (at: string): void => {
    const t = Date.now();
    setTimeout(() => trace('main:loop-probe', {at, delayMs: Date.now() - t}), 0);
  };

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
  trace('main:before-initializePlugins');
  loopProbe('plugins');
  logger.info('init-checkpoint', {step: 'initializePlugins-start'})
  initProgress.stage('plugin')
  await initializePlugins();
  initProgress.done('plugin')
  logger.info('init-checkpoint', {step: 'initializePlugins-done'})
  trace('main:plugins-initialized');

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
  loopProbe('initAgent');
  initProgress.stage('agent')
  await initAgent();
  initProgress.done('agent')
  logger.info('init-checkpoint', {step: 'initAgent-done'})
  trace('main:agent-initialized');
  // initAgent 已被推迟到「窗口可见」之后，而渲染端在挂载时会拉一次工具列表
  // （schemeSync/modelSchemeStore → toolStore.loadTools），那次拉取可能早于
  // registerBuiltinTools() → 这里补一次广播让渲染端重取（原顺序下内置工具先于渲染端加载，无需）。
  broadcastToAllWindows('tools-changed');
  // 主进程侧四段能力加载结束（MCP 阶段由渲染进程自行推导，主进程不管）
  initProgress.finish()

  // 预热 hclaw_db_query 只读连接（数据库已初始化、工具已注册）
  const {initHclawDbQueryConnection} = await import('./agent/tools/builtin/hclawDbQueryConnection');
  initHclawDbQueryConnection();

  // Step 4: MCP Worker 初始化（此时 mcpService 缓存已包含所有 MCP 配置）
  trace('main:before-mcpWorker-init');
  mcpWorkerManager.init().catch((err: any) => {
    logger.info('[MCP] MCP Worker init failed:', err.message);
  });
  trace('main:after-mcpWorker-init-call');

  // MCP version check (fire-and-forget) — probes --version / npm view / checkUrl
  // Results broadcast to all windows via mcp:status-update
  // Must run after mcpWorkerManager.init() so MCP processes are ready for --version probe
  mcpVersionManager.startupCheck().then((versionMeta) => {
    const hasUpdates = Object.entries(versionMeta).some(([, v]) => v.hasUpdate === true)
    logger.info('mcp-version-startup-done', {hasUpdates, total: Object.keys(versionMeta).length})
  }).catch((err: any) => {
    logger.warn('mcp-version-check-failed', {error: String(err)})
  })

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

  // 记忆管理窗口 IPC（list/read/write/delete ~/.hclaw/mem 与 ref）
  initMemoryIPC();

  // 跟随启动窗口 IPC（list/save/remove/enumerate/browse/get-icon）
  initCompanionIPC();

  // Scheduler system initialization (loads enabled schedules into worker)
  schedulerManager.init()

    // 注意：此处曾有一次 `setTimeout(powerManager.refresh(), 0)` 的「启动预热」。
    // 移除的前提是 initialize() 自身已把加载结果投影到 CapabilityHub
    // （initialize → loadAllCapabilities → syncToCapabilityHub）—— registry 与 Hub
    // 二者必须同时就绪，只重建 registry 而漏投影会让 Hub 恒为空（命令管理页无数据）。
    // 满足该前提后，紧接着再整跑一轮全量 refresh 才是纯重复（实测 4.1s 后台 I/O）。

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
  trace('main:ready-block-done');
  logger.info('[App] HClaw ready');

  // 跟随启动（after）：fire-and-forget，不阻塞 initUpdater
  void launchAfterApps();

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
  stopAllWatchers();
  // ★ 终止项目管理窗口 watcher 的 utilityProcess（stopAllWatchers 只把各 workspace 的
  //   refcount 归零，进程本身驻留；此前无调用者则退出时会被整体带走而非优雅终止）
  shutdownWatcherProcess();
  // 停止全局 git 分支 watch（.git/HEAD 的 fs.watch / 降级轮询）
  stopGitBranchWatch();

  // §4.3 退出边界：全部会话未 flush 增量同步落库
  try { getConversationPersistence().flushAllSync() } catch (err) {
    console.error('[quit] flushAllSync failed:', err)
  }
});

app.on('will-quit', async () => {
  flushStartupTraceSync();
  // 注销模块级事件订阅，避免 will-quit 后残留监听句柄
  try { unsubscribePersistEvent(); } catch { /* ignore */ }
  try { disposeCapabilityIPC(); } catch { /* ignore */ }
  // ★ 注销各单例注册在全局 eventBus 上的订阅：on() 返回 void（无自动注销句柄），
  //   不显式 off 则 eventBus 的 listener 集合持续持有这些单例闭包（连同其全部状态）。
  try { disposeAgentManagerEvents(); } catch { /* ignore */ }
  try { disposePowerManagerEvents(); } catch { /* ignore */ }
  // ★ 停止 mcp.json 的 fs.watch（stopConfigWatcher 内部幂等：watcher 为 null 时 no-op）
  try { stopConfigWatcher(); } catch { /* ignore */ }
  // ★ MCP 事件转发注销函数（此前注册时丢弃了返回值 → mcpService.onEvent 订阅残留）
  try { unsubscribeMCPEventForwarding?.(); } catch { /* ignore */ }
  globalShortcut.unregisterAll();
  // ★ 关闭 Scheduler Worker（此前 shutdown() 无任何调用者，退出时 cron worker 线程会被整体带走
  //   而非优雅终止；线程内的定时器与在跑的脚本任务也就无从收尾）
  try { schedulerManager.shutdown(); } catch { /* ignore */ }
  agentManager.abortAll();
  await mcpWorkerManager.shutdown();
  // ★ 关闭 Channel Worker（此前 shutdown() 无任何调用者，退出时 Channel worker 进程会被整体带走而非优雅终止）
  try { channelManager.shutdown(); } catch { /* ignore */ }
  // ★ 停止 messageHandler 模块级的过期附件清理定时器（否则残留 interval 句柄）
  try { stopPendingAttachmentsCleanup(); } catch { /* ignore */ }
  // 关闭持久化 Shell 会话池，销毁常驻 shell 进程
  const {disposeAllShellSessions} = await import('./agent/tools/shellPool/pool');
  try { disposeAllShellSessions(); } catch { /* ignore */ }
  // 回收文件检索 findSessions（进行中的 rg 子进程显式 kill，不靠 OS 回收）
  const {disposeAllFindSessions} = await import('./project-manager/search');
  try { disposeAllFindSessions(); } catch { /* ignore */ }
  // 关闭 hclaw_db_query 只读连接
  const {closeConnection} = await import('./agent/tools/builtin/hclawDbQueryConnection');
  try { closeConnection(); } catch { /* ignore */ }
  // 退出前强制 checkpoint：把 WAL 合并回主库并截断
  const {flushDatabase} = await import('./repositories/sqlite');
  try { flushDatabase(); } catch { /* ignore */ }
});
