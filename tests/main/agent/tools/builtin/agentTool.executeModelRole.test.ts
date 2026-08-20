/**
 * agentTool.execute 模型角色接线 集成测试
 *
 * 验证三个修复点在真实 execute 链路中的接线（不 mock execute 本身）：
 * 1. 修复 A 上游：agentLoop 收到 modelRole 参数（→ selectModelForTurn 角色解析）
 * 2. 修复 B：子会话创建后 setOverride 固化 role 对应的服务商/模型（ModelSelector 显示）
 * 3. 问题 3 落库：llm_call_done → llmUsageRepo.record 收到与 role 一致的 providerName/model
 *
 * mock 面：agentLoop / agentRegistry / runtimeConfigManager / settings / repo / usageRepo；
 * childConvMessages、toLlmUsageRecord、agentTemplateToDefinition 保持真实实现。
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
import {runtimeConfigManager} from '../../../../../src/main/agent/runtimeConfigManager'
import {llmUsageRepo} from '../../../../../src/main/repositories/sqlite/llmUsageRepository'

const mockAgentLoop = vi.mocked(agentLoop)
const mockRtc = vi.mocked(runtimeConfigManager)
const mockUsage = vi.mocked(llmUsageRepo)

/** primary + lightweight 均启用配置的方案 */
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
    {id: 'p1', name: '主力服务商', type: 'openai'},
    {id: 'p2', name: '轻量服务商', type: 'custom'},
] as any

/** 捕获 agentLoop 参数的 fake repo */
function makeRepo() {
    const repo = {
        create: vi.fn(),
        readMeta: vi.fn(() => null),
        writeMessages: vi.fn(() => true),
    }
    return repo
}

let capturedParams: any

const CONTEXT = {
    conversationId: 'conv-parent',
    toolCallId: 'tool-1',
    sendMessage: vi.fn(),
    abortSignal: undefined,
} as any

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
    mocks.getJson.mockReturnValue({subagent: {maxDepth: 3, maxConcurrency: 10}, agent: {maxTurns: 100}})
    mocks.createRepo.mockReturnValue(makeRepo())
    capturedParams = undefined
    mockAgentLoop.mockImplementation(async function* (params: any) {
        capturedParams = params
        yield {type: 'done', reason: 'completed'}
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    setupDefault()
})

describe('agentTool.execute — 模型角色接线', () => {
    it('modelRole=lightweight → 固化 lightweight override 到子会话 + agentLoop 收到 modelRole', async () => {
        const result = await agentTool.execute(
            {task: '子任务', agent: 'Test Agent', modelRole: 'lightweight'},
            CONTEXT,
        )

        expect(result.success).toBe(true)

        // 修复 B：setOverride 固化 lightweight 角色对应的服务商/模型
        expect(mockRtc.setOverride).toHaveBeenCalledTimes(1)
        const [targetConv, ov] = mockRtc.setOverride.mock.calls[0] as [string, any]
        expect(targetConv).toMatch(/^conv-/)
        expect(ov).toEqual({endpointId: 'p2', modelId: 'light-model-id', providerName: '轻量服务商'})

        // 修复 A 上游：agentLoop 收到 modelRole；子会话 id 与固化 override 的目标一致
        expect(capturedParams).toBeDefined()
        expect(capturedParams.modelRole).toBe('lightweight')
        expect(capturedParams.sessionId).toBe(targetConv)
    })

    it('modelRole 未指定 + 父会话有 override → 继承父 override 固化', async () => {
        mocks.getOverride.mockReturnValue({endpointId: 'p9', modelId: 'parent-model', providerName: '父服务商'})

        await agentTool.execute({task: '子任务', agent: 'Test Agent'}, CONTEXT)

        expect(mockRtc.setOverride).toHaveBeenCalledTimes(1)
        const [targetConv, ov] = mockRtc.setOverride.mock.calls[0] as [string, any]
        expect(targetConv).toMatch(/^conv-/)
        expect(ov).toEqual({endpointId: 'p9', modelId: 'parent-model', providerName: '父服务商'})
        expect(capturedParams.modelRole).toBeUndefined()
    })

    it('modelRole 未指定 + 无父 override → 不固化（默认 primary，ModelSelector 显示 primary 与实际一致）', async () => {
        await agentTool.execute({task: '子任务', agent: 'Test Agent'}, CONTEXT)

        expect(mockRtc.setOverride).not.toHaveBeenCalled()
        expect(capturedParams.modelRole).toBeUndefined()
    })

    it('llm_call_done → llm_usage 落库与 role 一致的服务商/模型（问题 3 落库路径）', async () => {
        mockAgentLoop.mockImplementation(async function* () {
            yield {
                type: 'llm_call_done',
                conversationTitle: 'child',
                provider: 'custom',
                providerType: 'custom',
                providerName: '轻量服务商',
                model: 'light-model',
                duration: 100,
                inputTokens: 100,
                outputTokens: 50,
            } as any
            yield {type: 'done', reason: 'completed'}
        })

        await agentTool.execute(
            {task: '子任务', agent: 'Test Agent', modelRole: 'lightweight'},
            CONTEXT,
        )

        expect(mockUsage.record).toHaveBeenCalledTimes(1)
        const record = mockUsage.record.mock.calls[0][0] as any
        expect(record.model).toBe('light-model')
        expect(record.providerName).toBe('轻量服务商')
        expect(record.providerType).toBe('custom')
        // 落库归属子会话（conversationId = 固化 override 的目标会话）
        const [targetConv] = mockRtc.setOverride.mock.calls[0] as [string, any]
        expect(record.conversationId).toBe(targetConv)
    })
})
