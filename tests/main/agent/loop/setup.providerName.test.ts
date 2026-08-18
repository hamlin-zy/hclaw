/**
 * selectModelForTurn 返回 providerName 单元测试
 *
 * 覆盖需求：InputArea 下方提示信息改为「{服务商名称}/{模型名称}运行中」
 * agent_start 事件链路中 providerName 的来源是 selectModelForTurn 的返回值，
 * 该值取自已解析的 ModelConfig._providerName（providers.name 人类可读名）。
 *
 * Mock 策略：
 * - runtimeConfigManager 是真实单例，通过公开静态方法
 *   initialize/updateScheme 注入测试 scheme/providers；
 *   configBridge 由 initialize 注册，getCurrentSchemeInfo 走真实链路，无需 mock。
 * - setup.ts 顶层还 import 了 permissionEngine / toolRegistry 等模块，
 *   但 selectModelForTurn 不触碰它们，仅 import 链存在即可。
 */
import {beforeEach, describe, expect, it} from 'vitest'
import type {LLMProvider, ModelRole, ModelScheme, ModelSchemeRole} from '@shared/types'
import type {TurnModelSelection} from '@/main/agent/loop/types'
import {runtimeConfigManager} from '@/main/agent/runtimeConfigManager'
import {selectModelForTurn} from '@/main/agent/loop/setup'

// ─── 测试数据 ───────────────────────────────────────────────

const PROVIDERS: LLMProvider[] = [
    {
        id: 'prov-openrouter',
        name: 'OpenRouter',
        type: 'custom',
        enabled: true,
        apiKey: 'sk-test',
        models: [{id: 'deepseek-v3', name: 'deepseek-v3', enabled: true}],
    },
    {
        id: 'prov-ollama',
        name: 'Ollama',
        type: 'ollama',
        enabled: true,
        apiKey: '',
        models: [{id: 'qwen3', name: 'qwen3:8b', enabled: true}],
    },
]

function makeScheme(roles: Array<Partial<ModelSchemeRole> & {role: string}>): ModelScheme {
    return {
        id: 'scheme-1',
        name: 'test-scheme',
        enabled: true,
        roles: roles.map(r => ({
            id: `id-${r.role}`,
            modelType: 'text',
            enabled: true,
            endpointId: '',
            modelId: '',
            ...r,
        })),
    }
}

const SCHEME = makeScheme([
    {role: 'primary', endpointId: 'prov-openrouter', modelId: 'deepseek-v3'},
    {role: 'lightweight', endpointId: 'prov-ollama', modelId: 'qwen3'},
])

// ─── 辅助函数 ───────────────────────────────────────────────

/** 迭代 selectModelForTurn 至完成，返回 TurnModelSelection（正常路径不 yield 事件） */
async function runSelectModelForTurn(
    analysis: {suggestedModel: ModelRole; complexity: string},
    schemeConfig?: {scheme: ModelScheme; providers: LLMProvider[]},
): Promise<TurnModelSelection> {
    const gen = selectModelForTurn(analysis, schemeConfig)
    const first = (await gen.next()).value
    // 仅模型 fallback 时会 yield warning 事件，需继续迭代取最终返回值
    if (first && typeof first === 'object' && 'type' in first) {
        return (await gen.next()).value as TurnModelSelection
    }
    return first as TurnModelSelection
}

// ─── 用例 ───────────────────────────────────────────────────

describe('selectModelForTurn 返回 providerName（服务商人类可读名）', () => {
    beforeEach(() => {
        // 重置单例状态并注入测试 scheme/providers
        runtimeConfigManager.initialize()
        runtimeConfigManager.updateScheme('scheme-1', SCHEME, PROVIDERS)
    })

    it('返回 providers.name 作为 providerName', async () => {
        const selection = await runSelectModelForTurn(
            {suggestedModel: 'primary', complexity: 'simple'},
        )
        expect(selection.providerName).toBe('OpenRouter')
        expect(selection.modelConfig._providerName).toBe('OpenRouter')
        expect(selection.modelConfig.provider).toBe('custom')
    })

    it('schemeConfig 分支同样携带 providerName', async () => {
        const selection = await runSelectModelForTurn(
            {suggestedModel: 'primary', complexity: 'moderate'},
            {scheme: SCHEME, providers: PROVIDERS},
        )
        expect(selection.providerName).toBe('OpenRouter')
    })

    it('provider.name 为空时回退到 provider.id', async () => {
        const providersNoName: LLMProvider[] = [{...PROVIDERS[0], name: ''}]
        runtimeConfigManager.updateScheme('scheme-1', SCHEME, providersNoName)

        const selection = await runSelectModelForTurn(
            {suggestedModel: 'primary', complexity: 'simple'},
        )
        expect(selection.providerName).toBe('prov-openrouter')
    })
})
