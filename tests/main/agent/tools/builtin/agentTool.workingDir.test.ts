/**
 * agentTool.execute — 子 Agent workingDir 取值优先级锁定
 *
 * 目标行：src/main/agent/tools/builtin/agentTool.ts:442
 *   const workingDir = workspacePath || runtimeConfigManager.getWorkingDir() || ''
 * 其中 workspacePath 来自父会话 meta.workspacePath（line 315-319 继承值）。
 *
 * 断言锁定「会话绑定优先」语义：
 *   1. 父会话 meta.workspacePath 非空 → 优先于全局 getWorkingDir()（即便全局值不同）
 *   2. 父会话 meta.workspacePath 为空 → 回退全局 getWorkingDir()
 *   3. 两者皆空 → 传空串
 *
 * 断言落在「实际传给 agentLoop 的 params.workingDir」，而非中间变量。
 * 回归背景：旧语义 runtimeConfigManager.getConfig().workingDir || '' 会随用户
 * 切换工作区被改写，导致子 Agent 工具落在错误目录、子会话 meta 与实际执行目录不一致。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => ({
    agentLoop: vi.fn(),
    findAgent: vi.fn(),
    getEnabled: vi.fn(),
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
}))

vi.mock('worker_threads', () => ({parentPort: null}))

vi.mock('../../../../../src/main/agent/loop', () => ({
    agentLoop: mocks.agentLoop,
}))

vi.mock('../../../../../src/main/agent/agentRegistry', () => ({
    agentRegistry: {
        find: mocks.findAgent,
        getEnabled: mocks.getEnabled,
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

import {agentTool} from '../../../../../src/main/agent/tools/builtin/agentTool'
import {agentLoop} from '../../../../../src/main/agent/loop'

const mockAgentLoop = vi.mocked(agentLoop)

/** primary + lightweight 均启用的方案 */
const SCHEME = {
    id: 'scheme-1',
    name: '测试方案',
    enabled: true,
    roles: [
        {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'primary-model-id'},
        {role: 'lightweight', enabled: true, endpointId: 'p2', modelId: 'light-model-id'},
    ],
} as any

const PROVIDERS = [
    {id: 'p1', name: '主力服务商', type: 'openai', enabled: true,
        models: [{id: 'primary-model-id', name: 'primary-model', enabled: true}]},
    {id: 'p2', name: '轻量服务商', type: 'custom', enabled: true,
        models: [{id: 'light-model-id', name: 'light-model', enabled: true}]},
] as any

function makeRepo(readMeta: (id: string) => any) {
    return {
        create: vi.fn(),
        readMeta: vi.fn(readMeta),
        writeMessages: vi.fn(() => true),
    }
}

const CONTEXT = {
    conversationId: 'conv-parent',
    toolCallId: 'tool-1',
    sendMessage: vi.fn(),
    abortSignal: undefined,
} as any

/** 捕获 agentLoop 入参后立即结束流 */
function captureAgentLoopParams() {
    let captured: any
    mockAgentLoop.mockImplementation(async function* (params: any) {
        captured = params
        yield {type: 'done', reason: 'completed'} as any
    })
    return () => captured
}

function setupDefault() {
    mocks.getPrimaryProvider.mockReturnValue({isValid: true, provider: {type: 'openai'}, modelName: 'gpt-4o'})
    mocks.findAgent.mockReturnValue({
        name: 'Test Agent',
        enabled: true,
        description: '测试 agent',
        whenToUse: '测试',
        systemPrompt: '你是测试 agent',
        allowedTools: ['*'],
    })
    mocks.getEnabled.mockReturnValue([])
    mocks.getScheme.mockReturnValue(SCHEME)
    mocks.getProviders.mockReturnValue(PROVIDERS)
    mocks.getOverride.mockReturnValue(null)
    mocks.getConfig.mockReturnValue({workingDir: ''})
    mocks.getWorkingDir.mockReturnValue('')
    mocks.getJson.mockReturnValue({subagent: {maxDepth: 3, maxConcurrency: 10}, agent: {maxTurns: 100}})
    mocks.createRepo.mockReturnValue(makeRepo(() => null))
}

beforeEach(() => {
    vi.clearAllMocks()
    setupDefault()
})

describe('agentTool.execute — workingDir 取值优先级（会话绑定优先）', () => {
    it('父会话 meta.workspacePath 非空且全局 getWorkingDir() 不同 → 传父会话 workspacePath', async () => {
        mocks.createRepo.mockReturnValue(makeRepo(() => ({workspacePath: 'C:\\parent-workspace'})))
        mocks.getWorkingDir.mockReturnValue('C:\\global-workspace')
        const getCaptured = captureAgentLoopParams()

        const result = await agentTool.execute(
            {task: '子任务', agent: 'Test Agent', modelRole: 'lightweight'},
            CONTEXT,
        )

        expect(result.success).toBe(true)
        const params = getCaptured()
        expect(params).toBeDefined()
        expect(params.workingDir).toBe('C:\\parent-workspace')
        // 反证：绝非全局值
        expect(params.workingDir).not.toBe('C:\\global-workspace')
    })

    it('父会话 meta.workspacePath 为空 → 回退全局 getWorkingDir()', async () => {
        mocks.createRepo.mockReturnValue(makeRepo(() => ({workspacePath: ''})))
        mocks.getWorkingDir.mockReturnValue('C:\\global-workspace')
        const getCaptured = captureAgentLoopParams()

        const result = await agentTool.execute(
            {task: '子任务', agent: 'Test Agent', modelRole: 'lightweight'},
            CONTEXT,
        )

        expect(result.success).toBe(true)
        const params = getCaptured()
        expect(params).toBeDefined()
        expect(params.workingDir).toBe('C:\\global-workspace')
    })

    it('父会话 meta 缺失且全局 getWorkingDir() 为空 → 传空串', async () => {
        mocks.createRepo.mockReturnValue(makeRepo(() => null))
        mocks.getWorkingDir.mockReturnValue('')
        const getCaptured = captureAgentLoopParams()

        const result = await agentTool.execute(
            {task: '子任务', agent: 'Test Agent', modelRole: 'lightweight'},
            CONTEXT,
        )

        expect(result.success).toBe(true)
        const params = getCaptured()
        expect(params).toBeDefined()
        expect(params.workingDir).toBe('')
    })
})
