/**
 * agentTool 截断终态回归测试
 *
 * 背景：子 Agent 跑满 maxTurns（done reason 'max_turns_reached'）或触发循环检测
 * （'loop_detected'）被截断时，agentTool 此前一律 success:true 上报父级（谎报成功）。
 * 现改为：success=false（未完成）、error 明确「子任务未完成」、output 保留部分成果；
 * 同时 subagent_done 事件携带 truncated=true，供渲染端展示为「已完成但有告警」的中间态
 * 而非红色 error。
 *
 * mock 面：agentLoop / agentRegistry / runtimeConfigManager / settings / repo / usageRepo。
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

function makeRepo() {
    return {create: vi.fn(), readMeta: vi.fn(() => null), writeMessages: vi.fn(() => true)}
}

const CONTEXT = {
    conversationId: 'conv-parent',
    toolCallId: 'tool-1',
    sendMessage: vi.fn(),
    abortSignal: undefined,
} as any

function setupDefault() {
    mocks.getPrimaryProvider.mockReturnValue({isValid: true, provider: {type: 'openai'}, modelName: 'gpt-4o'})
    mocks.findAgent.mockReturnValue({
        name: 'Test Agent', enabled: true, description: '测试 agent', whenToUse: '测试',
        systemPrompt: '你是测试 agent', allowedTools: ['*'],
    })
    mocks.getScheme.mockReturnValue(SCHEME)
    mocks.getProviders.mockReturnValue(PROVIDERS)
    mocks.getOverride.mockReturnValue(null)
    mocks.getConfig.mockReturnValue({workingDir: ''})
    mocks.getJson.mockReturnValue({subagent: {maxDepth: 3, maxConcurrency: 10}, agent: {maxTurns: 100}})
    mocks.createRepo.mockReturnValue(makeRepo())
}

/** 取最后一次 subagent_done 事件载荷 */
function lastSubagentDone(): any {
    const calls = CONTEXT.sendMessage.mock.calls.map((c: any[]) => c[0]).filter((e: any) => e?.type === 'subagent_done')
    return calls[calls.length - 1]
}

beforeEach(() => {
    vi.clearAllMocks()
    setupDefault()
})

describe('agentTool 截断终态 — 不再谎报 success', () => {
    it('done reason=max_turns_reached → success=false、error 明确未完成、output 保留部分成果', async () => {
        mockAgentLoop.mockImplementation(async function* () {
            yield {type: 'text', content: '部分成果'} as any
            yield {type: 'done', reason: 'max_turns_reached', turns: 100, maxTurns: 100} as any
        })

        const result = await agentTool.execute({task: '子任务', agent: 'Test Agent', modelRole: 'lightweight'}, CONTEXT)

        expect(result.success).toBe(false)
        expect(String(result.error)).toContain('未完成')
        expect(String(result.error)).toContain('最大轮数上限')
        // 部分成果必须保留，父级需要看到
        expect(String(result.output)).toContain('部分成果')

        const done = lastSubagentDone()
        expect(done).toBeTruthy()
        expect(done.success).toBe(false)
        expect(done.truncated).toBe(true)
        expect(String(done.output)).toContain('部分成果')
    })

    it('done reason=loop_detected → success=false、error 提示重复循环被截断', async () => {
        mockAgentLoop.mockImplementation(async function* () {
            yield {type: 'text', content: '部分成果'} as any
            yield {type: 'done', reason: 'loop_detected'} as any
        })

        const result = await agentTool.execute({task: '子任务', agent: 'Test Agent', modelRole: 'lightweight'}, CONTEXT)

        expect(result.success).toBe(false)
        expect(String(result.error)).toContain('重复循环')
        expect(String(result.output)).toContain('部分成果')

        const done = lastSubagentDone()
        expect(done.success).toBe(false)
        expect(done.truncated).toBe(true)
    })

    it('done reason=completed → success=true、truncated 未置位（回归：正常完成不受影响）', async () => {
        mockAgentLoop.mockImplementation(async function* () {
            yield {type: 'text', content: '正常产出'} as any
            yield {type: 'done', reason: 'completed'} as any
        })

        const result = await agentTool.execute({task: '子任务', agent: 'Test Agent', modelRole: 'lightweight'}, CONTEXT)

        expect(result.success).toBe(true)
        expect(String(result.output)).toContain('正常产出')

        const done = lastSubagentDone()
        expect(done.success).toBe(true)
        expect(done.truncated).toBe(false)
        expect(done.error).toBeUndefined()
    })
})
