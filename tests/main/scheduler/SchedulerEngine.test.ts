/**
 * SchedulerEngine — cron 引擎行为测试
 *
 * seam：worker 消息协议。引擎端口（postMessage / close）由构造参数注入，
 * 测试直接实例化引擎、喂入站消息、断言出站消息，不启动 worker 线程。
 * 覆盖：到点触发 / 非到点不触发、两重去重（未 ack 层、分钟级层）各自独立生效、
 * 暂停期间不触发、恢复后继续、无活跃任务时不起定时器、init 装载的暂停记录 resume 后可触发、
 * 非法表达式不触发但留下日志、shutdown 收尾。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import {SchedulerEngine} from '@/main/scheduler/SchedulerEngine'
import type {
    SchedulerEngineInboundMessage,
    SchedulerEngineOutboundMessage,
    SchedulerEngineSchedule,
} from '@shared/types/schedule'

/** 捕获出站消息的端口桩 */
class FakePort {
    readonly messages: SchedulerEngineOutboundMessage[] = []
    closed = false
    postMessage(message: SchedulerEngineOutboundMessage): void { this.messages.push(message) }
    close(): void { this.closed = true }
}

function makeSchedule(overrides: Partial<SchedulerEngineSchedule> = {}): SchedulerEngineSchedule {
    return {
        id: overrides.id ?? 'sched-1',
        cronExpression: overrides.cronExpression ?? '* * * * *',
        taskType: overrides.taskType ?? 'agent',
        taskTarget: overrides.taskTarget ?? '扫描当前工作目录',
        taskArgs: overrides.taskArgs ?? [],
        enabled: overrides.enabled ?? true,
        paused: overrides.paused ?? false,
    }
}

/**
 * 用当前（伪）时间的**本地** 时:分 构造表达式，避免断言依赖运行机器的时区。
 * offsetMinutes = 0 → 与当前分钟匹配；非 0 → 落在另一个分钟上（必不匹配本分钟）。
 */
function localMinuteCron(offsetMinutes = 0): string {
    const d = new Date()
    const total = (d.getHours() * 60 + d.getMinutes() + offsetMinutes + 1440) % 1440
    return `${total % 60} ${Math.floor(total / 60)} * * *`
}

let port: FakePort
let engine: SchedulerEngine

function send(msg: SchedulerEngineInboundMessage): void { engine.handleMessage(msg) }
function fires(): SchedulerEngineOutboundMessage[] {
    return port.messages.filter(m => m.type === 'task_fire')
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'))
    port = new FakePort()
    engine = new SchedulerEngine(port)
})

afterEach(() => {
    engine.shutdown()
    vi.useRealTimers()
})

describe('SchedulerEngine — 生命周期与出站协议', () => {
    it('init 后发出 worker_ready，并为活跃任务启动 tick 定时器', () => {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
        send({cmd: 'init', schedules: [makeSchedule()]})
        expect(port.messages).toContainEqual({type: 'worker_ready'})
        expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    })

    it('无活跃任务时不起定时器；任务变为活跃后起定时器，删除后停', () => {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')

        send({cmd: 'init', schedules: [makeSchedule({enabled: false})]})
        vi.advanceTimersByTime(120_000)
        expect(setIntervalSpy).not.toHaveBeenCalled()
        expect(fires()).toHaveLength(0)

        send({cmd: 'update', schedule: makeSchedule({enabled: true})})
        expect(setIntervalSpy).toHaveBeenCalledTimes(1)

        send({cmd: 'delete', id: 'sched-1'})
        expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
    })
})

describe('SchedulerEngine — 到点触发与去重', () => {
    it('表达式与当前时间点匹配时触发一条 task_fire，携带任务类型/目标/参数', () => {
        send({
            cmd: 'init',
            schedules: [makeSchedule({
                cronExpression: localMinuteCron(0),
                taskType: 'skill',
                taskTarget: 'foo',
                taskArgs: ['--x'],
            })],
        })
        vi.advanceTimersByTime(1000)

        expect(fires()).toEqual([{
            type: 'task_fire',
            scheduleId: 'sched-1',
            taskType: 'skill',
            taskTarget: 'foo',
            taskArgs: ['--x'],
        }])
    })

    it('表达式与当前时间点不匹配时不触发', () => {
        send({cmd: 'init', schedules: [makeSchedule({cronExpression: localMinuteCron(1)})]})
        // 本分钟内 tick 29 次，一直不匹配到点时刻
        vi.advanceTimersByTime(29_000)
        expect(fires()).toHaveLength(0)
    })

    it('同一分钟内的多次 tick 只触发一次（秒级重复合并为分钟级）', () => {
        send({cmd: 'init', schedules: [makeSchedule()]})
        // 从 :30 推到 :59 —— 秒级 cron 本会触发 29 次，分钟级去重后只剩 1 次
        vi.advanceTimersByTime(29_000)
        expect(fires()).toHaveLength(1)
    })

    it('未 ack 时不重复触发，ack 后下一分钟恢复（未 ack 层）', () => {
        send({cmd: 'init', schedules: [makeSchedule()]})
        vi.advanceTimersByTime(1000)
        expect(fires()).toHaveLength(1)

        // 跨到下一分钟：未 ack 层挡住，分钟级层已放行
        vi.advanceTimersByTime(60_000)
        expect(fires()).toHaveLength(1)

        send({cmd: 'ack', scheduleId: 'sched-1'})
        vi.advanceTimersByTime(60_000)
        expect(fires()).toHaveLength(2)
    })

    it('同一分钟内 ack 之后仍不重复触发（分钟级层独立生效）', () => {
        send({cmd: 'init', schedules: [makeSchedule()]})

        vi.advanceTimersByTime(1000) // :31 第一次触发请求
        expect(fires()).toHaveLength(1)

        // 两次 ack 后未 ack 层已放行，同一分钟内只剩分钟级去重挡着
        send({cmd: 'ack', scheduleId: 'sched-1'})
        vi.advanceTimersByTime(1000) // :32 第二次触发请求（本应被分钟级去重拦下）
        send({cmd: 'ack', scheduleId: 'sched-1'})
        vi.advanceTimersByTime(5000) // :33…:37 仍在本分钟内

        expect(fires()).toHaveLength(1)
    })

    // ── 缺陷 task-00e2e2bf：编辑任务不得清空分钟去重键 ──────────────────
    // 真实调用链：编辑/启停 → IPC scheduler-update → scheduleOps.updateSchedule()
    // → schedulerManager.upsertWorkerSchedule() → worker {cmd:'update'} → engine.upsert()。
    it('同一分钟内编辑任务（upsert 同一条）不二次触发：分钟去重键必须被保留', () => {
        send({cmd: 'init', schedules: [makeSchedule({cronExpression: localMinuteCron(0), taskTarget: '原名'})]})
        vi.advanceTimersByTime(1000) // :31 命中本分钟，触发一次
        expect(fires()).toHaveLength(1)

        // :32 用户改了个名字 —— 表达式未变、时间仍在同一分钟内
        send({cmd: 'update', schedule: makeSchedule({cronExpression: localMinuteCron(0), taskTarget: '改名后'})})
        vi.advanceTimersByTime(20_000) // :33…:52 仍在本分钟内

        expect(fires()).toHaveLength(1)
    })

    it('编辑没有把任务永久卡住：跨过这一分钟后照常触发', () => {
        send({cmd: 'init', schedules: [makeSchedule()]}) // 每分钟都命中
        vi.advanceTimersByTime(1000)
        expect(fires()).toHaveLength(1)

        send({cmd: 'update', schedule: makeSchedule({taskTarget: '改名后'})})
        vi.advanceTimersByTime(20_000) // 本分钟内：不重复
        expect(fires()).toHaveLength(1)

        send({cmd: 'ack', scheduleId: 'sched-1'})
        vi.advanceTimersByTime(40_000) // 跨到下一分钟
        expect(fires()).toHaveLength(2)
    })

    it('delete 仍然清掉分钟去重键：任务删掉再重建，同一分钟内可以重新触发', () => {
        send({cmd: 'init', schedules: [makeSchedule()]})
        vi.advanceTimersByTime(1000)
        expect(fires()).toHaveLength(1)

        send({cmd: 'delete', id: 'sched-1'})
        send({cmd: 'update', schedule: makeSchedule()})
        vi.advanceTimersByTime(1000)

        expect(fires()).toHaveLength(2)
    })

    it('非法 cron 表达式不触发也不抛错，但会带 id 与表达式打日志', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        send({cmd: 'init', schedules: [makeSchedule({id: 'sched-bad', cronExpression: 'not-a-cron'})]})
        expect(() => vi.advanceTimersByTime(300_000)).not.toThrow()
        expect(fires()).toHaveLength(0)

        // init 时校验一次；此后每次 tick 不再重复刷屏
        expect(errorSpy).toHaveBeenCalledTimes(1)
        expect(String(errorSpy.mock.calls[0][0])).toContain('sched-bad')
        expect(String(errorSpy.mock.calls[0][0])).toContain('not-a-cron')

        // update 换上的非法表达式同样留痕
        send({cmd: 'update', schedule: makeSchedule({id: 'sched-bad', cronExpression: 'also-bad'})})
        expect(errorSpy).toHaveBeenCalledTimes(2)
        expect(String(errorSpy.mock.calls[1][0])).toContain('also-bad')
    })
})

describe('SchedulerEngine — 暂停与恢复', () => {
    it('暂停期间不触发，恢复后继续触发', () => {
        send({cmd: 'init', schedules: [makeSchedule()]})
        send({cmd: 'pause', id: 'sched-1'})

        vi.advanceTimersByTime(120_000)
        expect(fires()).toHaveLength(0)

        send({cmd: 'resume', id: 'sched-1'})
        vi.advanceTimersByTime(1000)
        expect(fires()).toHaveLength(1)
    })

    it('paused 记录在 init 时即进入暂停态，不触发', () => {
        send({cmd: 'init', schedules: [makeSchedule({paused: true})]})
        vi.advanceTimersByTime(120_000)
        expect(fires()).toHaveLength(0)
    })

    it('init 装载的暂停记录收到 resume 后能触发（F1：记录必须先进 schedules Map）', () => {
        // 全部暂停 → hasActiveSchedules() 为 false，init 不该起定时器
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
        send({cmd: 'init', schedules: [makeSchedule({paused: true})]})
        expect(setIntervalSpy).not.toHaveBeenCalled()

        vi.advanceTimersByTime(120_000)
        expect(fires()).toHaveLength(0)

        send({cmd: 'resume', id: 'sched-1'})
        vi.advanceTimersByTime(1000)
        expect(fires()).toHaveLength(1)
    })
})

describe('SchedulerEngine — shutdown', () => {
    it('shutdown 停止定时器并关闭端口', () => {
        send({cmd: 'init', schedules: [makeSchedule()]})
        send({cmd: 'shutdown'})

        expect(port.closed).toBe(true)
        vi.advanceTimersByTime(60_000)
        expect(fires()).toHaveLength(0)
    })
})
