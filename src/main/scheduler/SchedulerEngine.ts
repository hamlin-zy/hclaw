/**
 * SchedulerEngine — cron 定时检测引擎
 *
 * 端口（postMessage / close）由构造参数注入，因此可以在不启动 worker 线程的
 * 环境下直接实例化、喂入站消息、断言出站消息（见 tests/main/scheduler/SchedulerEngine.test.ts）。
 * 线程接线全部留在 worker.ts。
 *
 * 协议见 `@shared/types/schedule`（入站按 cmd 判别，出站按 type 判别），两端共用同一份。
 *
 * 约束：依赖闭包不得引入 electron —— 本模块位于 src/main/scheduler/worker.ts 的
 * 静态依赖闭包内（tests/main/deps/workerNoElectron.test.ts）。
 */
import {CronExpressionParser} from 'cron-parser'
import type {
  SchedulerEngineInboundMessage,
  SchedulerEnginePort,
  SchedulerEngineSchedule,
} from '@shared/types/schedule'

export class SchedulerEngine {
  private schedules = new Map<string, SchedulerEngineSchedule>()
  private pausedTasks = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private pendingFires = new Set<string>()
  /** 记录每个 schedule 最后触发的分钟（分钟级去重，防止每秒重复触发） */
  private lastFiredMinute = new Map<string, number>()

  constructor(private readonly port: SchedulerEnginePort) {}

  /** 处理一条来自主进程的入站消息 */
  handleMessage(msg: SchedulerEngineInboundMessage): void {
    switch (msg.cmd) {
      case 'init': this.init(msg.schedules); break
      case 'update': this.upsert(msg.schedule); break
      case 'delete': this.delete(msg.id); break
      case 'pause': this.pause(msg.id); break
      case 'resume': this.resume(msg.id); break
      case 'ack': this.ack(msg.scheduleId); break
      case 'shutdown': this.shutdown(); this.port.close(); break
    }
  }

  init(schedules: SchedulerEngineSchedule[]) {
    for (const s of schedules) {
      this.schedules.set(s.id, s)
      if (s.paused) this.pausedTasks.add(s.id)
      this.reportInvalidCron(s)
    }
      this.restartTickIfNeeded()
    this.port.postMessage({type: 'worker_ready'})
  }

  /**
   * 非法 cron 表达式不得静默：该任务会永不触发，必须在入站时留下可查的痕迹。
   * 只在 init/update 时校验（表达式仅在这两处变更），避免每秒钟的 tick 重复刷屏。
   */
  private reportInvalidCron(schedule: SchedulerEngineSchedule): void {
    try {
      CronExpressionParser.parse(schedule.cronExpression)
    } catch (err) {
      console.error(
        `[SchedulerEngine] 非法 cron 表达式，该定时任务不会触发: id=${schedule.id} expr=${schedule.cronExpression}`,
        err,
      )
    }
  }

    private restartTickIfNeeded() {
        const hasActive = this.hasActiveSchedules()
        if (hasActive && !this.timer) {
            this.timer = setInterval(() => this.tick(), 1000)
        } else if (!hasActive && this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }

    private hasActiveSchedules(): boolean {
        for (const [id, s] of this.schedules) {
            if (s.enabled && !this.pausedTasks.has(id)) return true
        }
        return false
  }

  private tick() {
    const now = Math.floor(Date.now() / 1000)
    const currentMinute = Math.floor(now / 60)
    for (const [id, schedule] of this.schedules) {
      if (!schedule.enabled || this.pausedTasks.has(id)) continue
      if (this.pendingFires.has(id)) continue
      if (this.lastFiredMinute.get(id) === currentMinute) continue
      if (this.matchesCron(schedule.cronExpression, now)) {
        this.fire(schedule)
      }
    }
  }

  private matchesCron(expression: string, nowSec: number): boolean {
    try {
      const interval = CronExpressionParser.parse(expression, {currentDate: new Date(nowSec * 1000)})
      // 匹配到分钟精度：前一分钟与当前秒对齐即触发
      const prev = interval.prev()
      return Math.floor(prev.getTime() / 60000) === Math.floor(nowSec / 60)
    } catch {
      // 表达式非法时按「不匹配」处理：非法性已在 init/upsert 经 reportInvalidCron 留痕，
      // 此处兜底不重复刷屏。
      return false
    }
  }

  private fire(schedule: SchedulerEngineSchedule) {
    this.pendingFires.add(schedule.id)
    this.lastFiredMinute.set(schedule.id, Math.floor(Date.now() / 60000))
    this.port.postMessage({
      type: 'task_fire',
      scheduleId: schedule.id,
      taskType: schedule.taskType,
      taskTarget: schedule.taskTarget,
      taskArgs: schedule.taskArgs,
    })
  }

  ack(scheduleId: string) { this.pendingFires.delete(scheduleId) }

    pause(id: string) {
        this.pausedTasks.add(id);
        this.restartTickIfNeeded()
    }

    resume(id: string) {
        this.pausedTasks.delete(id);
        this.restartTickIfNeeded()
    }

  /**
   * 新增 / 更新一条调度配置（主进程 {cmd:'update'} 走这里，新建与编辑、启停同步共用一条路）。
   *
   * **不在这里清 lastFiredMinute**（缺陷 task-00e2e2bf）：本方法是「新增」与「编辑同步」两义
   * 合一，而编辑必然发生在任务已经跑起来之后的任意时刻 —— 只要它仍落在触发过的同一分钟内，
   * 清键就等于放行同一分钟的第二次触发。分钟去重键是每分钟自然过期的，需要显式清掉的
   * 场合只有 delete（任务真的没了）与 shutdown（引擎收尾）；新建的任务本就没有键，不受影响。
   */
  upsert(schedule: SchedulerEngineSchedule) {
    this.schedules.set(schedule.id, schedule)
    if (schedule.paused) this.pausedTasks.add(schedule.id)
    else this.pausedTasks.delete(schedule.id)
    this.pendingFires.delete(schedule.id)
    this.reportInvalidCron(schedule)
      this.restartTickIfNeeded()
  }

  delete(id: string) {
    this.schedules.delete(id)
    this.pausedTasks.delete(id)
    this.pendingFires.delete(id)
    this.lastFiredMinute.delete(id)
      this.restartTickIfNeeded()
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer)
    this.schedules.clear()
    this.pausedTasks.clear()
    this.pendingFires.clear()
    this.lastFiredMinute.clear()
  }
}
