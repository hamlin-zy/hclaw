/**
 * AgentManager 心跳落库 单元测试（Task 5）
 *
 * 覆盖：
 * - startHeartbeat 后 5s 心跳触发 doMergeAndPersist(isFinal=false)（is_partial=1 写入路径）
 * - hash 去重：内容不变不重复写库
 * - clearHeartbeat 停止心跳
 * - done / error 后不再有心跳写（仅 final 落库一次）
 *
 * 测试边界：AgentManager 依赖 Electron / Worker / 大量主进程模块，构造复杂，
 * 此处用 vi.mock 隔离全部外部依赖，仅验证心跳的计时行为与 doMergeAndPersist
 * 调用语义（通过 vi.spyOn 注入 mock）。startHeartbeat/clearHeartbeat 为私有方法，
 * 通过 handleStreamEvent（text 事件自动启动心跳）与 (manager as any) 间接驱动。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// ── 模块级 mock：隔离 AgentManager 的全部外部依赖 ──────────
vi.mock('electron', () => ({
    BrowserWindow: class {},
    app: {},
    ipcMain: {},
    dialog: {},
    shell: {},
    clipboard: {},
}))

/** 心跳最终调用目标：doMergeAndPersist（mock 注入，供断言） */
vi.mock('../../../src/main/agent/manager.persister', () => ({
    doMergeAndPersist: vi.fn(async () => {}),
}))

vi.mock('../../../src/main/agent/logger', () => ({
    logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn()},
}))

vi.mock('../../../src/main/agent/manager.pluginAgents', () => ({
    loadPluginAgents: vi.fn(),
}))

vi.mock('../../../src/main/agent/tools/permission', () => ({
    permissionEngine: {reloadRules: vi.fn()},
}))

vi.mock('../../../src/main/utils/llmCallLogStore', () => ({
    addLlmCallLog: vi.fn(),
}))

vi.mock('../../../src/main/utils/restart', () => ({
    gracefulRestart: vi.fn(),
}))

vi.mock('../../../src/main/plugin/hooks', () => ({
    HookExecutor: {
        getInstance: () => ({execute: vi.fn(() => Promise.resolve()), onResult: vi.fn()}),
    },
}))

vi.mock('../../../src/main/agent/capabilityManager', () => ({
    capabilityManager: {serializeForWorker: vi.fn()},
}))

vi.mock('../../../src/main/agent/mcp/mcpWorkerManager', () => ({
    mcpWorkerManager: {createAgentPort: vi.fn()},
    setAgentManagerRef: vi.fn(),
}))

vi.mock('../../../src/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {getJson: vi.fn()},
}))

vi.mock('../../../src/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {},
}))

vi.mock('../../../src/main/common/eventBus', () => ({
    eventBus: {on: vi.fn()},
    MCPThemeEvents: {TOOLS_REFRESHED: 'tools_refreshed'},
}))

vi.mock('../../../src/main/attention', () => ({
    notifyUserAttention: vi.fn(),
    stopUserAttention: vi.fn(),
}))

vi.mock('../../../src/main/repositories', () => ({
    createConversationRepository: vi.fn(() => ({
        readMessagesTail: vi.fn(() => ({messages: [], totalCount: 0})),
    })),
}))

import {AgentManager} from '../../../src/main/agent/manager.impl'
import {doMergeAndPersist} from '../../../src/main/agent/manager.persister'

const CONV = 'conv-heartbeat'
const doMerge = vi.mocked(doMergeAndPersist)

/** 通过 handleStreamEvent 驱动 text 流式事件（自动累积 pending + 启动心跳） */
async function driveText(manager: AgentManager, content: string): Promise<void> {
    await (manager as any).handleStreamEvent(CONV, {} as any, {type: 'text', content})
}

describe('AgentManager 心跳落库（Task 5）', () => {
    let manager: AgentManager

    beforeEach(() => {
        vi.useFakeTimers()
        doMerge.mockClear()
        manager = new AgentManager()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('startHeartbeat 后 5s 心跳触发 doMergeAndPersist(isFinal=false)（is_partial=1 写入路径）', async () => {
        await driveText(manager, 'hello')
        // 心跳尚未到 5s：不写库
        expect(doMerge).not.toHaveBeenCalled()

        // 5s 后心跳触发
        await vi.advanceTimersByTimeAsync(5000)
        expect(doMerge).toHaveBeenCalledTimes(1)
        const [convId, pending, isFinal] = doMerge.mock.calls[0]
        expect(convId).toBe(CONV)
        expect(pending).toMatchObject({content: 'hello', toolCalls: []})
        // isFinal=false → doMergeAndPersist 内部写 is_partial=1（未完成标记）
        expect(isFinal).toBe(false)
    })

    it('hash 去重：内容不变不重复写库', async () => {
        await driveText(manager, 'hello')
        await vi.advanceTimersByTimeAsync(5000)
        expect(doMerge).toHaveBeenCalledTimes(1)

        // 内容未变：下一个心跳周期去重跳过
        await vi.advanceTimersByTimeAsync(5000)
        expect(doMerge).toHaveBeenCalledTimes(1)

        // 内容变化：再次心跳写库
        await driveText(manager, ' world')
        await vi.advanceTimersByTimeAsync(5000)
        expect(doMerge).toHaveBeenCalledTimes(2)
        expect(doMerge.mock.calls[1][1]).toMatchObject({content: 'hello world'})
        expect(doMerge.mock.calls[1][2]).toBe(false)
    })

    it('clearHeartbeat 停止心跳', async () => {
        await driveText(manager, 'hello')
        ;(manager as any).clearHeartbeat(CONV)
        await vi.advanceTimersByTimeAsync(15000)
        expect(doMerge).not.toHaveBeenCalled()
    })

    it('done 事件后 clearHeartbeat + final 落库，不再有心跳写', async () => {
        await driveText(manager, 'hello')
        await (manager as any).handleStreamEvent(CONV, {} as any, {type: 'done', reason: 'completed'})

        // done 触发一次 final 落库（isFinal=true）
        expect(doMerge).toHaveBeenCalledTimes(1)
        expect(doMerge.mock.calls[0][2]).toBe(true)

        // 心跳已清除：后续时间片无任何写库
        await vi.advanceTimersByTimeAsync(10000)
        expect(doMerge).toHaveBeenCalledTimes(1)
    })

    it('error 事件后不再有心跳写（仅 final 落库一次）', async () => {
        await driveText(manager, 'hello')
        await (manager as any).handleStreamEvent(CONV, {} as any, {type: 'error', error: 'boom'})

        expect(doMerge).toHaveBeenCalledTimes(1)
        expect(doMerge.mock.calls[0][2]).toBe(true)

        await vi.advanceTimersByTimeAsync(10000)
        expect(doMerge).toHaveBeenCalledTimes(1)
    })
})
