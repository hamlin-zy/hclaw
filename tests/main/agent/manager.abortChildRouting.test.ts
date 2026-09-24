/**
 * 子会话终止路由 — manager.abort 三级路由 + agentTool.abortChildSession
 *
 * 背景（缺陷）：子会话（agent 工具派生的会话）由 agentTool 在父会话 Worker
 * （或主进程）线程内以 in-process agentLoop 运行，永不入 workers 表；而 abort()
 * 原先只查 workers，取不到就直接 return → 手动终止子会话完全无效，且父会话里
 * 该 agent 工具调用因等不到子 loop 结束而永不返回（父卡片一直 running）。
 *
 * 本用例断言：
 * (a) 无 worker entry 时 abort() 仍触发本进程子会话路由（命中即止，不广播）；
 * (b) 本地未命中且存在运行中 Worker → 向所有 Worker 广播 ABORT_CHILD_SESSION；
 * (c) entry 存在时既有 abort 行为不变（abortController / ABORT 消息 / 兜底 done /
 *     立即级联），且同样走子会话路由；(c2) sendFallbackDone=false 只抑制主会话
 *     内部兜底 done，子会话路由不受其控制；
 * (d) agentTool.abortChildSession：未命中返回 false；命中返回 true 且目标子会话的
 *     loop signal（父 signal 与子 signal 的合并结果）进入 aborted 状态，父 signal
 *     不受影响；子 loop 结束后注册表清理（再次调用返回 false）。
 *
 * 环境搭建对齐 manager.injectMessage.test.ts（config 重定向 tmpdir + electron 空壳
 * + workers Map 直接注入假 worker）。abortChildSession 的真实现经 vi.importActual
 * 加载（manager 断言用同模块的桩），其重依赖按需桩化。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// ── 共享测试夹具（vi.mock 工厂被提升，须经 vi.hoisted 提供引用）──
const hoisted = vi.hoisted(() => {
    const providers = [{
        id: 'ep-1',
        type: 'openai',
        name: 'TestProvider',
        baseUrl: 'http://127.0.0.1',
        models: [{id: 'model-1', name: 'model-1'}],
    }]
    const scheme = {primary: {endpointId: 'ep-1', modelId: 'model-1', enabled: true}}
    const repoStub = {readMeta: () => null, create: vi.fn(), writeMessages: vi.fn()}
    const loopState: {started: boolean; params: Record<string, unknown> | null} = {started: false, params: null}
    const template = {
        id: 'agent-implementer',
        name: 'Implementer Agent',
        enabled: true,
        whenToUse: '',
        description: '',
        systemPrompt: '',
        disallowedTools: [],
    }
    return {providers, scheme, repoStub, loopState, template}
})

vi.mock('electron', () => ({
    BrowserWindow: class {},
    app: {getPath: () => '/tmp', isReady: () => true},
    dialog: {showErrorBox: vi.fn()},
    ipcMain: {handle: vi.fn(), on: vi.fn()},
}))

vi.mock('@/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-abort-child-routing-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))

// manager.impl 仅从此模块导入 injectChildMessage / abortChildSession，整体替换安全
vi.mock('@/main/agent/tools/builtin/agentTool', () => ({
    injectChildMessage: vi.fn(() => true),
    abortChildSession: vi.fn(() => false),
}))

// ── 以下桩供 vi.importActual 加载真实 agentTool（走 execute 的中止路径）──
vi.mock('@/main/agent/loop', () => ({
    agentLoop: (params: Record<string, unknown>) => {
        hoisted.loopState.started = true
        hoisted.loopState.params = params
        return (async function* () {
            // 先产出一个事件（模拟子 loop 已在流式输出，父上下文已收到 1 条进度），
            // 随后挂起不结算：只有外部中止（消费侧 race）能打断，且挂起点之后
            // 不应再有任何事件被消费/转发（迭代器 close 语义）
            yield {type: 'tool_start', toolCall: {id: 'child-tool-1', name: 'Read', arguments: {}}}
            await new Promise<void>(() => {})
        })()
    },
}))
vi.mock('@/main/agent/agentRegistry', () => ({
    agentRegistry: {
        find: () => hoisted.template,
        getEnabled: () => [],
        getAll: () => [],
    },
}))
vi.mock('@shared/modelSchemeHelpers', () => ({
    getRoleConfig: () => ({endpointId: 'ep-1', modelId: 'model-1'}),
    isTextRoleUsable: () => true,
    getUsableTextRoles: () => ['primary'],
}))
vi.mock('@/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {
        getScheme: () => hoisted.scheme,
        getProviders: () => hoisted.providers,
        getWorkingDir: () => '',
        setOverride: vi.fn(),
    },
}))
vi.mock('@/main/repositories', () => ({
    createConversationRepository: () => hoisted.repoStub,
    createConfigRepository: () => ({}),
    createPermissionRepository: () => ({}),
    createMessageBlockRepository: () => ({}),
}))
vi.mock('@/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {getJson: () => null},
}))
vi.mock('@/main/repositories/sqlite/llmUsageRepository', () => ({
    llmUsageRepo: {record: vi.fn()},
}))

import {AgentManager} from '@/main/agent/manager.impl'
import {abortChildSession, injectChildMessage} from '@/main/agent/tools/builtin/agentTool'
import {WORKER_MESSAGE_TYPES} from '@/main/agent/constants'
import type {BrowserWindow} from 'electron'

interface FakeWorker {
    postMessage: ReturnType<typeof vi.fn>
    terminate: ReturnType<typeof vi.fn>
}

interface FakeEntry {
    worker: FakeWorker
    abortController: AbortController
}

function makeManager(entries: Array<[string, FakeEntry]> = []) {
    const manager = new AgentManager()
    ;(manager as unknown as {
        workers: Map<string, FakeEntry>
        mainWindow: BrowserWindow | null
    }).workers = new Map(entries)
    return manager
}

const fakeWorker = (): FakeWorker => ({postMessage: vi.fn(), terminate: vi.fn()})
const fakeEntry = (): FakeEntry => ({worker: fakeWorker(), abortController: new AbortController()})

beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(injectChildMessage).mockClear().mockReturnValue(true)
    vi.mocked(abortChildSession).mockClear().mockReturnValue(false)
    hoisted.loopState.started = false
    hoisted.loopState.params = null
    hoisted.repoStub.create.mockClear()
    hoisted.repoStub.writeMessages.mockClear()
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('AgentManager.abort — 子会话路由（对称 injectMessage 三级路由）', () => {
    it('(a) 无 worker entry：仍走本进程子会话路由，命中即止（不广播）', async () => {
        vi.mocked(abortChildSession).mockReturnValue(true)
        const w = fakeWorker()
        const manager = makeManager([['conv-other', {worker: w, abortController: new AbortController()}]])

        await manager.abort('conv-child')

        expect(abortChildSession).toHaveBeenCalledWith('conv-child')
        expect(w.postMessage).not.toHaveBeenCalled()
    })

    it('(a2) 无 worker entry 且本地未命中、无其他 Worker：静默 no-op（不抛错）', async () => {
        vi.mocked(abortChildSession).mockReturnValue(false)
        const manager = makeManager()

        await expect(manager.abort('conv-child')).resolves.toBeUndefined()
        expect(abortChildSession).toHaveBeenCalledWith('conv-child')
    })

    it('(b) 本地未命中且存在运行中 Worker → 向所有 Worker 广播 ABORT_CHILD_SESSION', async () => {
        vi.mocked(abortChildSession).mockReturnValue(false)
        const e1 = fakeEntry()
        const e2 = fakeEntry()
        const manager = makeManager([['conv-a', e1], ['conv-b', e2]])

        await manager.abort('conv-child')

        for (const e of [e1, e2]) {
            expect(e.worker.postMessage).toHaveBeenCalledTimes(1)
            expect(e.worker.postMessage.mock.calls[0][0]).toEqual({
                type: WORKER_MESSAGE_TYPES.ABORT_CHILD_SESSION,
                convId: 'conv-child',
            })
        }
    })

    it('(c) entry 存在：既有 abort 行为不变（abort + ABORT + 兜底 done + 立即级联）', async () => {
        vi.mocked(abortChildSession).mockReturnValue(true)
        const entry = fakeEntry()
        const manager = makeManager([['conv-a', entry]])
        const notifySpy = vi.spyOn(manager as never as {notifyStreamListeners: (...a: unknown[]) => void}, 'notifyStreamListeners')
        const cascadeSpy = vi.spyOn(manager as never as {cascadeAbortedToDescendants: (...a: unknown[]) => void}, 'cascadeAbortedToDescendants')

        await manager.abort('conv-a')

        expect(entry.abortController.signal.aborted).toBe(true)
        expect(entry.worker.postMessage).toHaveBeenCalledTimes(1)
        expect(entry.worker.postMessage.mock.calls[0][0]).toEqual({type: WORKER_MESSAGE_TYPES.ABORT})
        expect(notifySpy).toHaveBeenCalledTimes(1)
        expect(notifySpy.mock.calls[0][1]).toMatchObject({type: 'done', reason: 'aborted'})
        expect(cascadeSpy).toHaveBeenCalledWith('conv-a')
        // 子会话路由同样执行（命中即止，未广播）
        expect(abortChildSession).toHaveBeenCalledWith('conv-a')
    })

    it('(c2) sendFallbackDone=false：只抑制主会话内部兜底 done，子会话路由不受其控制', async () => {
        vi.mocked(abortChildSession).mockReturnValue(true)
        const entry = fakeEntry()
        const manager = makeManager([['conv-a', entry]])
        const notifySpy = vi.spyOn(manager as never as {notifyStreamListeners: (...a: unknown[]) => void}, 'notifyStreamListeners')

        await manager.abort('conv-a', false)

        expect(entry.abortController.signal.aborted).toBe(true)
        expect(notifySpy).not.toHaveBeenCalled()
        expect(abortChildSession).toHaveBeenCalledWith('conv-a')
    })

    it('(d) entry 存在但本地子会话未命中 → 仍向所有 Worker 广播（无条件走子会话路由）', async () => {
        vi.mocked(abortChildSession).mockReturnValue(false)
        const entry = fakeEntry()
        const manager = makeManager([['conv-a', entry]])

        await manager.abort('conv-a')

        expect(entry.worker.postMessage.mock.calls.map((c) => (c[0] as {type: string}).type)).toEqual([
            WORKER_MESSAGE_TYPES.ABORT,
            WORKER_MESSAGE_TYPES.ABORT_CHILD_SESSION,
        ])
    })
})

describe('agentTool.abortChildSession — 命中/未命中', () => {
    /** 真实 agentTool（绕过本文件的模块桩）；其依赖已在上方桩化 */
    async function loadRealAgentTool() {
        return await vi.importActual<typeof import('@/main/agent/tools/builtin/agentTool')>('@/main/agent/tools/builtin/agentTool')
    }

    it('未命中：目标子会话不在本进程运行 → false（no-op）', async () => {
        const {abortChildSession: realAbortChildSession} = await loadRealAgentTool()
        expect(realAbortChildSession('conv-not-running')).toBe(false)
    })

    it('命中：中止子会话 → 返回 true，子 loop signal 进入 aborted，父 signal 不受影响；结束后注册表清理', async () => {
        const {agentTool: realAgentTool, abortChildSession: realAbortChildSession} = await loadRealAgentTool()
        const parentAbort = new AbortController()
        const sendMessage = vi.fn()
        const context = {
            conversationId: 'conv-parent',
            toolCallId: 'call-1',
            workingDir: '',
            abortSignal: parentAbort.signal,
            sendMessage,
        }

        const running = realAgentTool.execute(
            {task: '测试任务', agent: 'Implementer Agent', modelRole: 'primary'} as never,
            context as never,
        )

        // 等子 loop 启动（注册表 set 发生在 agentLoop 调用之前）
        await vi.waitFor(() => expect(hoisted.loopState.started).toBe(true))
        const childConvId = hoisted.repoStub.create.mock.calls[0][0] as string
        const childSignal = (hoisted.loopState.params as {abortSignal: AbortSignal}).abortSignal

        expect(childSignal.aborted).toBe(false)
        expect(parentAbort.signal.aborted).toBe(false)

        // ★ 命中：中止触发子 signal（父 signal 与子 signal 的 AbortSignal.any 合并结果）
        expect(realAbortChildSession(childConvId)).toBe(true)
        expect(childSignal.aborted).toBe(true)
        expect(parentAbort.signal.aborted).toBe(false)

        const result = await running
        expect(result).toMatchObject({success: false, output: '', error: '已中止', _meta: {childConvId}})
        // 父卡片与子会话 UI 的收尾事件
        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'subagent_done',
            taskId: childConvId,
            success: false,
            error: '已中止',
            toolCallId: 'call-1',
        }))
        // 收尾事件只发一次：中止分支与（残余）done/error 分支不得重复投递
        expect(sendMessage.mock.calls.filter((c) => (c[0] as {type?: string}).type === 'subagent_done')).toHaveLength(1)
        // 子 loop 结束后注册表清理：再次调用视为未命中
        expect(realAbortChildSession(childConvId)).toBe(false)
    })

    it('中止后不再消费残余事件：挂起点之后零外泄，收尾事件各只发一次', async () => {
        const {agentTool: realAgentTool, abortChildSession: realAbortChildSession} = await loadRealAgentTool()
        const sendMessage = vi.fn()
        const context = {
            conversationId: 'conv-parent',
            toolCallId: 'call-3',
            workingDir: '',
            abortSignal: undefined,
            sendMessage,
        }

        const running = realAgentTool.execute(
            {task: '测试任务', agent: 'Implementer Agent', modelRole: 'primary'} as never,
            context as never,
        )

        // 等夹具第一个事件（tool_start）被消费 → 父上下文恰好收到 1 条进度
        const countByType = (type: string) => sendMessage.mock.calls.filter((c) => (c[0] as {type?: string}).type === type).length
        await vi.waitFor(() => expect(countByType('subagent_progress')).toBe(1))

        const childConvId = hoisted.repoStub.create.mock.calls[0][0] as string
        expect(realAbortChildSession(childConvId)).toBe(true)

        const result = await running
        expect(result).toMatchObject({success: false, output: '', error: '已中止', _meta: {childConvId}})

        // 无事件外泄：子 loop 挂起点之后的残余事件不再被消费/转发（进度仍只有中止前那一条）
        expect(countByType('subagent_progress')).toBe(1)
        // 收尾只发一次（中止分支不与 done/error 分支叠加）
        expect(countByType('subagent_done')).toBe(1)
        // 事件总数零增长：subagent_start 1 + 中止前进度 1 + 收尾 1，多一条即为残余事件外泄
        expect(sendMessage).toHaveBeenCalledTimes(3)
    })

    it('父 signal 中止 → 合并 signal 连坐中止（父死子死零回归）', async () => {
        const {agentTool: realAgentTool} = await loadRealAgentTool()
        const parentAbort = new AbortController()
        const context = {
            conversationId: 'conv-parent',
            toolCallId: 'call-2',
            workingDir: '',
            abortSignal: parentAbort.signal,
            sendMessage: vi.fn(),
        }

        const running = realAgentTool.execute(
            {task: '测试任务', agent: 'Implementer Agent', modelRole: 'primary'} as never,
            context as never,
        )
        await vi.waitFor(() => expect(hoisted.loopState.started).toBe(true))
        const childSignal = (hoisted.loopState.params as {abortSignal: AbortSignal}).abortSignal
        expect(childSignal.aborted).toBe(false)

        // AbortSignal.any([父, 子])：父 signal 中止即合并 signal 中止（既有级联行为不变）
        parentAbort.abort()
        expect(childSignal.aborted).toBe(true)

        // 父 signal 不驱动消费侧的 race（race 监听子 controller）→ 本用例不等 execute 返回，
        // 只吞掉可能的 rejection，避免 unhandled rejection 噪声
        void running.catch(() => {})
    })
})
