/**
 * SchedulerManager — 主进程调度管理器
 *
 * 职责：
 * 1. 管理 Worker 线程生命周期（启动/重启/关闭）
 * 2. 接收 Worker 发送的 task_fire 事件
 * 3. 分派执行四种任务类型（agent / skill / command / script）
 * 4. 创建并写入调度会话记录
 *
 * IPC 控制方法：
 * - pause() / resume() / stop() / runNow()
 * - upsertWorkerSchedule() / deleteWorkerSchedule()
 */

import {Worker} from 'worker_threads'
import path from 'path'
import crypto from 'crypto'
import fs from 'fs'
import {exec} from 'child_process'
import {promisify} from 'util'
import {ScheduleRecord, scheduleRepo} from './ScheduleRepository'
import {createConversationRepository} from '../repositories'
import type {IConversationRepository} from '../repositories/interfaces'
import type {ConversationMeta} from '@shared/types'
import {getHclawDir} from '../config'
import {SqliteWorkspaceRepository} from '../repositories/sqlite/workspaceRepository'

/**
 * 惰性获取主窗口：本模块位于 Agent Worker 的静态依赖闭包内
 * （builtin/schedulerManageTool → scheduler/index），顶层 import window.ts 会把
 * electron 主进程 API 拉进 worker（见 tests/main/deps/workerNoElectron.test.ts）
 */
function requireMainWindow(): ReturnType<typeof import('../window')['getMainWindow']> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- worker 闭包不得静态引入 electron，需延迟加载
    const {getMainWindow} = require('../window')
    return getMainWindow()
}
import {createLogger} from '../agent/logger'

const logger = createLogger('scheduler')

const execAsync = promisify(exec)

class SchedulerManager {
  private worker: Worker | null = null
  private activeRuns = new Map<string, AbortController>()
  public scheduleRepo = scheduleRepo
  private convRepo: IConversationRepository

  constructor() {
    this.convRepo = createConversationRepository()
  }

  // ─── 生命周期 ─────────────────────────────────────────────

  /**
   * 初始化调度管理器，启动 Worker 线程 + Agent Worker 池
   */
  init(): void {
      // ★ 应用启动时将残留 running 的调度会话重置为 active
      // 避免开发环境强制退出后侧边栏一直闪烁
      this.resetStaleRunningStatus()

      this.spawnCronWorker()
  }

  /**
   * 更新定时任务会话状态
   */
  private updateConversationStatus(convId: string, status: 'active' | 'running' | 'archived'): void {
      try {
          this.convRepo.updateMeta(convId, {status})
      } catch (err) {
          console.error('[SchedulerManager] updateConversationStatus failed:', err)
          return
      }
      // 推送状态变化到渲染进程，使侧边栏实时刷新（best-effort）
      try {
          const win = requireMainWindow()
          if (win && !win.isDestroyed()) {
              win.webContents.send('conversation-updated', {
                  id: convId,
                  status,
                  updatedAt: Date.now(),
              })
          }
      } catch {
          // window not ready
      }
  }

  /**
   * 应用启动时将残留 'running' 状态的调度会话重置为 'active'
   *
   * 开发环境下 CTRL+C 强制退出可能导致会话状态卡在 running，
   * 下次启动时侧边栏 isSchedulerRunning 检查到 status=running 会一直闪烁。
   * 应用启动时不可能有正在运行的任务，状态重置是幂等且无损的。
   */
  resetStaleRunningStatus(): void {
      try {
          // 仅重置 code/shell 类型（跟随当前分派策略）
          // 这些任务的执行模式与 agent/skill/command 一致
          const allConvs = this.convRepo.list()
          let resetCount = 0
          for (const conv of allConvs) {
              // channel=schedule 标记 + status=running 的会话上下文可能已丢失
              if (conv.channel === 'schedule' && conv.status === 'running') {
                  this.convRepo.updateMeta(conv.id, {status: 'active'})
                  resetCount++
              }
          }
          if (resetCount > 0) {
              logger.info(`resetStaleRunningStatus: ${resetCount} scheduler conversations reset from running to active`)
          }
      } catch (err) {
          logger.error('resetStaleRunningStatus failed:', {error: err instanceof Error ? err.message : String(err)})
      }
  }

  /**
   * 创建 Cron Worker 线程并加载已启用的调度任务
   * （仅负责 cron 定时检测，不执行 agentLoop）
   */
  private spawnCronWorker(): void {
      const workerPath = path.join(__dirname, 'schedulerWorker.js')
      this.worker = new Worker(workerPath, {type: 'module' as const} as any)

    const schedules = this.scheduleRepo.listEnabled()
    this.worker.postMessage({cmd: 'init', schedules})

    this.worker.on('message', (msg: any) => {
      if (msg.type === 'task_fire') {
        this.executeSchedule({...msg, source: 'cron'}).catch(err =>
          console.error('[SchedulerManager] execute failed:', err)
        )
      }
    })

      const restart = () => {
          setTimeout(() => {
              this.shutdown();
              this.spawnCronWorker()
          }, 5000)
      }
      this.worker.on('error', (err: Error) => {
          console.error('[SchedulerManager] Worker error:', err);
          restart()
      })
    this.worker.on('exit', (code) => {
      if (code !== 0) {
        logger.warn('worker.exit', {code: String(code)})
        restart()
      }
    })
  }

  // ─── 任务执行 ─────────────────────────────────────────────

  /**
   * 接收 Worker 的 task_fire 事件或手动触发，执行一次调度任务
   *
   * cron 与手动共享同一套执行流程：
   *   1. 并发保护检查（同一任务并行时跳过）
   *   2. 创建 AbortController（支持 stop() 终止）
   *   3. 创建调度会话记录
   *   4. 写入 /{能力名} {提示词} 用户消息
   *   5. 通过 agentManager.start 执行（Worker 线程 + 完整的会话生命周期）
   *   6. 更新最终状态：success / failure
   *
   * 唯一差异：source='cron' 时向 Worker 发送 ack 确认信号
   */
  private async executeSchedule(msg: {
    scheduleId: string
    taskType: string
    taskTarget: string
    taskArgs: any[]
    source: 'cron' | 'manual'
  }): Promise<{success: boolean; error?: string}> {
    // ① cron 来源需要向 Worker 发送 ack（避免重复触发）
    if (msg.source === 'cron') {
      this.worker?.postMessage({cmd: 'ack', scheduleId: msg.scheduleId})
    }

    // 获取任务信息
    const schedule = this.scheduleRepo.get(msg.scheduleId)
    const startTime = Date.now()

    logger.info('execute.start', {source: msg.source, scheduleId: msg.scheduleId, name: schedule?.name || '', type: msg.taskType, target: msg.taskTarget})

    // ② 并发保护：同一任务正在运行时跳过
    if (this.activeRuns.has(msg.scheduleId)) {
      logger.info('execute.duplicate', {scheduleId: msg.scheduleId})
      return {success: false, error: 'Task already running'}
    }

    // ③ 创建 AbortController，支持 stop() 终止
    const ac = new AbortController()
    this.activeRuns.set(msg.scheduleId, ac)

    // 更新状态为 running
    this.scheduleRepo.updateRunStatus(msg.scheduleId, 'running')

    let succeeded = false
    let convId = ''

    try {
      if (msg.taskType === 'script') {
        // Script 类型：执行脚本
        convId = ''
        const result = await this.runScript(msg.taskTarget, msg.taskArgs, convId, startTime, ac.signal)
        logger.info('execute.scriptResult', {source: msg.source, scheduleId: msg.scheduleId, success: String(result.success), error: result.error || '(none)'})
        succeeded = result.success
      } else {
        // Agent/Skill/Command 类型：创建会话 → 写入消息 → startAgentCore
        convId = crypto.randomUUID()
        this.createSchedulerConversation(convId, msg.scheduleId, schedule?.name || '', startTime, schedule?.workspaceId)
        logger.debug('execute.conversationCreated', {source: msg.source, convId, scheduleId: msg.scheduleId})

        const userContent = this.buildUserMessage(msg.taskTarget, msg.taskArgs)
        this.writeUserMessage(convId, userContent)
        logger.debug('execute.userMessageWritten', {source: msg.source, convId, content: userContent})

        const {startAgentCore} = await import('../agent/startAgentCore')
        await startAgentCore({
          conversationId: convId,
          message: userContent,
        }, 'scheduler')

        logger.info('execute.agentDone', {source: msg.source, scheduleId: msg.scheduleId, convId})
        succeeded = true
      }
    } catch (err: any) {
      logger.error('execute.exception', {source: msg.source, scheduleId: msg.scheduleId, error: err.message, stack: err.stack})
      succeeded = false
      return {success: false, error: err.message}
    } finally {
      // 更新最终状态
      const status = succeeded ? 'success' : 'failure'
      this.scheduleRepo.updateRunStatus(msg.scheduleId, status)
      this.activeRuns.delete(msg.scheduleId)
      // 更新会话状态，使侧边栏 pulse 动画停止
      if (convId) {
        this.updateConversationStatus(convId, 'active')
      }
      logger.info('execute.end', {source: msg.source, scheduleId: msg.scheduleId, status})
    }

    return {success: true}
  }

  /**
   * 构建用户消息内容：/{taskTarget} {prompt}
   */
  private buildUserMessage(taskTarget: string, taskArgs: any[]): string {
    const prompt = typeof taskArgs[0] === 'string' ? taskArgs[0].trim() : ''
    const content = `/${taskTarget} ${prompt || ''}`.trim()
    return content
  }

  /**
   * 更新会话预览并推送 UI 刷新事件。
   * ★ user 消息落库统一由 startAgentCore 处理（Phase 2 收敛），此处不再自行写入
   *   （此前双写导致会话中出现两条相同 user 消息，与 memo 链路同源）。
   */
  private writeUserMessage(convId: string, content: string): void {
    const now = Date.now()
    try {
      this.convRepo.updateMeta(convId, {preview: content.slice(0, 200), updatedAt: now})
    } catch {
      // 静默失败
    }

    try {
      const win = requireMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('conversation-updated', {
          id: convId,
          preview: content.slice(0, 200),
          updatedAt: now,
        })
      }
    } catch {
      // 静默失败
    }
  }

  /**
   * 创建定时任务专用的调度会话（workspacePath=hclawDir, channel='schedule'）
   * 该会话会出现在主会话列表中，以定时任务图标标识
   */
  private createSchedulerConversation(convId: string, scheduleId: string, name: string, startTime: number, workspaceId?: string | null): void {
    const pad = (n: number) => String(n).padStart(2, '0')
    const d = new Date(startTime)
    const timeStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

    // 根据 workspaceId 解析工作目录路径，若未指定则使用默认 hclawDir
    let workspacePath = getHclawDir()
    if (workspaceId) {
      try {
        const wsRepo = new SqliteWorkspaceRepository()
        const ws = wsRepo.getById(workspaceId)
        if (ws) {
          workspacePath = ws.path
        }
      } catch (err) {
        console.error('[SchedulerManager] failed to resolve workspace:', err)
      }
    }

    const meta: ConversationMeta = {
      id: convId,
      title: `${name} - ${timeStr}`,
      workspacePath,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      preview: '',
      status: 'running',
      scheduleId: scheduleId,
      // channel 用于会话列表图标（定时任务时钟图标）
      channel: 'schedule',
    }
    this.convRepo.create(convId, meta)

    // 推送新会话事件到渲染进程，使会话列表实时刷新
    try {
      const win = requireMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('conversation-created', {
          ...meta,
          pinned: false,
        })
      }
    } catch {
      // window module not ready yet
    }
  }

  // ─── 任务分派 ─────────────────────────────────────────────

  /**
   * 执行 Script 任务 — 通过 child_process.exec 直接执行本地脚本
   * 将执行日志写入 {hclawDir}/logs/schedules/{scheduleId}-{startTime}.log
   */
  private async runScript(
    target: string,
    args: any[],
    convId: string,
    startTime: number,
    signal: AbortSignal
  ): Promise<{success: boolean; output: string; error?: string}> {
    const scheduleId = Array.from(this.activeRuns.keys())[0] || 'unknown'

    try {
      const quotedArgs = args
        .map((a) => `"${String(a).replace(/"/g, '\\"')}"`)
        .join(' ')
      const {stdout, stderr} = await execAsync(
        `"${target}" ${quotedArgs}`,
        {
          timeout: 30 * 60 * 1000,
          signal,
          shell: 'powershell.exe',
          maxBuffer: 10 * 1024 * 1024,
        }
      )
      const duration = Date.now() - startTime
      this.writeScriptLog(scheduleId, startTime, {target, args, success: true, duration, stdout, stderr})

      return {
        success: true,
        output: (stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')).trim(),
      }
    } catch (err: any) {
      const duration = Date.now() - startTime
      this.writeScriptLog(scheduleId, startTime, {target, args, success: false, duration, stdout: err.stdout || '', stderr: err.stderr || err.message})

      return {
        success: false,
        output: err.stdout || '',
        error: err.stderr || err.message,
      }
    }
  }

  /**
   * 写入 Script 执行日志 — 路径: {hclawDir}/logs/schedules/{scheduleId}-{startTime}.log
   */
  private writeScriptLog(scheduleId: string, startTime: number, data: {
    target: string
    args: any[]
    success: boolean
    duration: number
    stdout: string
    stderr: string
  }): void {
    try {
      const hclawDir = getHclawDir()
      const logDir = path.join(hclawDir, 'logs', 'schedules')
      const logFile = path.join(logDir, `${scheduleId}-${startTime}.log`)

      // 确保目录存在
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, {recursive: true})
      }

      const timestamp = new Date().toISOString()
      const logEntry = [
        `[${timestamp}] === Script Execution ===`,
        `Command: ${data.target}`,
        `Args: ${JSON.stringify(data.args)}`,
        `Terminal: powershell`,
        `Status: ${data.success ? 'SUCCESS' : 'FAILURE'}`,
        `Duration: ${data.duration}ms`,
        `Stdout:\n${data.stdout || '(empty)'}`,
        `Stderr:\n${data.stderr || '(empty)'}`,
        '---\n',
      ].join('\n') + '\n'

      fs.writeFileSync(logFile, logEntry, 'utf-8')
    } catch (err) {
      console.error('[SchedulerManager] writeScriptLog failed:', err)
    }
  }

  // ─── IPC 控制方法 ─────────────────────────────────────────

  /**
   * 终止指定调度任务的当前执行
   */
  stop(scheduleId: string): void {
    const ac = this.activeRuns.get(scheduleId)
    if (ac) {
      ac.abort()
      this.activeRuns.delete(scheduleId)
    }
    // 终止时重置运行状态，避免状态卡死
    this.scheduleRepo.updateRunStatus(scheduleId, 'failure')
  }

  /**
   * 立即执行指定调度任务（无论 cron 是否匹配）
   * 完整复用 executeSchedule 流程：会话创建 → 消息写入 → agentManager.start → 状态更新
   */
  async runNow(id: string): Promise<{success: boolean; error?: string}> {
    logger.info('runNow.enter', {id})
    const schedule = this.scheduleRepo.get(id)
    if (!schedule) {
      console.warn(`[SchedulerManager][runNow] 未找到 schedule id=${id}`)
      return {success: false, error: 'Schedule not found'}
    }
    logger.info('runNow.found', {id, name: schedule.name, taskType: schedule.taskType})
    if (schedule.taskType === 'script') {
      console.warn(`[SchedulerManager][runNow] script 类型不支持立即运行 id=${id}`)
      return {success: false, error: 'Script 类型不支持立即运行，请使用定时触发'}
    }

    return this.executeSchedule({
      scheduleId: id,
      taskType: schedule.taskType,
      taskTarget: schedule.taskTarget,
      taskArgs: schedule.taskArgs,
      source: 'cron',
    })
  }

  /**
   * 通知 Worker 更新/新增调度配置
   */
  upsertWorkerSchedule(schedule: ScheduleRecord): void {
    this.worker?.postMessage({cmd: 'update', schedule})
  }

  /**
   * 通知 Worker 删除调度配置
   */
  deleteWorkerSchedule(id: string): void {
    this.worker?.postMessage({cmd: 'delete', id})
  }

  /**
   * 关闭调度管理器：终止所有运行、关闭 Worker 和 Worker 池
   */
  shutdown(): void {
    for (const [, ac] of this.activeRuns) ac.abort()
    this.activeRuns.clear()
    this.worker?.postMessage({cmd: 'shutdown'})
    this.worker?.terminate()
    this.worker = null
  }
}

export const schedulerManager = new SchedulerManager()
