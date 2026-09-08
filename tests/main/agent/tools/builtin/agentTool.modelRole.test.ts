import {beforeEach, describe, expect, it, vi} from 'vitest'
import {agentTool, setAgentToolConfig} from '../../../../../src/main/agent/tools/builtin/agentTool'
import {runtimeConfigManager} from '../../../../../src/main/agent/runtimeConfigManager'

// mock runtimeConfigManager：可控方案角色
vi.mock('../../../../../src/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {
        getScheme: vi.fn(() => null),
        getProviders: vi.fn(() => []),
        getConfig: vi.fn(() => ({workingDir: ''})),
        getPrimaryProvider: vi.fn(() => ({isValid: true, provider: {type: 'openai'}, modelName: 'gpt-4o'})),
    },
}))

// mock agentRegistry：可控 agent 候选枚举（setAgentToolConfig 重建时读取）。
// getEnabled 语义 = 已启用（真实实现内部已过滤 enabled），故 disabled 条目不进返回值；
// cmd: 条目会出现在 getEnabled 结果中（真实实现仅过滤 enabled），由 agentTool 自行剔除。
vi.mock('../../../../../src/main/agent/agentRegistry', () => ({
    agentRegistry: {
        find: vi.fn((name: string) => {
            // 模拟：find 命中已禁用 agent（真实 find 不检查 enabled，execute 层校验）
            if (name === 'Disabled Agent') return {id: 'disabled', name: 'Disabled Agent', enabled: false}
            return undefined
        }),
        getEnabled: vi.fn(() => [
            {id: 'general', name: 'General Agent', enabled: true},
            {id: 'impl', name: 'Implementer Agent', enabled: true},
            {id: 'explore', name: 'Explore Agent', enabled: true},
            {id: 'cmd:commit-msg', name: 'commit-msg', enabled: true},
        ]),
    },
}))

/** 三服务商全启用的 providers（模型均 enabled） */
const PROVIDERS_ALL = [
    {id: 'p1', name: '主力服务商', type: 'openai', enabled: true, models: [{id: 'm1', name: '主力模型', enabled: true}]},
    {id: 'p2', name: '轻量服务商', type: 'custom', enabled: true, models: [{id: 'm2', name: '轻量模型', enabled: true}]},
    {id: 'p3', name: '推理服务商', type: 'openai', enabled: true, models: [{id: 'm3', name: '推理模型', enabled: true}]},
] as any

function setScheme(roles: any[]) {
    vi.mocked(runtimeConfigManager.getScheme).mockReturnValue({roles} as any)
}

describe('agentTool modelRole 动态枚举', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('方案角色全启用 → schema 接受 primary/lightweight/reasoning', () => {
        setScheme([
            {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'm1'},
            {role: 'lightweight', enabled: true, endpointId: 'p2', modelId: 'm2'},
            {role: 'reasoning', enabled: true, endpointId: 'p3', modelId: 'm3'},
        ])
        vi.mocked(runtimeConfigManager.getProviders).mockReturnValue(PROVIDERS_ALL)
        setAgentToolConfig()
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: 'lightweight'})).not.toThrow()
    })

    it('provider.enabled=false 的角色不进枚举', () => {
        setScheme([
            {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'm1'},
            {role: 'lightweight', enabled: true, endpointId: 'p2', modelId: 'm2'},
        ])
        const providers = [
            PROVIDERS_ALL[0],
            {...PROVIDERS_ALL[1], enabled: false},
        ]
        vi.mocked(runtimeConfigManager.getProviders).mockReturnValue(providers)
        setAgentToolConfig()
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: 'lightweight'})).toThrow()
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: 'primary'})).not.toThrow()
    })

    it('model.enabled=false 的角色不进枚举', () => {
        setScheme([
            {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'm1'},
            {role: 'reasoning', enabled: true, endpointId: 'p3', modelId: 'm3'},
        ])
        const providers = [
            PROVIDERS_ALL[0],
            {...PROVIDERS_ALL[2], models: [{id: 'm3', name: '推理模型', enabled: false}]},
        ]
        vi.mocked(runtimeConfigManager.getProviders).mockReturnValue(providers)
        setAgentToolConfig()
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: 'reasoning'})).toThrow()
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: 'primary'})).not.toThrow()
    })

    it('枚举随 scheme/providers 变更实时反映（getter 现算，无需重建）', () => {
        setScheme([
            {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'm1'},
        ])
        vi.mocked(runtimeConfigManager.getProviders).mockReturnValue(PROVIDERS_ALL)
        // 第一次读取：仅 primary 可用
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: 'primary'})).not.toThrow()
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: 'lightweight'})).toThrow()

        // 方案变更（新增 lightweight）→ 直接重取 schema 即感知
        setScheme([
            {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'm1'},
            {role: 'lightweight', enabled: true, endpointId: 'p2', modelId: 'm2'},
        ])
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: 'lightweight'})).not.toThrow()
    })

    it('modelRole 必传（缺失 → zod 拒绝）', () => {
        setScheme([
            {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'm1'},
        ])
        vi.mocked(runtimeConfigManager.getProviders).mockReturnValue(PROVIDERS_ALL)
        setAgentToolConfig()
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent'})).toThrow()
    })

    it('modelRole 必传（空串 → zod 拒绝）', () => {
        setScheme([
            {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'm1'},
        ])
        vi.mocked(runtimeConfigManager.getProviders).mockReturnValue(PROVIDERS_ALL)
        setAgentToolConfig()
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: ''})).toThrow()
    })

    it('非法 modelRole（image_understanding / 乱写）→ zod 拒绝', () => {
        setScheme([
            {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'm1'},
        ])
        vi.mocked(runtimeConfigManager.getProviders).mockReturnValue(PROVIDERS_ALL)
        setAgentToolConfig()
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: 'image_understanding'})).toThrow()
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: 'garbage'})).toThrow()
    })
})

describe('agentTool agent 候选（schema 放宽为 string，容错交由 find）', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('schema 不再 enum 硬约束：列表外/禁用/近义名称均通过校验（execute 层兜底）', () => {
        setAgentToolConfig()
        // 已启用 → 通过
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: 'primary'})).not.toThrow()
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'Implementer Agent', modelRole: 'primary'})).not.toThrow()
        // 回归背景：曾用 z.enum 硬约束，"Implementer"（缺 " Agent" 后缀）在 zod 层即被
        // 拒绝，execute 内 agentRegistry.find 的双向前缀容错永远无法生效 → 放宽为 string
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'Implementer', modelRole: 'primary'})).not.toThrow()
        // 禁用/未知名也放行 schema，由 execute 的 find() + 行动性报错兜底（列候选、要求重试）
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'Disabled Agent', modelRole: 'primary'})).not.toThrow()
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'Subagent (general-purpose)', modelRole: 'primary'})).not.toThrow()
    })
})
