/**
 * 工作目录优先级回归测试：会话绑定优先，全局仅兜底
 *
 * 背景（缺陷）：loop/setup.ts 与 loop.ts 曾写成
 *   `runtimeConfigManager.getWorkingDir() || params.workingDir`
 * 即「全局工作目录优先」。该全局值会随用户切换工作区被改写
 * （config.ts:495 runtimeConfigManager.setWorkingDir(workspace.path)），
 * 于是切换工作区后，仍在运行的旧会话（及其子 Agent）会在新目录里执行
 * bash/read/write/grep/glob（子会话 meta 记的却仍是父会话工作区）。
 *
 * 正确语义：params.workingDir（来自会话 meta.workspacePath）优先，全局仅作兜底。
 *
 * mock 面说明：agentTool / skillTool / permission / llmCaller / toolExecutor 保持真实模块
 * （mock 它们会改变模块求值顺序，触发 config ⇄ sqlite/repositories 的循环导入），
 * 权限引擎改用 spyOn 观测真实单例。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => ({
    getWorkingDir: vi.fn<() => string>(() => ''),
    getConfig: vi.fn(() => ({workingDir: ''})),
    loopRun: vi.fn(),
}))

vi.mock('@/main/repositories/sqlite/llmProviderRepository', () => ({
    SqliteProviderRepository: vi.fn(function () { return {getById: vi.fn()} }),
}))
vi.mock('@/main/repositories', () => ({
    createConversationRepository: () => ({readMeta: vi.fn(() => null), updateMeta: vi.fn()}),
    createPermissionRepository: () => ({}),
}))
vi.mock('@/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {get: vi.fn(() => null), getJson: vi.fn(() => null), set: vi.fn(), setJson: vi.fn()},
}))
vi.mock('@/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {getWorkingDir: mocks.getWorkingDir, getConfig: mocks.getConfig},
}))
vi.mock('@/main/agent/loop/controller', () => ({
    AgentLoopController: class {
        run(params: unknown): AsyncGenerator<unknown> {
            mocks.loopRun(params)
            return (async function* () { yield {type: 'done', reason: 'completed'} })()
        }
    },
}))

import {initializeRunEnvironment} from '@/main/agent/loop/setup'
import {agentLoop} from '@/main/agent/loop'
import type {ModelConfig} from '@/main/agent/model/types'
import type {RunParams} from '@/main/agent/loop/types'
import {permissionEngine} from '@/main/agent/tools/permission'

const GLOBAL_DIR = 'C:\\global-workspace'
const SESSION_DIR = 'E:\\session-workspace'

let setWorkingDirSpy: ReturnType<typeof vi.spyOn>

/** 驱动 async generator 直到结束，返回最终返回值 */
async function drain<T>(gen: AsyncGenerator<unknown, T>): Promise<T> {
    let step = await gen.next()
    while (!step.done) step = await gen.next()
    return step.value
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getWorkingDir.mockReturnValue('')
    mocks.getConfig.mockReturnValue({workingDir: ''})
    // 权限引擎保持真实单例，仅观测调用（mock 实现以断言原始值，绕过 path.resolve）
    setWorkingDirSpy = vi.spyOn(permissionEngine, 'setWorkingDir').mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('initializeRunEnvironment — workingDir 会话绑定优先', () => {
    it('全局与 params.workingDir 不一致 → 取 params.workingDir（权限引擎 + 返回值）', async () => {
        mocks.getWorkingDir.mockReturnValue(GLOBAL_DIR)

        const result = await drain(initializeRunEnvironment({workingDir: SESSION_DIR, messages: []} as unknown as RunParams))

        expect(result.workingDir).toBe(SESSION_DIR)
        expect(setWorkingDirSpy).toHaveBeenCalledWith(SESSION_DIR)
        expect(setWorkingDirSpy).not.toHaveBeenCalledWith(GLOBAL_DIR)
    })

    it('params.workingDir 为空 → 回退全局（向后兼容）', async () => {
        mocks.getWorkingDir.mockReturnValue(GLOBAL_DIR)

        const result = await drain(initializeRunEnvironment({workingDir: '', messages: []} as unknown as RunParams))

        expect(result.workingDir).toBe(GLOBAL_DIR)
        expect(setWorkingDirSpy).toHaveBeenCalledWith(GLOBAL_DIR)
    })

    it('两者皆空 → 空串（保持既有兜底语义）', async () => {
        const result = await drain(initializeRunEnvironment({workingDir: '', messages: []} as unknown as RunParams))

        expect(result.workingDir).toBe('')
    })
})

describe('agentLoop — workingDir 会话绑定优先', () => {
    it('全局与 params.workingDir 不一致 → 权限引擎设会话目录，且会话目录透传给 controller', async () => {
        mocks.getWorkingDir.mockReturnValue(GLOBAL_DIR)

        await drain(agentLoop({messages: [], modelConfig: {} as ModelConfig, workingDir: SESSION_DIR}))

        expect(setWorkingDirSpy).toHaveBeenCalledWith(SESSION_DIR)
        expect(setWorkingDirSpy).not.toHaveBeenCalledWith(GLOBAL_DIR)
        // 透传给 controller 的仍是原始会话目录（未被全局替换）
        expect((mocks.loopRun.mock.calls[0][0] as {workingDir?: string}).workingDir).toBe(SESSION_DIR)
    })

    it('params.workingDir 为空 → 回退全局（向后兼容）', async () => {
        mocks.getWorkingDir.mockReturnValue(GLOBAL_DIR)

        await drain(agentLoop({messages: [], modelConfig: {} as ModelConfig, workingDir: ''}))

        expect(setWorkingDirSpy).toHaveBeenCalledWith(GLOBAL_DIR)
    })
})
