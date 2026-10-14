/**
 * agentTool 待办同步提示测试
 *
 * 背景：待办进度更新此前完全依赖 LLM 记忆；现由系统在子任务收尾时按结果追加提示。
 * 触发条件：父会话存在活跃批次（含未完成任务）。无待办会话零噪声。
 *
 * mock 面：agentLoop / agentRegistry / runtimeConfigManager / settings / repo / usageRepo / taskStore。
 * 形状对齐 tests/main/agent/tools/builtin/agentTool.truncation.test.ts（agentLoop 为异步生成器，
 * getPrimaryProvider 返回 {isValid, provider, modelName}，scheme 角色用 modelId）。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => ({
    agentLoop: vi.fn(),
    findAgent: vi.fn(),
    getScheme: vi.fn(),
    getProviders: vi.fn(),
    getOverride: vi.fn(),
    setOverride: vi.fn(),
    getPrimaryProvider: vi.fn(),
    getConfig: vi.fn(),
    getWorkingDir: vi.fn(() => ''),
    getJson: vi.fn(),
    setWorkingDir: vi.fn(),
    createRepo: vi.fn(),
    recordUsage: vi.fn(),
    getActiveBatch: vi.fn(),
}))

vi.mock('worker_threads', () => ({parentPort: null}))

vi.mock('../../../../../src/main/agent/loop', () => ({
    agentLoop: mocks.agentLoop,
}))

vi.mock('../../../../../src/main/agent/agentRegistry', () => ({
    agentRegistry: {
        find: mocks.findAgent,
        getEnabled: vi.fn(() => []),
    },
}))

vi.mock('../../../../../src/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {
        getScheme: mocks.getScheme,
        getProviders: mocks.getProviders,
        getOverride: mocks.getOverride,
        setOverride: mocks.setOverride,
        getPrimaryProvider: mocks.getPrimaryProvider,
        getConfig: mocks.getConfig,
        getWorkingDir: mocks.getWorkingDir,
    },
}))

vi.mock('../../../../../src/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {getJson: mocks.getJson},
}))

vi.mock('../../../../../src/main/agent/tools/permission', () => ({
    permissionEngine: {setWorkingDir: mocks.setWorkingDir},
}))

vi.mock('../../../../../src/main/repositories', () => ({
    createConversationRepository: mocks.createRepo,
}))

vi.mock('../../../../../src/main/repositories/sqlite/llmUsageRepository', () => ({
    llmUsageRepo: {record: mocks.recordUsage},
}))

vi.mock('../../../../../src/main/agent/tasks/taskStore', () => ({
    taskStore: {getActiveBatch: mocks.getActiveBatch},
}))

import {agentTool} from '../../../../../src/main/agent/tools/builtin/agentTool'
import {formatTodoNotice} from '../../../../../src/main/agent/tools/builtin/agentToolTools'
import {agentLoop} from '../../../../../src/main/agent/loop'

const mockAgentLoop = vi.mocked(agentLoop)

const SCHEME = {
    id: 'scheme-1',
    name: '测试方案',
    enabled: true,
    roles: [
        {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'primary-model-id'},
    ],
} as any

const PROVIDERS = [
    {id: 'p1', name: '主力服务商', type: 'openai', enabled: true,
        models: [{id: 'primary-model-id', name: 'primary-model', enabled: true}]},
] as any

function makeRepo() {
    return {create: vi.fn(), readMeta: vi.fn(() => null), writeMessages: vi.fn(() => true)}
}

/** 与 truncation 测试同构的最小上下文；细节以现有测试为准 */
function makeContext() {
    return {
        conversationId: 'conv-test',
        workingDir: '',
        abortSignal: undefined,
        sendMessage: vi.fn(),
        toolCallId: 'tc-1',
    } as any
}

describe('formatTodoNotice（纯函数）', () => {
    it('无活跃待办时返回空串（零噪声）', () => {
        expect(formatTodoNotice(false, 'success')).toBe('')
        expect(formatTodoNotice(false, 'failed')).toBe('')
        expect(formatTodoNotice(false, 'truncated')).toBe('')
    })

    it('成功文案包含工具名与 completed', () => {
        const text = formatTodoNotice(true, 'success')
        expect(text).toContain('[待办同步]')
        expect(text).toContain('task_update')
        expect(text).toContain('completed')
    })

    it('失败文案显式禁止 completed', () => {
        const text = formatTodoNotice(true, 'failed')
        expect(text).toContain('不得置为 completed')
    })

    it('截断文案显式禁止 completed', () => {
        const text = formatTodoNotice(true, 'truncated')
        expect(text).toContain('不得置为 completed')
    })
})

describe('agentTool 返回路径追加待办提示', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getPrimaryProvider.mockReturnValue({isValid: true, provider: {type: 'openai'}, modelName: 'gpt-4o'})
        mocks.findAgent.mockReturnValue({
            name: 'Implementer', enabled: true, description: '实现 agent', whenToUse: '实现',
            systemPrompt: '你是实现 agent', allowedTools: ['*'],
        })
        mocks.getScheme.mockReturnValue(SCHEME)
        mocks.getProviders.mockReturnValue(PROVIDERS)
        mocks.getOverride.mockReturnValue(null)
        mocks.getConfig.mockReturnValue({workingDir: ''})
        mocks.getJson.mockReturnValue({subagent: {maxDepth: 3, maxConcurrency: 10}, agent: {maxTurns: 100}})
        mocks.createRepo.mockReturnValue(makeRepo())
    })

    it('存在活跃批次时，成功返回的 output 末尾含待办提示', async () => {
        mocks.getActiveBatch.mockReturnValue({id: 'b1', name: '批次', status: 'active'})
        mockAgentLoop.mockImplementation(async function* () {
            yield {type: 'text', content: '子任务完成'} as any
            yield {type: 'done', reason: 'completed'} as any
        })

        const result = await agentTool.execute({agent: 'Implementer', modelRole: 'primary', task: '做个事'} as any, makeContext())

        expect(result.success).toBe(true)
        expect(String(result.output).endsWith('。')).toBe(true)
        expect(String(result.output)).toContain('[待办同步]')
        expect(String(result.output)).toContain('completed')
    })

    it('无活跃批次（null）时，output 精确等于子任务产物（无任何追加）', async () => {
        mocks.getActiveBatch.mockReturnValue(null)
        mockAgentLoop.mockImplementation(async function* () {
            yield {type: 'text', content: '子任务完成'} as any
            yield {type: 'done', reason: 'completed'} as any
        })

        const result = await agentTool.execute({task: '子任务', agent: 'Implementer', modelRole: 'primary'} as any, makeContext())

        expect(String(result.output)).toBe('子任务完成')
    })

    it('批次存在但已 completed：不加提示（判别力：去掉 status==="active" 判定必须变红）', async () => {
        mocks.getActiveBatch.mockReturnValue({id: 'b1', name: '批次', status: 'completed'})
        mockAgentLoop.mockImplementation(async function* () {
            yield {type: 'text', content: '子任务完成'} as any
            yield {type: 'done', reason: 'completed'} as any
        })

        const result = await agentTool.execute({task: '子任务', agent: 'Implementer', modelRole: 'primary'} as any, makeContext())

        expect(String(result.output)).not.toContain('[待办同步]')
    })

    it('截断路径：提示为 truncated 文案（判别力：改成 success 文案必须变红）', async () => {
        mocks.getActiveBatch.mockReturnValue({id: 'b1', name: '批次', status: 'active'})
        mockAgentLoop.mockImplementation(async function* () {
            yield {type: 'text', content: '部分成果'} as any
            yield {type: 'done', reason: 'max_turns_reached'} as any
        })

        const result = await agentTool.execute({task: '子任务', agent: 'Implementer', modelRole: 'primary'} as any, makeContext())

        expect(String(result.output)).toContain('被截断')
        expect(String(result.output)).toContain('不得置为 completed')
        expect(String(result.output)).not.toContain('请立即用 task_update 将其置为 completed')
    })

    it('失败路径：提示为 failed 文案', async () => {
        mocks.getActiveBatch.mockReturnValue({id: 'b1', name: '批次', status: 'active'})
        mockAgentLoop.mockImplementation(async function* () {
            yield {type: 'error', error: 'boom'} as any
            yield {type: 'done', reason: 'completed'} as any
        })

        const result = await agentTool.execute({task: '子任务', agent: 'Implementer', modelRole: 'primary'} as any, makeContext())

        expect(result.success).toBe(false)
        expect(String(result.output)).toContain('不得置为 completed')
        expect(String(result.output)).not.toContain('请立即用 task_update 将其置为 completed')
    })
})
