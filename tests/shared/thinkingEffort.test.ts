/**
 * 会话级思考强度解析测试
 *
 * 覆盖 resolveOverrideThinkingEffort 三条路径：
 * 1. override 显式携带 thinkingEffort → 直接使用
 * 2. 无显式值 → 方案角色匹配继承（endpointId+modelId）
 * 3. 均无 → 'auto' 兜底
 *
 * 以及 getEffortOptions 按协议动态档位、resolveDirectModelConfig 透传 thinkingEffort。
 */
import {describe, expect, it, vi} from 'vitest'
import type {LLMProvider, ModelScheme} from '@shared/types'
import type {ModelOverride} from '@shared/types'

import {getEffortOptions, resolveOverrideThinkingEffort} from '@/shared/thinkingEffort'

vi.mock('@/main/repositories/sqlite/llmProviderRepository', () => ({
    SqliteProviderRepository: vi.fn(function () {
        return {getById: vi.fn()}
    }),
}))

const {resolveChannelModelConfig, resolveDirectModelConfig} = await import(
    '@/main/agent/model/modelSelector'
)

// ─── 测试数据 ─────────────────────────────────────────────────

function makeScheme(): ModelScheme {
    return {
        id: 's1',
        name: 'scheme',
        enabled: true,
        roles: [
            {
                id: 'r1', role: 'primary', modelType: 'text', enabled: true,
                endpointId: 'prov-a', modelId: 'model-a',
                thinkingEffort: 'high' as const,
            },
            {
                id: 'r2', role: 'reasoning', modelType: 'text', enabled: true,
                endpointId: 'prov-b', modelId: 'model-b',
                // reasoning 角色未配置 thinkingEffort（undefined）
            },
        ],
    }
}

const PROVIDERS: LLMProvider[] = [
    {
        id: 'prov-a', name: 'A', type: 'anthropic', authType: 'api-key',
        apiKey: 'k', enabled: true,
        models: [{id: 'model-a', name: 'claude-a', enabled: true}],
    },
]

// ─── resolveOverrideThinkingEffort ────────────────────────────

describe('resolveOverrideThinkingEffort — 三条解析路径', () => {
    it('显式 thinkingEffort 优先于角色匹配', () => {
        const ov: ModelOverride = {endpointId: 'prov-a', modelId: 'model-a', thinkingEffort: 'low'}
        expect(resolveOverrideThinkingEffort(ov, makeScheme())).toBe('low')
    })

    it('无显式值 → 继承方案中 endpointId+modelId 匹配角色的 thinkingEffort', () => {
        const ov: ModelOverride = {endpointId: 'prov-a', modelId: 'model-a'}
        expect(resolveOverrideThinkingEffort(ov, makeScheme())).toBe('high')
    })

    it('匹配角色未配置 thinkingEffort → auto 兜底', () => {
        const ov: ModelOverride = {endpointId: 'prov-b', modelId: 'model-b'}
        expect(resolveOverrideThinkingEffort(ov, makeScheme())).toBe('auto')
    })

    it('模型不在任何角色中 → auto 兜底', () => {
        const ov: ModelOverride = {endpointId: 'prov-x', modelId: 'model-x'}
        expect(resolveOverrideThinkingEffort(ov, makeScheme())).toBe('auto')
    })

    it('无 scheme → auto 兜底', () => {
        const ov: ModelOverride = {endpointId: 'prov-a', modelId: 'model-a'}
        expect(resolveOverrideThinkingEffort(ov, null)).toBe('auto')
    })

    it('非法字符串 turbo → 视为未配置，走角色继承，不透传', () => {
        const ov = {endpointId: 'prov-a', modelId: 'model-a', thinkingEffort: 'turbo'} as unknown as ModelOverride
        expect(resolveOverrideThinkingEffort(ov, makeScheme())).toBe('high')
    })

    it('非法字符串 turbo 且无角色匹配 → auto 兜底', () => {
        const ov = {endpointId: 'prov-x', modelId: 'model-x', thinkingEffort: 'turbo'} as unknown as ModelOverride
        expect(resolveOverrideThinkingEffort(ov, makeScheme())).toBe('auto')
    })

    it('空字符串 \'\' → 视同未配置，走角色继承', () => {
        const ov = {endpointId: 'prov-a', modelId: 'model-a', thinkingEffort: ''} as unknown as ModelOverride
        expect(resolveOverrideThinkingEffort(ov, makeScheme())).toBe('high')
    })

    it('哨兵值 disabled → 显式禁用，不继承方案角色也不兜底 auto', () => {
        const ov = {endpointId: 'prov-a', modelId: 'model-a', thinkingEffort: 'disabled'} as ModelOverride
        // 方案角色 primary 是 high，但显式 disabled 必须优先
        expect(resolveOverrideThinkingEffort(ov, makeScheme())).toBe('disabled')
    })

    it('哨兵值 disabled 且无 scheme → 仍返回 disabled（不被 auto 覆盖）', () => {
        const ov = {endpointId: 'prov-x', modelId: 'model-x', thinkingEffort: 'disabled'} as ModelOverride
        expect(resolveOverrideThinkingEffort(ov, null)).toBe('disabled')
    })

    it('方案角色 thinkingEffort 为非法值 TURBO → 不透传，走 auto 兜底', () => {
        const badScheme: ModelScheme = {
            ...makeScheme(),
            roles: [
                {...makeScheme().roles[0], thinkingEffort: 'TURBO' as unknown as 'high'},
            ],
        }
        const ov: ModelOverride = {endpointId: 'prov-a', modelId: 'model-a'}
        expect(resolveOverrideThinkingEffort(ov, badScheme)).toBe('auto')
    })

    it('多角色同 endpointId+modelId 冲突 → 钉死 find-first（首个匹配角色继承优先）', () => {
        const conflictScheme: ModelScheme = {
            id: 's2',
            name: 'conflict',
            enabled: true,
            roles: [
                {id: 'r1', role: 'primary', modelType: 'text', enabled: true,
                 endpointId: 'p1', modelId: 'm1', thinkingEffort: 'low' as const},
                {id: 'r2', role: 'reasoning', modelType: 'text', enabled: true,
                 endpointId: 'p1', modelId: 'm1', thinkingEffort: 'max' as const},
            ],
        }
        const ov: ModelOverride = {endpointId: 'p1', modelId: 'm1'}
        expect(resolveOverrideThinkingEffort(ov, conflictScheme)).toBe('low')
    })
})

// ─── getEffortOptions 档位表 ──────────────────────────────────

describe('getEffortOptions — 按协议动态档位', () => {
    it('Anthropic 型：含自动（等效 high 说明）与全部五档 + auto', () => {
        const opts = getEffortOptions('anthropic')
        expect(opts.map(o => o.value)).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
        expect(opts[0].hint).toContain('等效 high')
    })

    it('OpenAI 型：同档位集合，自动说明指向适配器行为', () => {
        const opts = getEffortOptions('openai')
        expect(opts.map(o => o.value)).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
        expect(opts[0].hint).not.toContain('等效 high')
    })
})

// ─── 主进程透传链路 ───────────────────────────────────────────

describe('思考强度经 direct/channel 解析进入 ModelConfig', () => {
    it('resolveDirectModelConfig 传入 effort → modelConfig.thinkingEffort 生效', () => {
        const cfg = resolveDirectModelConfig('prov-a', 'model-a', PROVIDERS, 'xhigh')
        expect(cfg?.thinkingEffort).toBe('xhigh')
    })

    it('不传 effort → modelConfig.thinkingEffort 为 undefined（维持旧行为）', () => {
        const cfg = resolveDirectModelConfig('prov-a', 'model-a', PROVIDERS)
        expect(cfg?.thinkingEffort).toBeUndefined()
    })

    it('resolveChannelModelConfig：override 显式 effort 优先', () => {
        const cfg = resolveChannelModelConfig(
            {endpointId: 'prov-a', modelId: 'model-a', thinkingEffort: 'medium'},
            PROVIDERS,
            makeScheme(),
        )
        expect(cfg?.thinkingEffort).toBe('medium')
    })

    it('resolveChannelModelConfig：无显式 effort → 角色匹配继承 high', () => {
        const cfg = resolveChannelModelConfig({endpointId: 'prov-a', modelId: 'model-a'}, PROVIDERS, makeScheme())
        expect(cfg?.thinkingEffort).toBe('high')
    })

    it('resolveChannelModelConfig：override 为 null → undefined（auto，不预置）', () => {
        expect(resolveChannelModelConfig(null, PROVIDERS, makeScheme())).toBeUndefined()
    })
})
