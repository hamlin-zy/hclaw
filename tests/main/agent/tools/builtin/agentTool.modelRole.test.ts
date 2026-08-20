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

describe('agentTool modelRole 动态枚举', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('方案角色全启用 → schema 接受 primary/lightweight/reasoning', () => {
        vi.mocked(runtimeConfigManager.getScheme).mockReturnValue({
            roles: [
                {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'm1'},
                {role: 'lightweight', enabled: true, endpointId: 'p2', modelId: 'm2'},
                {role: 'reasoning', enabled: true, endpointId: 'p3', modelId: 'm3'},
            ],
        } as any)
        // setAgentToolConfig 重建 schema
        setAgentToolConfig()
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: 'lightweight'})).not.toThrow()
    })

    it('方案切换后 schema 重建（仅剩余启用角色）', () => {
        vi.mocked(runtimeConfigManager.getScheme).mockReturnValue({
            roles: [
                {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'm1'},
                {role: 'reasoning', enabled: false, endpointId: '', modelId: ''},
            ],
        } as any)
        setAgentToolConfig()
        // reasoning 已不在枚举 → 拒绝
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: 'reasoning'})).toThrow()
        // primary 仍可用
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: 'primary'})).not.toThrow()
    })

    it('modelRole 可选（缺省 undefined）', () => {
        const parsed = agentTool.inputSchema.parse({task: '搜索代码', agent: 'Explore Agent'})
        expect(parsed.modelRole).toBeUndefined()
    })

    it('非法 modelRole（image_understanding / 乱写）→ zod 拒绝', () => {
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: 'image_understanding'})).toThrow()
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent', modelRole: 'garbage'})).toThrow()
    })
})

describe('agentTool agent 候选动态枚举', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('agent 枚举只含已启用名称（禁用/cmd: 伪 Agent 不入）', () => {
        setAgentToolConfig()
        // 已启用 → 通过
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'General Agent'})).not.toThrow()
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'Implementer Agent'})).not.toThrow()
        // 已禁用 → 拒绝（禁用角色不进入候选）
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'Disabled Agent'})).toThrow()
        // cmd: 伪 Agent（命令条目）→ 拒绝
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'commit-msg'})).toThrow()
        // 列表外名称 → 拒绝
        expect(() => agentTool.inputSchema.parse({task: 'x', agent: 'Subagent (general-purpose)'})).toThrow()
    })
})
