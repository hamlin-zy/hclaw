/**
 * ★ 手动终止级联护栏：abort() 必须立即清掉子孙会话的 UI 运行态
 *
 * 背景（缺陷）：子会话 agentLoop 与父 Worker 同线程 in-process 运行（agentTool.ts:447），
 * 父会话 abort → 1s 优雅窗口 → worker.terminate() 后子会话物理必死；但 UI 侧
 * convAgentStates[child].agentState 是纯内存状态，唯一清除信号是 cleanup() 级联发出的
 * done(aborted)（manager.impl.ts cleanup → forwardToRenderer 全窗口广播）。
 * 而 cleanup 挂在带身份守卫的 setTimeout 上：abort 后 1s 内 start() 接管新 worker
 * → latestEntry.worker !== entry.worker → cleanup 不执行 → 子孙的 done(aborted)
 * 永不发出 → 侧边栏子会话永久卡「运行中」。
 *
 * 本用例断言（方案 A）：
 * (a) abort() 返回后【立即】（不推进 1s 窗口）即向 parentToChildren 子孙广播 done(aborted)；
 * (b) 主根因路径：abort 后 1s 内新 worker 接管（复刻 start() 语义）、身份守卫拦截 cleanup，
 *     推进窗口后子孙仍必须已收到 done(aborted)；
 * (c) 多级级联：孙会话同样收到。
 *
 * 环境搭建对齐 manager.abortFinalize.test.ts：config 重定向 tmpdir + electron 空壳
 * + 内存 sqlite（真实 schema 子集）+ workers Map 直接注入假 worker；
 * 与既有测试的差异：electron 空壳的 BrowserWindow.getAllWindows 返回一个可断言的假窗口，
 * 以观测 forwardToRenderer → webContents.send('agent-stream', {conversationId, event})。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// ── 可观测假窗口：vi.mock 工厂被提升，须经 vi.hoisted 提供引用 ──
const {testWindows} = vi.hoisted(() => {
    interface FakeWindow {
        isDestroyed: () => boolean
        webContents: {send: ReturnType<typeof vi.fn>}
    }
    return {testWindows: [] as FakeWindow[]}
})

// ── 隔离：config 重定向到独立临时目录 ──
vi.mock('@/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-abort-cascade-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))

// ── electron 空壳（getAllWindows 返回可断言假窗口）──
vi.mock('electron', () => ({
    BrowserWindow: {getAllWindows: () => testWindows},
    app: {getPath: () => '/tmp', isReady: () => true},
    dialog: {showErrorBox: vi.fn()},
    ipcMain: {handle: vi.fn(), on: vi.fn()},
}))

import {AgentManager} from '@/main/agent/manager.impl'
import {WORKER_GRACEFUL_SHUTDOWN_MS} from '@/main/agent/manager.constants'
import {getConversationPersistence} from '@/main/persistence/conversationPersistence'
import {closeDatabase, getDatabase} from '@/main/repositories/sqlite'

const CONV = 'conv-abort-cascade'        // 主会话
const CHILD = 'conv-child-1'             // 一级子会话
const CHILD2 = 'conv-child-2'
const GRANDCHILD = 'conv-grandchild-1'   // 二级孙会话

let manager: AgentManager
let db: ReturnType<typeof getDatabase>
let persistence: ReturnType<typeof getConversationPersistence>

function seedSchema(): void {
    db.exec(`CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
        timestamp INTEGER NOT NULL, ended_at INTEGER, metadata TEXT, llm_stats TEXT,
        is_partial INTEGER NOT NULL DEFAULT 0
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS message_blocks (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, block_type TEXT NOT NULL,
        content TEXT, data TEXT, sequence INTEGER NOT NULL, timestamp INTEGER NOT NULL, ended_at INTEGER, turn_index INTEGER
    )`)
}

function resetPersistenceState(): void {
    const st: Map<string, {timer: ReturnType<typeof setTimeout> | null}> = (persistence as any).states
    for (const s of st.values()) if (s.timer) clearTimeout(s.timer)
    st.clear()
    ;(persistence as any).listeners.clear()
}

interface FakeWorker { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }
function makeWorker(): FakeWorker {
    return {postMessage: vi.fn(), terminate: vi.fn()}
}
function injectWorker(convId: string, worker: FakeWorker): void {
    const map = (manager as unknown as {workers: Map<string, unknown>}).workers
    map.set(convId, {worker, abortController: new AbortController()})
}
function registerChild(parentId: string, childId: string): void {
    const map = (manager as unknown as {parentToChildren: Map<string, Set<string>>}).parentToChildren
    if (!map.has(parentId)) map.set(parentId, new Set())
    map.get(parentId)!.add(childId)
}

/** 收集经真实 forwardToRenderer 发到 agent-stream 的载荷 */
function sentPayloads(): Array<{conversationId: string; event: {type: string; reason?: string}}> {
    return testWindows[0].webContents.send.mock.calls
        .filter(([ch]: unknown[]) => ch === 'agent-stream')
        .map(([, payload]: unknown[]) => payload as {conversationId: string; event: {type: string; reason?: string}})
}
function countDoneAborted(convId: string): number {
    return sentPayloads().filter(p =>
        p.conversationId === convId && p.event.type === 'done' && p.event.reason === 'aborted').length
}
function doneAbortedFor(convId: string): boolean {
    return countDoneAborted(convId) > 0
}
function childMap(): Map<string, Set<string>> {
    return (manager as unknown as {parentToChildren: Map<string, Set<string>>}).parentToChildren
}

async function advanceGracefulWindow(): Promise<void> {
    await vi.advanceTimersByTimeAsync(WORKER_GRACEFUL_SHUTDOWN_MS)
    await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
    vi.useFakeTimers()
    testWindows.length = 0
    testWindows.push({isDestroyed: () => false, webContents: {send: vi.fn()}})
    manager = new AgentManager()
    db = getDatabase()
    db.exec('DROP TABLE IF EXISTS message_blocks')
    db.exec('DROP TABLE IF EXISTS messages')
    db.exec('DROP TABLE IF EXISTS conversations')
    seedSchema()
    db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(CONV, '', '{}', 1, 1)

    persistence = getConversationPersistence()
    resetPersistenceState()
})

afterEach(() => {
    resetPersistenceState()
    vi.useRealTimers()
    closeDatabase()
    vi.restoreAllMocks()
})

describe('★ abort 立即级联：子孙会话 UI 运行态必须被清除', () => {
    it('(a) abort() 返回后立即（不推进 1s 窗口）向所有一级子会话广播 done(aborted)', async () => {
        injectWorker(CONV, makeWorker())
        registerChild(CONV, CHILD)
        registerChild(CONV, CHILD2)

        await manager.abort(CONV)

        // 不推进优雅窗口：此时旧实现只发了主会话的 notifyStreamListeners 内部兜底，
        // 绝不会有任何 agent-stream 出窗 → 红灯判据
        expect(doneAbortedFor(CHILD)).toBe(true)
        expect(doneAbortedFor(CHILD2)).toBe(true)
        // 主会话自身的 done 兜底仍走内部监听器，不经 agent-stream（行为不变）
        expect(sentPayloads().some(p => p.conversationId === CONV)).toBe(false)
    })

    it('(b) 主根因路径：abort 后 1s 内新 worker 接管（身份守卫拦截 cleanup）→ 子孙仍必须已收到 done(aborted)', async () => {
        const oldWorker = makeWorker()
        injectWorker(CONV, oldWorker)
        registerChild(CONV, CHILD)

        await manager.abort(CONV)

        // 复刻 start() 接管语义（manager.impl.ts:231-233）：新 worker 替换旧 entry
        injectWorker(CONV, makeWorker())

        await advanceGracefulWindow()
        // 此时旧回调整体早退：oldWorker 不被 terminate、cleanup 不执行（见 abortFinalize.verify c1）
        expect(oldWorker.terminate).not.toHaveBeenCalled()

        // 兜底级联不能依赖 cleanup：子孙必须已拿到 done(aborted)，否则 UI 永久卡「运行中」
        expect(doneAbortedFor(CHILD)).toBe(true)
    })

    it('(c) 多级级联：孙会话同样收到 done(aborted)', async () => {
        injectWorker(CONV, makeWorker())
        registerChild(CONV, CHILD)
        registerChild(CHILD, GRANDCHILD)

        await manager.abort(CONV)

        expect(doneAbortedFor(GRANDCHILD)).toBe(true)
    })

    it('(G1) 正常路径（无接管）：cleanup 到期兜底【重发】一次 done(aborted)，并删除全部子孙映射（cleanup 重构零行为变化护栏）', async () => {
        const worker = makeWorker()
        injectWorker(CONV, worker)
        registerChild(CONV, CHILD)
        registerChild(CHILD, GRANDCHILD)

        await manager.abort(CONV)
        // 立即级联：各发一次
        expect(countDoneAborted(CHILD)).toBe(1)
        expect(countDoneAborted(GRANDCHILD)).toBe(1)

        // 优雅窗口到期、身份未变 → cleanup 正常执行
        await advanceGracefulWindow()
        expect(worker.terminate).toHaveBeenCalledTimes(1)

        // 兜底重发（窗口内迟到事件可能复活 UI 运行态，本次为最终清除；对 UI 幂等）
        expect(countDoneAborted(CHILD)).toBe(2)
        expect(countDoneAborted(GRANDCHILD)).toBe(2)

        // ★ 映射清理（重构时 delete 被留在 cleanup 外层，弄丢 = 内存泄漏 + 每次 abort 重发已死子会话）
        expect(childMap().has(CONV)).toBe(false)
        expect(childMap().has(CHILD)).toBe(false)
        expect(childMap().size).toBe(0)
    })

    it('(G2) sendFallbackDone=false（start() 内部 abort）：子孙仍无条件立即级联——该参数只抑制主会话内部兜底', async () => {
        injectWorker(CONV, makeWorker())
        registerChild(CONV, CHILD)

        // start() 接管旧 worker 前走 abort(id, false)：旧子孙运行态同样已死、同样需要清除
        await manager.abort(CONV, false)

        expect(doneAbortedFor(CHILD)).toBe(true)
        // 主会话自身仍不经 agent-stream（sendFallbackDone 只控制 notifyStreamListeners 内部通道）
        expect(sentPayloads().some(p => p.conversationId === CONV)).toBe(false)
    })
})
