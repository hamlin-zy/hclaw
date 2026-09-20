import {spawn} from 'child_process'
import path from 'path'
import {Notification} from 'electron'
import {logger} from '../agent/logger'
import {readCompanionConfig} from './companionConfig'
import {isProcessRunning} from './processDetector'
import type {CompanionApp, LaunchTiming} from '../../shared/types/companion'

/** before 批次全局等待上限：单项 waitTimeoutMs 与剩余配额取 min（spec §3） */
export const MAX_BEFORE_WAIT_MS = 30000
const POLL_INTERVAL_MS = 500
const DEFAULT_WAIT_TIMEOUT_MS = 10000

export interface LaunchResult {
    appId: string
    appName: string
    status: 'launched' | 'already-running' | 'failed' | 'timeout'
    error?: string
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** 统一经 cmd start（ShellExecute 语义）启动：直接 spawn 对 UAC/防护类启动器（如游戏）会 EACCES，
 *  cmd start 与「双击快捷方式」同语义，天然兼容提权类应用；'spawn' 事件 = 命令已提交，'error' = cmd 本身失败 */
function spawnDetached(app: CompanionApp): Promise<boolean> {
    return new Promise(resolve => {
        try {
            const isWin32 = process.platform === 'win32'
            const command = isWin32
                ? 'cmd.exe'
                : process.platform === 'darwin' ? 'open' : 'xdg-open'
            const spawnArgs = isWin32
                ? ['/c', 'start', '', app.exePath, ...app.args]
                : [app.exePath, ...app.args]
            const child = spawn(command, spawnArgs, {
                detached: true,
                stdio: 'ignore',
                windowsHide: isWin32,
                cwd: path.dirname(app.exePath),
            })
            child.once('error', (err) => {
                logger.warn('companion-spawn-failed', {app: app.name, error: String(err)})
                resolve(false)
            })
            child.once('spawn', () => resolve(true))
            child.unref()
        } catch (err) {
            logger.warn('companion-spawn-throw', {app: app.name, error: String(err)})
            resolve(false)
        }
    })
}

/** 单项处理。beforeStartedAt 非 null 表示 before 批次（受全局配额约束）。 */
async function launchSingle(app: CompanionApp, beforeStartedAt: number | null): Promise<LaunchResult> {
    const base = {appId: app.id, appName: app.name}
    if (await isProcessRunning(app.processName)) {
        return {...base, status: 'already-running'}
    }
    const ok = await spawnDetached(app)
    if (!ok) {
        return {...base, status: 'failed', error: 'spawn 失败（路径无效或权限拒绝）'}
    }
    if (app.launchTiming !== 'before' || !app.waitForReady) {
        return {...base, status: 'launched'}
    }
    const waitTimeoutMs = app.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    const remaining = beforeStartedAt === null
        ? waitTimeoutMs
        : MAX_BEFORE_WAIT_MS - (Date.now() - beforeStartedAt)
    const deadline = Date.now() + Math.max(0, Math.min(waitTimeoutMs, remaining))
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS)
        if (await isProcessRunning(app.processName)) {
            return {...base, status: 'launched'}
        }
    }
    logger.warn('companion-wait-timeout', {app: app.name})
    return {...base, status: 'timeout'}
}

/** 仅在有 failed/timeout 项时发一条系统通知；无失败不发（spec §3） */
function notifyIfFailures(results: LaunchResult[]): void {
    const failed = results.filter(r => r.status === 'failed' || r.status === 'timeout')
    if (failed.length === 0) return
    logger.warn('companion-launch-failures', {
        count: failed.length,
        items: failed.map(f => `${f.appName}:${f.status}`),
    })
    try {
        if (Notification.isSupported()) {
            new Notification({
                title: '跟随启动',
                body: `${failed.length} 个跟随启动项未能启动：${failed.map(f => f.appName).join('、')}`,
            }).show()
        }
    } catch (err) {
        logger.warn('companion-notification-failed', {error: String(err)})
    }
}

async function launchTimings(timings: LaunchTiming[], beforeStartedAt: number | null): Promise<void> {
    const apps = readCompanionConfig().filter(a => a.enabled && timings.includes(a.launchTiming))
    if (apps.length === 0) return
    // .catch 已映射所有 rejection，不会向上抛
    const results = await Promise.all(
        apps.map(app => launchSingle(app, beforeStartedAt).catch(err => ({
            appId: app.id,
            appName: app.name,
            status: 'failed' as const,
            error: String(err),
        }))),
    )
    notifyIfFailures(results)
}

/** before 批次：index.ts 中 await（阻塞受 MAX_BEFORE_WAIT_MS 约束）；绝不抛异常 */
export async function launchBeforeApps(): Promise<void> {
    try {
        await launchTimings(['before'], Date.now())
    } catch (err) {
        logger.warn('companion-before-failed', {error: String(err)})
    }
}

/** after 批次：index.ts 中不 await（fire-and-forget）；绝不抛异常 */
export async function launchAfterApps(): Promise<void> {
    try {
        await launchTimings(['after'], null)
    } catch (err) {
        logger.warn('companion-after-failed', {error: String(err)})
    }
}
