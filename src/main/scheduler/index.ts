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
import type {ModelConfig} from '../agent/model/types'
import {agentRegistry} from '../agent/agentRegistry'
import {CommandDispatcher} from '../plugin/commands'
import {runtimeConfigManager} from '../agent/runtimeConfigManager'
import {getModelConfigForAgentType, resolveModelConfig} from '../agent/model/modelSelector'
import {getHclawDir} from '../config'
import {SqliteWorkspaceRepository} from '../repositories/sqlite/workspaceRepository'
import {createLogger} from '../agent/logger'

const logger = createLogger('scheduler')

/** Phase 1 优化: Scheduler Agent Worker 池，替代主进程直跑 agentLoop */
class SchedulerWorkerPool {
    private workers: Worker[] = []
    private readyQueue: Worker[] = []
    private pendingTasks: any[] = []
    private pendingResolvers = new Map<string, (r: { success: boolean; output: string; error?: string }) => void>()
    private _onStream?: (scheduleId: string, content: string) => void
    private spawnCount = 0
    private readonly MAX_SPAWN = 10
    /** 跟踪每个 worker 当前正在执行的任务 scheduleId */
    private workerTasks = new Map<Worker, string>()
    /** Agent 启动/结束回调 */
    onAgentStart?: (scheduleId: string, convId: string) => void
    onAgentDone?: (scheduleId: string, convId: string, success: boolean) => void

    constructor(private poolSize = 2) {
    }

    set onStream(cb: ((scheduleId: string, content: string) => void) | undefined) {
        this._onStream = cb
    }

    init(): void {
        this.spawnCount = 0
        for (let i = 0; i < this.poolSize; i++) this.spawnWorker()
    }

    private spawnWorker(): void {
        if (++this.spawnCount > this.MAX_SPAWN) {
            console.error(`[SchedulerPool] spawn failed after ${this.MAX_SPAWN} attempts, giving up`)
            return
        }
        const workerPath = path.join(__dirname, 'schedulerAgentWorker.cjs')
        const worker = new Worker(workerPath)

        worker.on('message', (msg: any) => {
            if (msg.type === 'task:stream') {
                this._onStream?.(msg.scheduleId, msg.content)
                return
            }
            // 处理 Agent 启动/结束事件
            if (msg.type === 'agent:start') {
                // 通知主进程更新会话状态为 running
                this.onAgentStart?.(msg.scheduleId, msg.convId)
                return
            }
            if (msg.type === 'agent:done') {
                // 通知主进程更新会话状态为 archived
                this.onAgentDone?.(msg.scheduleId, msg.convId, msg.success)
                return
            }
            if (msg.type === 'task:result') {
                logger.debug('worker.taskResult', {scheduleId: msg.scheduleId, success: String(msg.success), error: msg.error?.slice(0, 200) || '(none)', outputLen: String((msg.output || '').length)})
                this.workerTasks.delete(worker)
                this.readyQueue.push(worker)
                this.processQueue()
                const resolve = this.pendingResolvers.get(msg.scheduleId)
                if (resolve) {
                    resolve({success: msg.success, output: msg.output || '', error: msg.error})
                    this.pendingResolvers.delete(msg.scheduleId)
                }
            }
        })

        const onWorkerDead = () => {
            // worker 挂了 → 将其正在执行的任务标记为失败
            const taskId = this.workerTasks.get(worker)
            if (taskId) {
                this.workerTasks.delete(worker)
                const resolve = this.pendingResolvers.get(taskId)
                if (resolve) {
                    resolve({success: false, output: '', error: 'Worker terminated unexpectedly'})
                    this.pendingResolvers.delete(taskId)
                }
            }
            this.workers = this.workers.filter(w => w !== worker)
            this.readyQueue = this.readyQueue.filter(w => w !== worker)
            setTimeout(() => this.spawnWorker(), 2000)
        }

        worker.on('error', (err: Error) => {
            console.error(`[SchedulerPool] worker error:`, (err as Error)?.message || err)
            onWorkerDead()
        })
        worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`[SchedulerPool] worker exited with code ${code}`)
            }
            onWorkerDead()
        })

        this.workers.push(worker)
        this.readyQueue.push(worker)
    }

    async executeTask(task: any): Promise<{ success: boolean; output: string; error?: string }> {
        const worker = this.readyQueue.shift()
        if (worker) {
            logger.debug('pool.dispatch', {convId: task.convId, scheduleId: task.scheduleId, readyQueueSize: String(this.readyQueue.length)})
            this.workerTasks.set(worker, task.scheduleId)
            worker.postMessage({cmd: 'run', task})
        } else {
            logger.debug('pool.queue', {convId: task.convId, scheduleId: task.scheduleId, pendingQueueSize: String(this.pendingTasks.length)})
            this.pendingTasks.push(task)
        }
        return new Promise((resolve) => {
            this.pendingResolvers.set(task.scheduleId, resolve)
        })
    }

    private processQueue(): void {
        while (this.readyQueue.length > 0 && this.pendingTasks.length > 0) {
            const worker = this.readyQueue.shift()!
            const next = this.pendingTasks.shift()!
            logger.debug('pool.processQueue', {convId: next.convId, scheduleId: next.scheduleId})
            this.workerTasks.set(worker, next.scheduleId)
            worker.postMessage({cmd: 'run', task: next})
        }
    }

    shutdown(): void {
        for (const w of this.workers) w.terminate()
        this.workers = []
        this.readyQueue = []
        this.pendingTasks = []
        this.pendingResolvers.clear()
        this.workerTasks.clear()
    }
}

const execAsync = promisify(exec)

class SchedulerManager {
  private worker: Worker | null = null
  private activeRuns = new Map<string, AbortController>()
  public scheduleRepo = scheduleRepo
  private convRepo: IConversationRepository
    /** Phase 1: Scheduler Agent Worker 池（替代主进程直跑 agentLoop） */
    private agentWorkerPool: SchedulerWorkerPool

  constructor() {
    this.convRepo = createConversationRepository()
      this.agentWorkerPool = new SchedulerWorkerPool(2)
  }

  // ─── 生命周期 ─────────────────────────────────────────────

  /**
   * 初始化调度管理器，启动 Worker 线程 + Agent Worker 池
   */
  init(): void {
      this.spawnCronWorker()
      // 设置 Agent Worker 池的回调
      this.agentWorkerPool.onAgentStart = (scheduleId, convId) => {
          this.updateConversationStatus(convId, 'running')
      }
      this.agentWorkerPool.onAgentDone = (scheduleId, convId, success) => {
          this.updateConversationStatus(convId, 'archived')
      }
      this.agentWorkerPool.init()
  }

  /**
   * 更新定时任务会话状态
   */
  private updateConversationStatus(convId: string, status: 'active' | 'running' | 'archived'): void {
      try {
          this.convRepo.updateMeta(convId, {status})
      } catch (err) {
          console.error('[SchedulerManager] updateConversationStatus failed:', err)
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
        // Agent/Skill/Command 类型：创建会话 → 写入消息 → agentManager.start
        convId = crypto.randomUUID()
        this.createSchedulerConversation(convId, msg.scheduleId, schedule?.name || '', startTime, schedule?.workspaceId)
        logger.debug('execute.conversationCreated', {source: msg.source, convId, scheduleId: msg.scheduleId})

        const userContent = this.buildUserMessage(msg.taskTarget, msg.taskArgs)
        this.writeUserMessage(convId, userContent)
        logger.debug('execute.userMessageWritten', {source: msg.source, convId, content: userContent})

        const {agentManager} = await import('../agent/manager')
        const currentScheme = runtimeConfigManager.getScheme()
        const currentProviders = runtimeConfigManager.getProviders()
        const convMeta = this.convRepo.readMeta(convId) as any
        const workingDir = convMeta?.workspacePath || getHclawDir()

        await agentManager.start({
          conversationId: convId,
          messages: [{
            role: 'user',
            content: userContent,
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          }],
          modelConfig: {} as any,
          workingDir,
          schemeConfig: currentScheme ? {
            scheme: currentScheme,
            providers: currentProviders as any,
          } : undefined,
          workMode: runtimeConfigManager.getWorkMode() as any,
        })

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
   * 向会话写入用户消息，更新预览并推送 UI 刷新事件
   */
  private writeUserMessage(convId: string, content: string): void {
    const now = Date.now()
    try {
      this.convRepo.writeMessages(convId, [{
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: now,
      }])
    } catch (err: any) {
      // 静默失败 — 不影响主流程
    }
    try {
      this.convRepo.updateMeta(convId, {preview: content.slice(0, 200), updatedAt: now})
    } catch (err: any) {
      // 静默失败
    }

    try {
      const {getMainWindow} = require('../window')
      const win = getMainWindow()
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
      const {getMainWindow} = require('../window')
      const win = getMainWindow()
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
   * 按 taskType 路由到具体的执行方法
   * Phase 1 优化:
   *   - agent/skill → 通过 Agent Worker 池执行（不再阻塞主进程）
   *   - command → 通过 Agent Worker 池执行（最终调 agentLoop）
   *   - script → 仍使用 child_process.exec（轻量，不会阻塞 UI）
   */
  private async dispatchTask(
    msg: {taskType: string; taskTarget: string; taskArgs: any[]; convId: string; startTime?: number},
    _signal: AbortSignal
  ): Promise<{success: boolean; output: string; error?: string}> {
    switch (msg.taskType) {
      case 'agent':
      case 'skill':
      case 'command':
          return this.runViaWorkerPool(msg)
      case 'script':
          return this.runScript(msg.taskTarget, msg.taskArgs, msg.convId, msg.startTime || Date.now(), _signal)
      default:
        return {
          success: false,
          output: '',
          error: `Unknown task type: ${msg.taskType}`,
        }
    }
  }

  /**
   * Phase 1: 通过 Agent Worker 池执行包含 agentLoop 的任务
   * 使用 /{能力名} {提示词} 格式构造消息，与用户在聊天栏输入一致
   */
  private async runViaWorkerPool(msg: {
      taskType: string
      taskTarget: string
      taskArgs: any[]
      convId: string
  }): Promise<{ success: boolean; output: string; error?: string }> {
      const getFirstArg = () =>
          typeof msg.taskArgs[0] === 'string' ? msg.taskArgs[0].trim() : ''

      let agentDef: any = null
      const userPrompt = getFirstArg()
      const content = `/${msg.taskTarget} ${userPrompt || ''}`.trim()

      // agent 类型需要传递 agentDef 给 agentLoop
      if (msg.taskType === 'agent') {
          agentDef = agentRegistry.get(msg.taskTarget)
          logger.debug('workerPool.agentDef', {name: agentDef?.name || 'null', convId: msg.convId})
      }

      const messages: Array<{ role: 'user'; content: string }> = [
          {role: 'user', content},
      ]

      logger.info('workerPool.submit', {convId: msg.convId, type: msg.taskType, target: msg.taskTarget, message: content})

      const modelConfig = this.getModelConfig()
      if (!modelConfig) {
          logger.error('workerPool.noModelConfig', {convId: msg.convId})
          return {success: false, output: '', error: '无法获取模型配置，请检查模型方案设置'}
      }

      logger.debug('workerPool.modelConfig', {provider: modelConfig.provider, model: modelConfig.model, convId: msg.convId})

      // 传递 providers + scheme 给 Worker 线程，用于初始化 ConfigBridge
      const providers = runtimeConfigManager.getProviders()
      const scheme = runtimeConfigManager.getConfig().scheme
      logger.debug('workerPool.providers', {providers: String(providers?.length), scheme: scheme?.id || '(none)', convId: msg.convId})

      const taskSettings = runtimeConfigManager.getSettings()

      return this.agentWorkerPool.executeTask({
          scheduleId: msg.taskTarget,
          convId: msg.convId,
          taskType: msg.taskType,
          messages,
          modelConfig,
          workingDir: runtimeConfigManager.getWorkingDir() || '',
          agentDef,
          providers,
          scheme,
          settings: taskSettings || undefined,
      })
  }

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

  /**
   * 获取当前运行时模型配置
   */
  private getModelConfig(): ModelConfig | null {
    const config = runtimeConfigManager.getConfig()
    const scheme = config.scheme
    const providers = runtimeConfigManager.getProviders()

    if (!scheme || providers.length === 0) return null

    // 优先使用 primary 角色的模型配置
    const result = getModelConfigForAgentType(scheme, 'General', providers)
    if (result) return result.modelConfig

    // 兜底：尝试 resolve primary 配置
    const primaryRoleConfig = scheme.roles.find(r => r.role === 'primary')
    if (primaryRoleConfig) {
      return resolveModelConfig(primaryRoleConfig, providers)
    }

    return null
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
      // Phase 1: 关闭 Agent Worker 池
      this.agentWorkerPool.shutdown()
  }
}

export const schedulerManager = new SchedulerManager()
