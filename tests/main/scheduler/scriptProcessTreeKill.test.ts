/**
 * 脚本任务的进程树收尾（内存泄漏 B 批 Task 1 / S1b）
 *
 * 三条被钉住的行为（seam 沿用 fireSourceAndScriptAttribution.test.ts：假 worker 触发
 * task_fire + 假 child_process，不真起进程）：
 *   1. 脚本任务改由 spawn 显式持有 child —— 命令串与 shell 语义与改造前一致。
 *   2. 取消 / 30min 超时：**根进程仍存活时**按 pid 树杀，再等 close 事件结算；
 *      结算之后不得再补刀（定时器与 abort 监听都要撤掉）。
 *   3. 失败记录的字段（stdout / stderr）与改造前一致：stderr 为空时回落到同一句文案。
 *
 * 真进程树的终止语义（taskkill /T 是否真的带走子孙）由
 * tests/main/common/killProcessTree.test.ts 与
 * tests/main/agent/skills/scriptExecutor.treeKill.test.ts（真起孙进程）覆盖。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('@/main/config', () => {
    const os = require('os')
    const pathMod = require('path')
    const testDir = pathMod.join(os.tmpdir(), 'hclaw-test-script-tree-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => pathMod.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩

/** worker_threads 的假实现：捕获消息处理器，不真的起线程 */
vi.mock('worker_threads', () => {
    class FakeWorker {
        static instances: FakeWorker[] = []
        readonly posted: unknown[] = []
        readonly handlers: Record<string, (arg: unknown) => void> = {}
        constructor() { FakeWorker.instances.push(this) }
        on(event: string, handler: (arg: unknown) => void): void { this.handlers[event] = handler }
        postMessage(msg: unknown): void { this.posted.push(msg) }
        terminate(): void { /* no-op */ }
    }
    return {Worker: FakeWorker}
})

/** 假 child：pid 固定，输出与退出由测试逐条放行（真进程不启动） */
interface FakeChild {
    pid: number
    pushStdout(text: string): void
    pushStderr(text: string): void
    /** 按原始 Buffer 推送：用于把多字节字符刻意劈在 chunk 边界上 */
    pushStdoutRaw(buf: Buffer): void
    pushStderrRaw(buf: Buffer): void
    close(code: number | null): void
}

const spawnCalls = vi.hoisted(() => [] as Array<{
    cmd: string
    opts: {shell?: string; windowsHide?: boolean}
    child: FakeChild
}>)

vi.mock('child_process', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升，无法用 ESM import
    const {EventEmitter} = require('events') as typeof import('events')
    return {
        spawn: (cmd: string, opts: {shell?: string; windowsHide?: boolean}) => {
            const child = new EventEmitter() as InstanceType<typeof EventEmitter> & FakeChild
            const out = new EventEmitter()
            const err = new EventEmitter()
            child.pid = 4242
            Object.assign(child, {stdout: out, stderr: err})
            child.pushStdout = (text: string) => { out.emit('data', Buffer.from(text)) }
            child.pushStderr = (text: string) => { err.emit('data', Buffer.from(text)) }
            child.pushStdoutRaw = (buf: Buffer) => { out.emit('data', buf) }
            child.pushStderrRaw = (buf: Buffer) => { err.emit('data', buf) }
            child.close = (code: number | null) => { child.emit('close', code) }
            spawnCalls.push({cmd, opts, child})
            return child
        },
    }
})

/** 树杀是本次改造的着力点：只记调用（真进程树的语义另有单测与集成测） */
const killTreeCalls = vi.hoisted(() => [] as Array<number | undefined>)
vi.mock('@/main/common/killProcessTree', () => ({
    killProcessTree: (pid: number | undefined) => { killTreeCalls.push(pid) },
}))

const loggerStub = vi.hoisted(() => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}))
vi.mock('@/main/agent/logger', () => ({createLogger: () => loggerStub}))

const convRepoStub = vi.hoisted(() => ({
    list: vi.fn(() => [] as unknown[]),
    create: vi.fn(),
    updateMeta: vi.fn(),
    readMessages: vi.fn(() => [] as unknown[]),
    readMeta: vi.fn(() => null),
}))
vi.mock('@/main/repositories', () => ({createConversationRepository: () => convRepoStub}))

const scheduleRepoStub = vi.hoisted(() => ({
    get: vi.fn(),
    listEnabled: vi.fn(() => [] as unknown[]),
    updateRunStatus: vi.fn(),
    resetRunningToFailure: vi.fn(() => 0),
}))
vi.mock('@/main/scheduler/ScheduleRepository', () => ({scheduleRepo: scheduleRepoStub}))

vi.mock('@/main/repositories/sqlite/workspaceRepository', () => ({
    SqliteWorkspaceRepository: class {
        getById(id: string) {
            return id === 'ws-fixture' ? {id, path: require('os').tmpdir(), name: 'fixture'} : null
        }
        tryGetById(id: string) {
            const found = id === 'ws-fixture' ? {id, path: require('os').tmpdir(), name: 'fixture'} : null
            return found ? {kind: 'ok', workspace: found} : {kind: 'missing'}
        }
        tryList() { return {kind: 'ok', workspaces: []} }
    },
}))

import {schedulerManager} from '@/main/scheduler'
import {getHclawDir} from '@/main/config'
import type {ScheduleRecord} from '@shared/types/schedule'

function recordOf(overrides: Partial<ScheduleRecord>): ScheduleRecord {
    return {
        id: 'sched-x', name: '任务', description: '', cronExpression: '0 9 * * *',
        taskType: 'script', taskTarget: 'tree.js', taskArgs: [], enabled: true, paused: false,
        pausedAt: null, lastRunAt: null, lastRunStatus: 'none', lastRunConversationId: null,
        runCount: 0, createdAt: 1, updatedAt: 1,
        workspaceId: 'ws-fixture',
        ...overrides,
    }
}

type FakeWorkerInstance = {posted: unknown[]; handlers: Record<string, (arg: unknown) => void>}
type ManagerInternals = {
    spawnCronWorker(): void
    /** 直接调用私有执行体：若要观测 resolve 出去的 output，走 fireTask 是拿不到的 */
    runScript(
        scheduleId: string, target: string, args: unknown[], startTime: number, signal: AbortSignal
    ): Promise<{success: boolean; output: string; error?: string}>
}

/** 起一次假 worker（不调 init()，避免残留状态复位等无关流程），返回出站事件入口 */
function fireTask(msg: {scheduleId: string; taskTarget?: string; taskArgs?: unknown[]}): void {
    ;(schedulerManager as unknown as ManagerInternals).spawnCronWorker()
    const worker = (schedulerManager as unknown as {worker: FakeWorkerInstance}).worker
    worker.handlers.message({
        type: 'task_fire',
        scheduleId: msg.scheduleId,
        taskType: 'script',
        taskTarget: msg.taskTarget ?? 'tree.js',
        taskArgs: msg.taskArgs ?? [],
    })
}

/** 读该任务最近一次执行的脚本日志（目录口径与 scriptLogPath 一致） */
function scriptLogOf(scheduleId: string): string {
    const dir = path.join(getHclawDir(), 'logs', 'schedules')
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : []
    const file = files.find((f) => f.startsWith(`${scheduleId}-`))
    if (!file) throw new Error(`未找到 ${scheduleId} 的脚本日志；目录内容：${files.join(', ') || '(空)'}`)
    return fs.readFileSync(path.join(dir, file), 'utf-8')
}

beforeEach(() => {
    vi.clearAllMocks()
    scheduleRepoStub.listEnabled.mockReturnValue([])
    spawnCalls.length = 0
    killTreeCalls.length = 0
})

afterEach(() => {
    ;(schedulerManager as unknown as {worker: unknown}).worker = null
})

describe('S1b — 脚本任务显式持有 child', () => {
    it('用 spawn 起脚本，命令串与 shell 语义与改造前一致', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 'sched-spawn', taskTarget: 'pkg.js', taskArgs: ['a b']}))

        fireTask({scheduleId: 'sched-spawn', taskTarget: 'pkg.js', taskArgs: ['a b']})
        await vi.waitFor(() => expect(spawnCalls).toHaveLength(1))

        const {cmd, opts} = spawnCalls[0]
        expect(cmd).toBe('"pkg.js" "a b"')
        expect(opts.shell).toBe('powershell.exe')

        // 收尾：放行退出，避免用例结束后仍有在途 promise
        spawnCalls[0].child.close(0)
        await vi.waitFor(() => expect(scriptLogOf('sched-spawn')).toContain('Status: SUCCESS'))
        expect(killTreeCalls).toEqual([])
    })
})

describe('S1b — 取消路径在根进程存活时树杀', () => {
    it('stop() → 按 pid 树杀 → close 结算为失败，stdout/stderr 原样入日志', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 'sched-abort'}))

        fireTask({scheduleId: 'sched-abort'})
        await vi.waitFor(() => expect(spawnCalls).toHaveLength(1))
        const {child} = spawnCalls[0]

        child.pushStdout('partial out')
        expect(killTreeCalls).toEqual([])   // 未取消前不得动刀

        schedulerManager.stop('sched-abort')

        // 根进程此时仍存活（close 尚未派发）：树杀必须发生在这个时点
        expect(killTreeCalls).toEqual([4242])

        child.pushStderr('boom')
        child.close(1)

        await vi.waitFor(() => expect(scriptLogOf('sched-abort')).toContain('Status: FAILURE'))
        const log = scriptLogOf('sched-abort')
        expect(log).toContain('Stdout:\npartial out')
        expect(log).toContain('Stderr:\nboom')
        expect(killTreeCalls).toEqual([4242])   // 结算后不补刀
    })

    it('取消且 stderr 为空 → AbortError 原文（与改造前 exec 的取消文案一致）', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 'sched-silent'}))

        fireTask({scheduleId: 'sched-silent'})
        await vi.waitFor(() => expect(spawnCalls).toHaveLength(1))
        const {child} = spawnCalls[0]

        schedulerManager.stop('sched-silent')
        child.close(null)

        await vi.waitFor(() => expect(scriptLogOf('sched-silent')).toContain('Status: FAILURE'))
        expect(scriptLogOf('sched-silent')).toContain('The operation was aborted')
    })

    it('非 0 退出且 stderr 为空 → Command failed: <命令>（与改造前一致）', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 'sched-fail'}))

        fireTask({scheduleId: 'sched-fail'})
        await vi.waitFor(() => expect(spawnCalls).toHaveLength(1))
        const {child} = spawnCalls[0]

        child.close(1)

        await vi.waitFor(() => expect(scriptLogOf('sched-fail')).toContain('Status: FAILURE'))
        expect(scriptLogOf('sched-fail')).toContain('Command failed: "tree.js"')
    })
})

describe('S1b — 30min 超时路径', () => {
    it('到点才树杀，结算后定时器已撤（不再重复杀）', async () => {
        vi.useFakeTimers()
        try {
            scheduleRepoStub.get.mockReturnValue(recordOf({id: 'sched-timeout'}))

            fireTask({scheduleId: 'sched-timeout'})
            await vi.advanceTimersByTimeAsync(0)
            expect(spawnCalls).toHaveLength(1)

            await vi.advanceTimersByTimeAsync(29 * 60 * 1000)
            expect(killTreeCalls).toEqual([])   // 未到 30min 不杀

            await vi.advanceTimersByTimeAsync(60 * 1000)
            expect(killTreeCalls).toEqual([4242])   // 到点树杀（此时 child 尚未 close）

            spawnCalls[0].child.close(null)
            await vi.advanceTimersByTimeAsync(60 * 1000)
            expect(killTreeCalls).toEqual([4242])   // 结算后不再补刀

            expect(scriptLogOf('sched-timeout')).toContain('Status: FAILURE')
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('S1b — 多字节字符跨 pipe chunk 边界（流式解码）', () => {
    /**
     * 真实管道会把一次输出切成任意字节长度的 chunk，汉字（UTF-8 三字节）被劈开是常态。
     * 逐 chunk 调 Buffer.toString() 会把半截序列各自解成 U+FFFD，且不可逆——必须按流
     * 各持一个 StringDecoder，把半个字符的余量留到下一 chunk（或结算前的 end()）。
     */
    const runScriptOf = () => (schedulerManager as unknown as ManagerInternals).runScript

    it('stdout 在汉字中间被劈开：脚本日志与 output 都不出现 U+FFFD，文本逐字正确', async () => {
        const bytes = Buffer.from('中文输出')
        const pending = runScriptOf().call(
            schedulerManager, 'sched-cjk-out', 'tree.js', [], Date.now(), new AbortController().signal)
        await vi.waitFor(() => expect(spawnCalls).toHaveLength(1))
        const {child} = spawnCalls[0]

        // 边界取 4：落在「文」的三个字节（3..5）中间
        child.pushStdoutRaw(bytes.subarray(0, 4))
        child.pushStdoutRaw(bytes.subarray(4))
        child.close(0)

        const result = await pending
        expect(result.success).toBe(true)
        expect(result.output).toBe('中文输出')
        expect(result.output).not.toContain('\uFFFD')
        const log = scriptLogOf('sched-cjk-out')
        expect(log).toContain('Stdout:\n中文输出')
        expect(log).not.toContain('\uFFFD')
    })

    it('stderr 在汉字中间被劈开：失败文案同样逐字正确', async () => {
        const bytes = Buffer.from('中文错误')
        const pending = runScriptOf().call(
            schedulerManager, 'sched-cjk-err', 'tree.js', [], Date.now(), new AbortController().signal)
        await vi.waitFor(() => expect(spawnCalls).toHaveLength(1))
        const {child} = spawnCalls[0]

        child.pushStdoutRaw(Buffer.from('out:'))
        child.pushStderrRaw(bytes.subarray(0, 4))
        child.pushStderrRaw(bytes.subarray(4))
        child.close(1)

        const result = await pending
        expect(result.success).toBe(false)
        expect(result.error).toBe('中文错误')
        const log = scriptLogOf('sched-cjk-err')
        expect(log).toContain('Stderr:\n中文错误')
        expect(log).not.toContain('\uFFFD')
    })
})
