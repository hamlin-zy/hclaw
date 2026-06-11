import {parentPort} from 'worker_threads'
import {CronExpressionParser} from 'cron-parser'

interface ScheduleRecord {
  id: string
  cronExpression: string
  taskType: string
  taskTarget: string
  taskArgs: any[]
  enabled: boolean
  paused: boolean
}

class SchedulerEngine {
  private schedules = new Map<string, ScheduleRecord>()
  private pausedTasks = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private pendingFires = new Set<string>()
  /** 记录每个 schedule 最后触发的分钟（分钟级去重，防止每秒重复触发） */
  private lastFiredMinute = new Map<string, number>()

  init(schedules: ScheduleRecord[]) {
    for (const s of schedules) {
      this.schedules.set(s.id, s)
      if (s.paused) this.pausedTasks.add(s.id)
    }
      this.restartTickIfNeeded()
    parentPort!.postMessage({type: 'worker_ready'})
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
      return false
    }
  }

  private fire(schedule: ScheduleRecord) {
    this.pendingFires.add(schedule.id)
    this.lastFiredMinute.set(schedule.id, Math.floor(Date.now() / 60000))
    parentPort!.postMessage({
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

  upsert(schedule: ScheduleRecord) {
    this.schedules.set(schedule.id, schedule)
    if (schedule.paused) this.pausedTasks.add(schedule.id)
    else this.pausedTasks.delete(schedule.id)
    this.pendingFires.delete(schedule.id)
    this.lastFiredMinute.delete(schedule.id)
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

const engine = new SchedulerEngine()

parentPort!.on('message', (msg: any) => {
  switch (msg.cmd) {
    case 'init': engine.init(msg.schedules); break
    case 'update': engine.upsert(msg.schedule); break
    case 'delete': engine.delete(msg.id); break
    case 'pause': engine.pause(msg.id); break
    case 'resume': engine.resume(msg.id); break
    case 'ack': engine.ack(msg.scheduleId); break
    case 'shutdown': engine.shutdown(); parentPort!.close(); break
  }
})
