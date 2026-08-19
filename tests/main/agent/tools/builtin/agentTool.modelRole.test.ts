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
