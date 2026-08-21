// @vitest-environment jsdom
/**
 * useWindowUsage hook 测试
 *
 * 保护：上下文窗口使用率计算。
 * - 当前生效模型名（useMemo 纯逻辑）：运行态 agentState.currentModelName 优先，
 *   空则退化 primary 角色解析
 * - contextLength 从 electronAPI.modelMetaGetWindow 异步获取
 * - pct = computeUsagePct(stats.currentInputTokens + stats.currentCacheReadTokens, contextLength)
 *
 * 数据来自 useAgentStore / useModelSchemeStore / useLLMStore，直接 setState 注入；
 * electronAPI.modelMetaGetWindow 用 vi.stubGlobal mock。
 */
import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'
import {renderHook, act} from '@testing-library/react'
import {useWindowUsage} from '../../../src/renderer/hooks/useWindowUsage'
import {useAgentStore} from '../../../src/renderer/stores/agentStore'
import {useModelSchemeStore} from '../../../src/renderer/stores/modelSchemeStore'
import {useLLMStore} from '../../../src/renderer/stores/llmStore'
import type {MessageTokenStats} from '@shared/messageTokenStats'
import type {ModelScheme} from '@shared/types'
import type {LLMProvider} from '@shared/types'

function makeStats(overrides: Partial<MessageTokenStats> = {}): MessageTokenStats {
    return {
        requestCount: 0,
        toolCallCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalDecodeMs: 0,
        totalTtftMs: 0,
        ttftCount: 0,
        currentInputTokens: 0,
        currentOutputTokens: 0,
        currentCacheReadTokens: 0,
        currentDecodeMs: 0,
        currentHasTtft: false,
        lastTimedStats: null,
        ...overrides,
    }
}

function makeScheme(id: string, role: string, endpointId: string, modelId: string): ModelScheme {
    return {
        id,
        name: id,
        roles: [{
            id: `${id}-${role}`,
            role,
            endpointId,
            modelId,
            modelType: 'text',
            enabled: true,
        }],
        enabled: true,
    }
}

function makeProvider(id: string, modelId: string, modelName: string): LLMProvider {
    return {
        id,
        name: id,
        type: 'custom',
        enabled: true,
        models: [{id: modelId, name: modelName, enabled: true}],
    }
}

/** 重置 stores 到可测试初始态 */
function resetStores() {
    // agentState.currentModelName 清空（新逻辑：运行态模型名优先，空则退化 primary 角色解析）
    useAgentStore.setState({
        agentState: {...useAgentStore.getState().agentState, currentModelName: undefined},
    })
    useModelSchemeStore.setState({schemes: [], activeSchemeId: null})
    useLLMStore.setState({providers: []})
}

describe('useWindowUsage', () => {
    beforeEach(() => {
        resetStores()
        vi.stubGlobal('electronAPI', {
            modelMetaGetWindow: vi.fn().mockResolvedValue({contextLength: 200000}),
        })
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('无方案 → contextLength 0、pct 0', async () => {
        const {result} = renderHook(() => useWindowUsage(makeStats({currentInputTokens: 1000})))

        // 异步 effect 结算后
        await act(async () => {
            await Promise.resolve()
        })

        expect(result.current.contextLength).toBe(0)
        expect(result.current.pct).toBe(0)
    })

    it('方案角色未启用 → 不查询模型名，contextLength 0', async () => {
        const scheme = makeScheme('s1', 'primary', 'ep1', 'm1')
        scheme.roles[0]!.enabled = false
        useModelSchemeStore.setState({activeSchemeId: 's1', schemes: [scheme]})
        useLLMStore.setState({providers: [makeProvider('ep1', 'm1', 'claude-3.5-sonnet')]})

        const {result} = renderHook(() => useWindowUsage(makeStats()))

        await act(async () => {
            await Promise.resolve()
        })

        expect(result.current.contextLength).toBe(0)
        expect(result.current.pct).toBe(0)
        // 未查询模型窗口
        expect((window.electronAPI as any).modelMetaGetWindow).not.toHaveBeenCalled()
    })

    it('完整链路：解析模型名 → 查询窗口 → 计算 pct', async () => {
        useModelSchemeStore.setState({
            activeSchemeId: 's1',
            schemes: [makeScheme('s1', 'primary', 'ep1', 'm1')],
        })
        useLLMStore.setState({providers: [makeProvider('ep1', 'm1', 'claude-3.5-sonnet')]})

        const stats = makeStats({currentInputTokens: 10000, currentCacheReadTokens: 5000})
        const {result} = renderHook(() => useWindowUsage(stats))

        await act(async () => {
            await Promise.resolve()
        })

        // 用人类可读模型名查询
        expect((window.electronAPI as any).modelMetaGetWindow).toHaveBeenCalledWith('claude-3.5-sonnet')
        // pct = (10000+5000)/200000 = 7.5% → 8
        expect(result.current.contextLength).toBe(200000)
        expect(result.current.pct).toBe(8)
    })

    it('运行态模型名（agentState.currentModelName）优先于 primary 角色解析', async () => {
        useModelSchemeStore.setState({
            activeSchemeId: 's1',
            schemes: [makeScheme('s1', 'primary', 'ep1', 'm1')],
        })
        useLLMStore.setState({providers: [makeProvider('ep1', 'm1', 'claude-3.5-sonnet')]})
        useAgentStore.setState({
            agentState: {...useAgentStore.getState().agentState, currentModelName: 'deepseek-v3'},
        })

        // 仅断言查询目标，无需校验返回值
        renderHook(() => useWindowUsage(makeStats({currentInputTokens: 1000})))

        await act(async () => {
            await Promise.resolve()
        })

        // 用运行态模型名查询（而非 primary 角色解析出的 claude-3.5-sonnet）
        expect((window.electronAPI as any).modelMetaGetWindow).toHaveBeenCalledWith('deepseek-v3')
    })

    it('显式 modelName 优先于运行态/primary 解析（徽章环分母 = 生效模型）', async () => {
        // 运行态模型名 ≠ 生效模型（override 场景）：显式参数直接作为查询分母，不回落 primary
        useAgentStore.setState({
            agentState: {...useAgentStore.getState().agentState, currentModelName: 'other-running'},
        })
        useModelSchemeStore.setState({
            activeSchemeId: 's1',
            schemes: [makeScheme('s1', 'primary', 'ep1', 'm1')],
        })
        useLLMStore.setState({providers: [makeProvider('ep1', 'm1', 'claude-3.5-sonnet')]})

        const stats = makeStats({currentInputTokens: 10000, currentCacheReadTokens: 5000})
        const {result} = renderHook(() => useWindowUsage(stats, 'deepseek-v3'))

        await act(async () => {
            await Promise.resolve()
        })

        // 用显式传入的生效模型名查询（而非运行态/primary 解析结果）
        expect((window.electronAPI as any).modelMetaGetWindow).toHaveBeenCalledWith('deepseek-v3')
        expect((window.electronAPI as any).modelMetaGetWindow).not.toHaveBeenCalledWith('claude-3.5-sonnet')
        expect((window.electronAPI as any).modelMetaGetWindow).not.toHaveBeenCalledWith('other-running')
        // pct = (10000+5000)/200000 = 7.5% → 8
        expect(result.current.contextLength).toBe(200000)
        expect(result.current.pct).toBe(8)
    })

    it('窗口未知（contextLength 0）→ pct 0', async () => {
        vi.stubGlobal('electronAPI', {
            modelMetaGetWindow: vi.fn().mockResolvedValue({contextLength: 0}),
        })
        useModelSchemeStore.setState({
            activeSchemeId: 's1',
            schemes: [makeScheme('s1', 'primary', 'ep1', 'm1')],
        })
        useLLMStore.setState({providers: [makeProvider('ep1', 'm1', 'm')]})

        const {result} = renderHook(() => useWindowUsage(makeStats({currentInputTokens: 1000})))

        await act(async () => {
            await Promise.resolve()
        })

        expect(result.current.contextLength).toBe(0)
        expect(result.current.pct).toBe(0)
    })

    it('超过 100% → 封顶 100', async () => {
        useModelSchemeStore.setState({
            activeSchemeId: 's1',
            schemes: [makeScheme('s1', 'primary', 'ep1', 'm1')],
        })
        useLLMStore.setState({providers: [makeProvider('ep1', 'm1', 'm')]})

        const stats = makeStats({currentInputTokens: 300000, currentCacheReadTokens: 0})
        const {result} = renderHook(() => useWindowUsage(stats))

        await act(async () => {
            await Promise.resolve()
        })

        expect(result.current.contextLength).toBe(200000)
        expect(result.current.pct).toBe(100)
    })

    it('查询失败（reject）→ contextLength 0', async () => {
        vi.stubGlobal('electronAPI', {
            modelMetaGetWindow: vi.fn().mockRejectedValue(new Error('ipc error')),
        })
        useModelSchemeStore.setState({
            activeSchemeId: 's1',
            schemes: [makeScheme('s1', 'primary', 'ep1', 'm1')],
        })
        useLLMStore.setState({providers: [makeProvider('ep1', 'm1', 'm')]})

        const {result} = renderHook(() => useWindowUsage(makeStats({currentInputTokens: 1000})))

        await act(async () => {
            await Promise.resolve()
        })

        expect(result.current.contextLength).toBe(0)
        expect(result.current.pct).toBe(0)
    })

    it('provider 缺失 → 模型名解析为空，不查询', async () => {
        useModelSchemeStore.setState({
            activeSchemeId: 's1',
            schemes: [makeScheme('s1', 'primary', 'missing-ep', 'm1')],
        })
        useLLMStore.setState({providers: []})

        const {result} = renderHook(() => useWindowUsage(makeStats({currentInputTokens: 1000})))

        await act(async () => {
            await Promise.resolve()
        })

        expect(result.current.contextLength).toBe(0)
        expect((window.electronAPI as any).modelMetaGetWindow).not.toHaveBeenCalled()
    })

    it('model 缺失（provider 存在但模型不在列表）→ 模型名解析为空', async () => {
        useModelSchemeStore.setState({
            activeSchemeId: 's1',
            schemes: [makeScheme('s1', 'primary', 'ep1', 'missing-model')],
        })
        useLLMStore.setState({providers: [makeProvider('ep1', 'other-model', 'other')]})

        const {result} = renderHook(() => useWindowUsage(makeStats({currentInputTokens: 1000})))

        await act(async () => {
            await Promise.resolve()
        })

        expect(result.current.contextLength).toBe(0)
        expect((window.electronAPI as any).modelMetaGetWindow).not.toHaveBeenCalled()
    })
})
