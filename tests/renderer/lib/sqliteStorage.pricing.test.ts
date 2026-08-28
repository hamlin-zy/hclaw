/**
 * sqliteStorage — llm store pricing 字段持久化映射测试
 *
 * 覆盖（回归：pricing 曾在 setItem/getItem 映射中被丢弃，导致手填价格不落盘）：
 * - getItem('llm')：主进程返回的 model pricing → 渲染层 ProviderModel.pricing
 * - setItem('llm')：渲染层 models 含 pricing → saveByProvider 收到 pricing
 *
 * 隔离：channelStore.test.ts 同款范式 — vi.hoisted 在模块导入前注入
 * window.electronAPI，不触碰真实 IPC；schemeSync mock 掉避免拉起副作用。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'

const h = vi.hoisted(() => {
    const provider = {
        listWithModels: vi.fn(),
        saveAll: vi.fn(),
    }
    const providerModel = {
        saveByProvider: vi.fn(),
    }
    ;(globalThis as any).window = {electronAPI: {provider, providerModel}}
    return {provider, providerModel}
})

vi.mock('@/renderer/stores/schemeSync', () => ({
    refreshToolStore: vi.fn(),
    syncSchemeToBackend: vi.fn(),
}))

import {sqliteStorage} from '@/renderer/lib/sqliteStorage'

const PRICING = {input: 3e-6, output: 15e-6, cacheRead: 0.3e-6}

beforeEach(() => {
    vi.clearAllMocks()
    h.provider.saveAll.mockResolvedValue({success: true})
    h.providerModel.saveByProvider.mockResolvedValue({success: true})
})

describe('sqliteStorage llm — pricing 映射', () => {
    it('getItem：pricing 从主进程模型透传到渲染层 ProviderModel', async () => {
        h.provider.listWithModels.mockResolvedValue({
            success: true,
            data: [{
                id: 'p1', name: 'P1', type: 'openai', enabled: true,
                models: [{id: 'm1', modelName: 'test-model', modelType: 'text', enabled: true, pricing: PRICING}],
            }],
        })

        const result = await sqliteStorage.getItem('llm')
        const models = (result as any).state.providers[0].models
        expect(models[0].pricing).toEqual(PRICING)
    })

    it('setItem：saveByProvider 收到的模型参数携带 pricing（曾在此被丢弃）', async () => {
        await sqliteStorage.setItem('llm', {
            state: {
                providers: [{
                    id: 'p1', name: 'P1', type: 'openai', enabled: true,
                    models: [{id: 'm1', name: 'test-model', modelType: 'text', enabled: true, pricing: PRICING}],
                }],
            },
            version: 1,
        } as any)

        expect(h.provider.saveAll).toHaveBeenCalledTimes(1)
        expect(h.providerModel.saveByProvider).toHaveBeenCalledWith('p1', [
            expect.objectContaining({id: 'm1', modelName: 'test-model', pricing: PRICING}),
        ])
    })

    it('setItem：无 pricing 的模型映射后 pricing 为 undefined（不落值）', async () => {
        await sqliteStorage.setItem('llm', {
            state: {
                providers: [{
                    id: 'p1', name: 'P1', type: 'openai', enabled: true,
                    models: [{id: 'm1', name: 'test-model', modelType: 'text', enabled: true}],
                }],
            },
            version: 1,
        } as any)

        expect(h.providerModel.saveByProvider).toHaveBeenCalledWith('p1', [
            expect.objectContaining({id: 'm1', pricing: undefined}),
        ])
    })
})
