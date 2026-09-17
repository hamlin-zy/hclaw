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
import {spawn} from 'child_process'
import {StringDecoder} from 'node:string_decoder'
import {scheduleRepo} from './ScheduleRepository'
import {createConversationRepository} from '../repositories'
import type {IConversationRepository} from '../repositories/interfaces'
import type {ConversationMeta} from '@shared/types'
import type {
    ScheduleFireSource,
    ScheduleRecord,
    ScheduleTaskType,
    SchedulerEngineInboundMessage,
    SchedulerEngineOutboundMessage,
} from '@shared/types/schedule'
import {getScriptLogDir} from './scriptLogPath'
import {checkScheduleWorkspace} from './scheduleWorkspace'
// 仅含常量与 `import type`（无 electron 运行时依赖），不会污染本模块的 worker 闭包
import {SCHEDULER_WORKER_RESOURCE_LIMITS} from '../workerLimits'
// 超时/取消时按 pid 树杀：根进程存活时才能遍历到子孙（见 ../common/killProcessTree）
import {killProcessTree} from '../common/killProcessTree'

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

class SchedulerManager {
  private worker: Worker | null = null
  /**
   * 已关闭标志：shutdown() 首行置位。
   * exit/error 处理器先判此标志直接 return——否则 shutdown() 的 terminate() 产生的
   * 非 0 exit 会再次触发 restart → shutdown → terminate，形成永久"终止-重建"循环。
   */
  private stopped = false
  /** 已排期的崩溃重启定时器句柄（提为字段以便 shutdown 时取消 + error/exit 去重） */
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private activeRuns = new Map<string, AbortController>()
  public scheduleRepo = scheduleRepo

  /**
   * 记录更新后的**广播钩子** —— 由主进程启动时注入（`initScheduleIPC`，见 scheduleIPC.ts）。
   *
   * 为什么是注入而不是直接 import scheduleBroadcast：本模块位于 Agent Worker 的静态依赖
   * 闭包内（builtin/schedulerManageTool → scheduler/index），而 scheduleBroadcast 顶层
   * `import {BrowserWindow} from 'electron'`；静态引入会把 electron 拉进 worker 闭包
   * （tests/main/deps/workerNoElectron.test.ts 会拦这条边），而惰性 require 在 ESM 产物下
   * 无法依赖。于是把「怎么广播」交给主进程侧注入，本模块只决定「何时该广播」。
   */
  public onRecordUpdated: ((record: ScheduleRecord) => void) | null = null
  /** 广播钩子缺失的告警去重位：只喊一次（见 `broadcastRecordUpdated`），避免每次状态写入都刷屏 */
  private broadcastMissingWarned = false
  private convRepo: IConversationRepository

  constructor() {
    this.convRepo = createConversationRepository()
  }

  /** 向 cron 引擎发送一条入站消息（协议见 @shared/types/schedule） */
  private postToWorker(msg: SchedulerEngineInboundMessage): void {
    this.worker?.postMessage(msg)
  }

  // ─── 生命周期 ─────────────────────────────────────────────

  /**
   * 初始化调度管理器，启动 Worker 线程 + Agent Worker 池
   */
  init(): void {
      // ★ 应用启动时将残留 running 的调度会话重置为 active
      // 避免开发环境强制退出后侧边栏一直闪烁
      this.resetStaleConversationStatus()
      // ★ 应用启动时将配置表里残留的「运行中」复位为「失败」
      // 避免被中断的执行让列表永久停在「运行中」
      this.resetInterruptedRunStatus()

      this.spawnCronWorker()
  }

  /**
   * 更新定时任务会话状态
   */
  private updateConversationStatus(convId: string, status: 'active' | 'running' | 'archived'): void {
      try {
          this.convRepo.updateMeta(convId, {status})
      } catch (err) {
          logger.error('updateConversationStatus.failed', {
              convId, status, error: err instanceof Error ? err.message : String(err),
          })
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
          // 静默：窗口尚未就绪或已销毁（启动早期 / 退出中），UI 通知是 best-effort，
          // 不上报——此处上报只会在正常生命周期里制造噪声，且无任何可恢复动作。
      }
  }

  /**
   * 应用启动时将残留 'running' 状态的**调度会话**重置为 'active'
   *
   * 开发环境下 CTRL+C 强制退出可能导致会话状态卡在 running，
   * 下次启动时侧边栏 isSchedulerRunning 检查到 status=running 会一直闪烁。
   * 应用启动时不可能有正在运行的任务，状态重置是幂等且无损的。
   *
   * 判定条件：`channel === 'schedule' && status === 'running'` —— 只看会话渠道，
   * 与任务类型（agent / skill / command / script）无关。
   * 注意这与配置表的运行结果复位（resetInterruptedRunStatus）是**两件事**：
   * 本方法改的是会话的 status（active / running / archived），
   * 后者改的是 schedules 表的 last_run_status（none / running / success / failure）。
   */
  resetStaleConversationStatus(): void {
      try {
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
              logger.info(`resetStaleConversationStatus: ${resetCount} scheduler conversations reset from running to active`)
          }
      } catch (err) {
          logger.error('resetStaleConversationStatus failed:', {error: err instanceof Error ? err.message : String(err)})
      }
  }

  /**
   * 应用启动时将配置表里残留的 `last_run_status = 'running'` 复位为 `'failure'`
   *
   * 上次执行被中断（强制退出 / 崩溃）时，schedules 表的运行状态会永久停在
   * 'running'，列表里永远显示「运行中」。启动时不可能有正在执行的任务，
   * 因此把残留的 running 标记为 failure（语义：这一轮被中断，没跑完）。
   *
   * 只动 running：none / success / failure 一律不受影响（仓储层按状态过滤）。
   * 复位条数写入日志；仓储层失败会抛 ScheduleError，此处显式降级为日志留痕，
   * 不让它中断启动流程。
   */
  resetInterruptedRunStatus(): void {
      try {
          const resetCount = this.scheduleRepo.resetRunningToFailure()
          if (resetCount > 0) {
              logger.info(`resetInterruptedRunStatus: ${resetCount} schedules reset from running to failure`)
          }
      } catch (err) {
          logger.error('resetInterruptedRunStatus failed:', {error: err instanceof Error ? err.message : String(err)})
      }
  }

  /**
   * 创建 Cron Worker 线程并装载调度任务（仅负责 cron 定时检测，不执行 agentLoop）
   *
   * 装载的是**所有启用**的记录（`listEnabled()`），**包含已暂停的**：暂停是引擎侧的
   * 运行时状态，靠记录自带的 `paused` 字段在 init 时进入暂停态（SchedulerEngine.init）。
   * 若这里把暂停记录滤掉，引擎的 schedules Map 里就不会有这条记录，`{cmd:'resume'}`
   * 将无处生效——恢复后按原表达式继续触发会失效（F1）。
   * 是否真的起定时器由引擎判定：全部暂停时 hasActiveSchedules() 为 false，不起 tick。
   */
  private spawnCronWorker(): void {
      const workerPath = path.join(__dirname, 'schedulerWorker.js')
      // ★ 内存加固（评审建议 4）：cron 定时检测 worker，常驻但负载极轻 → 256/16，见 ../workerLimits.ts。
      this.worker = new Worker(workerPath, {
          type: 'module',
          resourceLimits: SCHEDULER_WORKER_RESOURCE_LIMITS,
      } as any)

    // 显式降级：存储异常时以空列表启动（与旧行为一致），但不静默——日志留痕。
    // 仓储层不再把写/读失败降级成 fallback 值，所以这里必须自己兜住。
    let schedules: ScheduleRecord[] = []
    try {
      schedules = this.scheduleRepo.listEnabled()
    } catch (err) {
      logger.error('spawnCronWorker: listEnabled failed, starting with empty schedule set', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    this.postToWorker({cmd: 'init', schedules})

    this.worker.on('message', (msg: SchedulerEngineOutboundMessage) => {
      if (msg.type === 'task_fire') {
        this.executeSchedule({...msg, source: 'cron'}).catch(err =>
          // 带上 stack：这条是未预期异常的兜底，只有 message 不足以定位（口径与 worker.error 一致）
          logger.error('execute.failed', {
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          })
        )
      }
    })

      // ★ 崩溃恢复：仅排期一次重启。error 与 exit 可能先后触发（error 后紧跟 exit），
      //   restartTimer 已存在时直接忽略，避免排两个定时器导致 Worker 双启。
      const restart = () => {
          if (this.stopped || this.restartTimer) return
          this.restartTimer = setTimeout(() => {
              this.restartTimer = null
              if (this.stopped) return
              this.shutdown();
              // ★ 重启路径需要复位：shutdown() 置 stopped=true 是供退出场景使用，
              //   此处紧随其后复位，保持既有崩溃恢复（5s 后重建）行为不变。
              this.stopped = false
              this.spawnCronWorker()
          }, 5000)
      }
      // ★ 句柄身份守卫：shutdown() 会 terminate 并置 this.worker=null，被终止 Worker 的
      //   非 0 exit 在后续 tick 到达时 this.worker 已换新/为 null → 直接忽略，
      //   杜绝「终止-重建」自激循环（与 mcpWorkerManager.shuttingDown 同类，此处用实例身份）。
      const spawned = this.worker
      this.worker.on('error', (err: Error) => {
          if (this.stopped || this.worker !== spawned) return
          logger.error('worker.error', {message: err.message, stack: err.stack})
          restart()
      })
    this.worker.on('exit', (code) => {
      if (this.stopped || this.worker !== spawned) return
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
   *   1. 工作目录守卫（不 ok 直接拦下：记一次失败，不执行、不改任务状态）
   *   2. 并发保护检查（同一任务并行时跳过）
   *   3. 创建 AbortController（支持 stop() 终止）
   *   4. 创建调度会话记录
   *   5. 写入 /{能力名} {提示词} 用户消息
   *   6. 通过 agentManager.start 执行（Worker 线程 + 完整的会话生命周期）
   *   7. 更新最终状态：success / failure
   *
   * 唯一差异：source='cron' 时向 Worker 发送 ack 确认信号。
   * 注意 ack **先于**工作目录守卫：被拦也要先认领本轮触发，否则引擎的待确认去重
   * 会一直挂着这条任务。
   *
   * 触发来源由调用方显式传入（`ScheduleFireSource` 为唯一来源），不从执行状态反推：
   * 手动触发没有「本轮已认领」的语义，因而不得发送 ack —— ack 清的是引擎的
   * 待确认去重状态（pendingFires），那属于到点触发与引擎之间的账，手动路径不该动它。
   */
  private async executeSchedule(msg: {
    scheduleId: string
    taskType: ScheduleTaskType
    taskTarget: string
    taskArgs: any[]
    source: ScheduleFireSource
  }): Promise<{success: boolean; error?: string}> {
    // ① 只有到点触发需要向 Worker 发送 ack（认领本轮触发，避免重复触发）
    if (msg.source === 'cron') {
      this.postToWorker({cmd: 'ack', scheduleId: msg.scheduleId})
    }

    // 获取任务信息
    const schedule = this.scheduleRepo.get(msg.scheduleId)

    // ② 工作目录守卫 —— 唯一权威判定在工作目录解析函数里（见 ./scheduleWorkspace），
    //    cron 到点与立即执行共用同一份口径：未设置 / 工作区记录不存在 / 目录在磁盘上不是
    //    一个存在的目录 —— 一律不执行。
    //    **不改任务状态**：enabled / paused 原样保留（绝不自动禁用、绝不自动暂停）；
    //    只把这一轮记成失败（走 updateRunStatusSafe，它照常广播 updated）。
    //    位置刻意在 ack 之后：cron 路径的 ack 必须先发，否则引擎的待确认去重会卡住
    //    该任务（见文件头的执行流程说明），拦截也不能踩这条。
    const workspaceHealth = checkScheduleWorkspace(schedule?.workspaceId)
    if (workspaceHealth.state !== 'ok') {
      logger.warn('execute.workspaceBlocked', {
        source: msg.source,
        scheduleId: msg.scheduleId,
        state: workspaceHealth.state,
        workspaceId: schedule?.workspaceId ?? null,
        path: workspaceHealth.path,
        reason: workspaceHealth.reason,
      })
      this.updateRunStatusSafe(msg.scheduleId, 'failure')
      return {success: false, error: workspaceHealth.reason || '工作目录不可用'}
    }

    // 守卫判定 ok ⇒ 必带解析出的路径。显式断言而不是再查一次库（复核 S6）：
    // 旧实现把 workspaceId 交给 createSchedulerConversation 让它**二次解析**，
    // 那里的 catch 会静默回落到 getHclawDir() —— 守卫与二次解析之间没有任何事务保证，
    // DB 抖动就能复现本票要修的原始症状「会话落在 ~/.hclaw」。路径由守卫**传下去**，
    // 下游不再有兜底分支。真出现「ok 却无路径」说明判定被改坏了，按拦截处理并把原因留在日志里。
    const workspacePath = workspaceHealth.path
    if (!workspacePath) {
      logger.error('execute.workspacePathMissing', {
        source: msg.source, scheduleId: msg.scheduleId, state: workspaceHealth.state,
      })
      this.updateRunStatusSafe(msg.scheduleId, 'failure')
      return {success: false, error: '工作目录不可用'}
    }

    const startTime = Date.now()

    logger.info('execute.start', {source: msg.source, scheduleId: msg.scheduleId, name: schedule?.name || '', type: msg.taskType, target: msg.taskTarget})

    // ③ 并发保护：同一任务正在运行时跳过
    if (this.activeRuns.has(msg.scheduleId)) {
      logger.info('execute.duplicate', {scheduleId: msg.scheduleId})
      return {success: false, error: 'Task already running'}
    }

    // ④ 创建 AbortController，支持 stop() 终止
    const ac = new AbortController()
    this.activeRuns.set(msg.scheduleId, ac)

    // 更新状态为 running
    this.updateRunStatusSafe(msg.scheduleId, 'running')

    let succeeded = false
    let convId = ''

    try {
      if (msg.taskType === 'script') {
        // Script 类型：执行脚本（不产生调度会话）
        convId = ''
        const result = await this.runScript(msg.scheduleId, msg.taskTarget, msg.taskArgs, startTime, ac.signal)
        logger.info('execute.scriptResult', {source: msg.source, scheduleId: msg.scheduleId, success: String(result.success), error: result.error || '(none)'})
        succeeded = result.success
      } else {
        // Agent/Skill/Command 类型：创建会话 → 写入消息 → startAgentCore
        convId = crypto.randomUUID()
        this.createSchedulerConversation(convId, msg.scheduleId, schedule?.name || '', startTime, workspacePath)
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
      this.updateRunStatusSafe(msg.scheduleId, status)
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
   * 构建用户消息内容：/{taskTarget}\n{prompt}
   *
   * 分隔符必须是换行而非空格：prompt 常以 Markdown 标题（`## 任务目标`）开头，
   * 空格拼接会把标题并进第一行（`/General ## 任务目标`），解析侧虽用 `\s+` 兼容，
   * 但正文首行结构被破坏。与 CommandPalette / sessionHandoffTool / memoStore 的既有范式对齐。
   * 末尾 `.trim()` 同时兜住 prompt 为空时的尾随换行（`/${taskTarget}\n`.trim() === `/${taskTarget}`）。
   */
  private buildUserMessage(taskTarget: string, taskArgs: any[]): string {
    const prompt = typeof taskArgs[0] === 'string' ? taskArgs[0].trim() : ''
    const content = `/${taskTarget}\n${prompt || ''}`.trim()
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
    } catch (err) {
      // 显式降级：预览只是列表装饰，落库失败不该中断本次执行；但也不静默——留痕可查。
      logger.warn('writeUserMessage.previewUpdateFailed', {
        convId, error: err instanceof Error ? err.message : String(err),
      })
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
      // 静默：窗口尚未就绪或已销毁（启动早期 / 退出中），UI 通知是 best-effort，
      // 不上报——预览早已落库，缺失的只是一次刷新。
    }
  }

  /**
   * 创建定时任务专用的调度会话（channel='schedule'）。
   *
   * `workspacePath` 由调用方（工作目录守卫）解析后**传入**，本函数不再自己解析：
   * 一次执行只用一份判定结果，且下游没有任何「解析失败 → 落默认目录」的兜底分支
   * （复核 S6：那条兜底会把会话建到 `~/.hclaw` 上，正是本票要修的症状）。
   * 该会话会出现在主会话列表中，以定时任务图标标识
   */
  private createSchedulerConversation(convId: string, scheduleId: string, name: string, startTime: number, workspacePath: string): void {
    const pad = (n: number) => String(n).padStart(2, '0')
    const d = new Date(startTime)
    const timeStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

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
      // 静默：窗口尚未就绪或已销毁（启动早期 / 退出中），UI 通知是 best-effort，
      // 不上报——此路径没有可恢复动作，上报只会制造噪声。
    }
  }

  // ─── 任务分派 ─────────────────────────────────────────────

  /**
   * 执行 Script 任务 — 直接 spawn 本地脚本，并手动托管超时与取消。
   *
   * 日志归属由调用链显式传入的 `scheduleId` 决定（脚本执行使用 `writeScriptLog`
   * 落盘，路径见 ./scriptLogPath）；不再从 `activeRuns` 里取首个键推断——
   * 并发执行两个脚本任务时，后启动的那个会拿到先启动的任务 id，日志挂错任务。
   *
   * 为什么不用 `exec`：`exec` 的超时/取消走 Node 内建 kill，只结束**根进程**；而 Windows 上
   * 根进程一退出，`taskkill /F /T` 就再也遍历不到它的子孙（树已断开，同源说明见
   * ../agent/mcp/client.ts）——被 powershell 中继拉起的子进程会以孤儿身份活下来。改为显式
   * 持有 child：超时/取消时**在根进程存活时**按 pid 树杀，再等 `close` 事件结算；
   * 命令串、shell 语义、失败记录的字段（stdout / stderr）与改造前保持一致。
   */
  private async runScript(
    scheduleId: string,
    target: string,
    args: any[],
    startTime: number,
    signal: AbortSignal
  ): Promise<{success: boolean; output: string; error?: string}> {
    // 命令串与改造前逐字一致：exec 同样是按 shell 语义把整条命令交给 powershell.exe
    const command = `"${target}" ${args.map((a) => `"${String(a).replace(/"/g, '\\"')}"`).join(' ')}`
    const child = spawn(command, {shell: 'powershell.exe', windowsHide: true})

    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      // 按流各持一个解码器：管道 chunk 边界可能落在多字节字符中间，
      // 逐 chunk 调 Buffer.toString() 会把半个字符各自解成 U+FFFD（不可逆）。
      const outDec = new StringDecoder('utf8')
      const errDec = new StringDecoder('utf8')
      let stdoutBytes = 0
      let stderrBytes = 0
      /** 已发起树杀（超时 / 取消 / 输出超限三者共用，避免重复 taskkill） */
      let killed = false
      let settled = false

      /** 树杀：必须在根进程仍存活时调用，否则子孙已经不在可遍历的树里 */
      const killTree = (): void => {
        if (killed) return
        killed = true
        killProcessTree(child.pid)
      }

      // 30min 超时（与改造前 exec 的 timeout 同值同语义：到点即失败）
      const timer = setTimeout(killTree, 30 * 60 * 1000)
      const onAbort = (): void => {
        killTree()
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, {once: true})

      /**
       * 结算：撤掉超时定时器与 abort 监听，写脚本日志并回填结果。
       * close 与 error 可能先后到达（spawn 失败即如此），只认第一次。
       */
      const settle = (code: number | null, err?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        // 补上解码器里残留的半个字符（只在此处、且只在第一次结算时调用 end 为流收尾）
        stdout += outDec.end()
        stderr += errDec.end()

        const duration = Date.now() - startTime
        const success = !killed && code === 0
        // 失败文案与改造前一致（exec 的 `err.stderr || err.message`）：
        // 取消 → AbortError 原文；超时 / 非 0 退出且 stderr 为空 → Command failed: <命令>
        const errorText = stderr
          || (signal.aborted ? 'The operation was aborted' : err?.message || `Command failed: ${command}`)
        this.writeScriptLog(scheduleId, startTime, {
          target, args, success, duration, stdout, stderr: success ? stderr : errorText,
        })

        if (success) {
          resolve({success: true, output: (stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')).trim()})
        } else {
          resolve({success: false, output: stdout, error: errorText})
        }
      }

      // 输出上限：每流各 10MB、按字节计（stdout 与 stderr 分开计量，互不占用对方预算），
      // 任一流超出即树杀，避免失控脚本把主进程内存撑爆
      const MAX_OUTPUT = 10 * 1024 * 1024
      const collect = (chunk: Buffer, sink: 'stdout' | 'stderr'): void => {
        if (sink === 'stdout') {
          stdoutBytes += chunk.length
          stdout += outDec.write(chunk)
        } else {
          stderrBytes += chunk.length
          stderr += errDec.write(chunk)
        }
        if (stdoutBytes > MAX_OUTPUT || stderrBytes > MAX_OUTPUT) killTree()
      }
      child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'stdout'))
      child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'stderr'))

      child.on('close', (code: number | null) => settle(code))
      child.on('error', (err: Error) => settle(null, err))
    })
  }

  /**
   * 写入 Script 执行日志 — 目录由 ./scriptLogPath 统一提供（与读取方同一份拼接），
   * 文件名为 `{scheduleId}-{startTime}.log`。
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
      const logDir = getScriptLogDir()
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
      logger.error('writeScriptLog.failed', {
        scheduleId, logFile: `${scheduleId}-${startTime}.log`,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ─── IPC 控制方法 ─────────────────────────────────────────

  /**
   * 暂停指定调度任务：通知 cron 引擎立刻停止触发。
   *
   * 持久化（`paused` / `pausedAt`）由调用方在写入配置表后调用本方法；引擎侧是幂等的
   * 运行时状态。worker 崩溃重启时 `init` 装载**所有启用**记录（含暂停的），
   * 引擎按记录自带的 `paused` 字段把它放回暂停态，因此暂停不会因为重启而失效。
   */
  pause(scheduleId: string): void {
    this.postToWorker({cmd: 'pause', id: scheduleId})
  }

  /**
   * 恢复指定调度任务：通知 cron 引擎按原表达式继续触发。
   *
   * 前提：该记录已在引擎的 schedules Map 中（由启动时的 `{cmd:'init'}` 装载，见
   * spawnCronWorker）。引擎的 `resume` 只清暂停位并重启 tick，不会凭空创建记录——
   * 若 init 未装载该记录，resume 会空转，任务永不触发。
   */
  resume(scheduleId: string): void {
    this.postToWorker({cmd: 'resume', id: scheduleId})
  }

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
    this.updateRunStatusSafe(scheduleId, 'failure')
  }

  /**
   * 写入最近一次运行状态 —— 显式降级的 best-effort 写。
   *
   * 仓储层的 updateRunStatus 不再把存储失败降级成 false（改为抛出），但这里是执行器的
   * 状态记账：它失败不该中断执行、停止、删除这三条链路，也不该让 activeRuns 的清理被跳过。
   * 因此在此显式降级 —— 记录日志后继续，不静默吞掉。
   *
   * 写库成功后**读回记录并交给注入的广播钩子**（`onRecordUpdated`）：运行状态是记录的一部分，
   * 之前它从不广播，渲染层只能靠整表重取兜底（「立即执行 → 运行中 → 成功/失败」与「停止」
   * 都会把列表换成 loading 态、重置滚动位置）。有了这条广播，渲染层就地更新那一行即可。
   * best-effort：记录已被删除（读不回）时不广播，也不抛。
   */
  private updateRunStatusSafe(scheduleId: string, status: ScheduleRecord['lastRunStatus']): void {
    try {
      this.scheduleRepo.updateRunStatus(scheduleId, status)
    } catch (err) {
      logger.error('updateRunStatus failed', {
        scheduleId, status, error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    try {
      const record = this.scheduleRepo.get(scheduleId)
      if (record) this.broadcastRecordUpdated(record)
    } catch (err) {
      logger.error('updateRunStatus readback failed', {
        scheduleId, status, error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * 把「运行状态已变更」交给注入的广播钩子（`onRecordUpdated`）。
   *
   * 钩子由主进程启动时注入（`initScheduleIPC`）；**未注入时原先完全无声**：状态照常落库、
   * 广播静默不发——复核探针实测 `onRecordUpdated=null` 时 `sent=[]`，无异常、无日志、
   * 无断言失败，这类「链路没接上」只能靠人肉读代码发现。
   *
   * 这里**不抛**（在启动/执行链路上把故障面放大成硬中断，比少一次广播更糟），改为**一次性 warn**：
   * 报一次、留痕，之后由去重位压掉重复。
   */
  private broadcastRecordUpdated(record: ScheduleRecord): void {
    if (!this.onRecordUpdated) {
      if (!this.broadcastMissingWarned) {
        this.broadcastMissingWarned = true
        logger.warn('onRecordUpdated not injected — run-status broadcasts are silently dropped', {
          scheduleId: record.id,
        })
      }
      return
    }
    this.onRecordUpdated(record)
  }

  /**
   * 立即执行指定调度任务（无论 cron 是否匹配）
   * 完整复用 executeSchedule 流程：会话创建 → 消息写入 → agentManager.start → 状态更新
   *
   * 工作目录守卫在**最前面**：不可用的工作目录直接返回可读原因，不进执行流程。
   * 这条路径是防御性的（界面上该按钮此时已 disabled），但入口本身必须自洽：
   * 「不能跑的任务」不能靠界面拦，得由执行入口自己拦。
   */
  async runNow(id: string): Promise<{success: boolean; error?: string}> {
    logger.info('runNow.enter', {id})
    const schedule = this.scheduleRepo.get(id)
    if (!schedule) {
      logger.warn('runNow.notFound', {id})
      return {success: false, error: 'Schedule not found'}
    }
    const workspaceHealth = checkScheduleWorkspace(schedule.workspaceId)
    if (workspaceHealth.state !== 'ok') {
      logger.warn('runNow.workspaceBlocked', {
        id, state: workspaceHealth.state, workspaceId: schedule.workspaceId,
        path: workspaceHealth.path, reason: workspaceHealth.reason,
      })
      return {success: false, error: workspaceHealth.reason || '工作目录不可用'}
    }
    logger.info('runNow.found', {id, name: schedule.name, taskType: schedule.taskType})
    if (schedule.taskType === 'script') {
      logger.warn('runNow.scriptUnsupported', {id})
      return {success: false, error: 'Script 类型不支持立即运行，请使用定时触发'}
    }

    return this.executeSchedule({
      scheduleId: id,
      taskType: schedule.taskType,
      taskTarget: schedule.taskTarget,
      taskArgs: schedule.taskArgs,
      // 手动立即执行 —— 与到点触发在数据上可区分，且不触碰引擎的去重状态
      source: 'manual',
    })
  }

  /**
   * 通知 Worker 更新/新增调度配置
   */
  upsertWorkerSchedule(schedule: ScheduleRecord): void {
    this.postToWorker({cmd: 'update', schedule})
  }

  /**
   * 通知 Worker 删除调度配置
   */
  deleteWorkerSchedule(id: string): void {
    this.postToWorker({cmd: 'delete', id})
  }

  /**
   * 关闭调度管理器：终止所有运行、关闭 Worker 和 Worker 池
   */
  shutdown(): void {
    // ★ 首行置位：使 exit/error 处理器放弃重启（terminate() 本身会产生非 0 exit）
    this.stopped = true
    // 取消已排期的重启定时器，避免退出后 5s 又 spawn 一个新 Worker
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    for (const [, ac] of this.activeRuns) ac.abort()
    this.activeRuns.clear()
    this.postToWorker({cmd: 'shutdown'})
    this.worker?.terminate()
    this.worker = null
  }
}

export const schedulerManager = new SchedulerManager()
