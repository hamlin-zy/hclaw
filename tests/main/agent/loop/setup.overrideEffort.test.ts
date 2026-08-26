/**
 * setup.ts selectModelForTurn — 会话 override 分支 effort 接线单测
 *
 * 锁定：override 分支的 effort 必须经 resolveOverrideThinkingEffort 解析
 * （显式合法值 → 角色继承 → auto 兜底），并传入 resolveDirectModelConfig。
 */
import {describe, it, expect, vi} from 'vitest'
import type {ModelOverride} from '@shared/types'

// ─── runtimeConfigManager / 会话仓库 mock ────────────────────

const overrides: Record<string, ModelOverride | null> = {}
const providers = [{
    id: 'p1', name: 'ProvA', type: 'anthropic', authType: 'api-key',
    apiKey: 'k', enabled: true,
    models: [{id: 'm1', name: 'claude-1', enabled: true}],
}]

vi.mock('@/main/agent/tools/permission', () => ({permissionEngine: {}}))
vi.mock('@/main/agent/permissions/permissionRule', () => ({permissionRulesManager: {}}))
vi.mock('@/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {
        getScheme: () => null,
        getProviders: () => providers,
        getOverride: (id: string) => overrides[id] ?? null,
    },
}))
vi.mock('@/main/repositories', () => ({
    createConversationRepository: () => ({readMeta: () => null}),
}))

const {selectModelForTurn} = await import('@/main/agent/loop/setup')

const schemeConfig = {
    scheme: {id: 's1', name: 'sc', enabled: true, roles: []},
    providers,
}

function resultValue(result: any) {
    return (result as unknown as {value: any}).value
}

function pick(result: any) {
    return result.modelConfig?.thinkingEffort
}

describe('selectModelForTurn — override 分支 effort 接线', () => {
    it('override 显式合法值 xhigh → modelConfig.thinkingEffort=xhigh', () => {
        overrides['c1'] = {endpointId: 'p1', modelId: 'm1', thinkingEffort: 'xhigh'}
        const r = selectModelForTurn(schemeConfig as any, 'c1').next()
        expect(resultValue(r).directModel).toBe(true)
        expect(pick(resultValue(r))).toBe('xhigh')
    })

    it('override 非法值 turbo → 不透传，走 auto 兜底', () => {
        overrides['c2'] = {endpointId: 'p1', modelId: 'm1', thinkingEffort: 'turbo'} as unknown as ModelOverride
        const r = selectModelForTurn(schemeConfig as any, 'c2').next()
        expect(resultValue(r).directModel).toBe(true)
        expect(pick(resultValue(r))).toBe('auto')
        expect(pick(resultValue(r))).not.toBe('turbo')
    })

    it('无 effort 字段 → 视为未配置，不预置 effort', () => {
        overrides['c3'] = {endpointId: 'p1', modelId: 'm1'}
        const r = selectModelForTurn(schemeConfig as any, 'c3').next()
        expect(resultValue(r).directModel).toBe(true)
        expect(pick(resultValue(r))).toBe('auto')
    })
})
