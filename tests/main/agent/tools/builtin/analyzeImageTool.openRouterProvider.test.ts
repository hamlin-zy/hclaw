/**
 * analyze_image · 辅助 LLM 出站透传 OpenRouter 固定服务商
 *
 * 需求覆盖缺口修复（m5）：任何 llm 出站（含 agent loop 内的辅助调用）在
 * 「端点=OpenRouter 且模型配置了固定服务商」时都应透传 slug。
 * 口径与 execute.ts:452 一致：空/undefined 绝不携带该键。
 */
import {describe, expect, it, vi, beforeEach} from 'vitest'

const h = vi.hoisted(() => ({
    params: [] as any[],
    cfg: {current: undefined as any},
}))

vi.mock('@/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {
        getScheme: () => ({
            id: 'scheme-1',
            name: '测试方案',
            roles: [{role: 'image_understanding', endpointId: 'p1', modelId: 'm1', enabled: true}],
        }),
        getProviders: () => [{id: 'p1', enabled: true}],
    },
}))

vi.mock('@/main/agent/model/modelSelector', () => ({
    resolveModelConfig: () => h.cfg.current,
}))

vi.mock('@/main/agent/model/index', () => ({
    createModelAdapter: () => ({
        apiStyle: 'chat',
        chat: (params: any) => {
            h.params.push(params)
            return (async function* () {
                yield {type: 'text', content: 'ok'}
            })()
        },
    }),
}))

import {analyzeImageTool} from '@/main/agent/tools/builtin/analyzeImageTool'

const ctx = {workingDir: 'E:/tmp', conversationId: 'c1'} as any
// data: URI 分支：跳过文件读取，专注透传断言
const args = {imagePath: 'data:image/png;base64,AAAA', prompt: '这是什么'}

beforeEach(() => {
    h.params.length = 0
})

describe('analyzeImageTool · OpenRouter 固定服务商透传', () => {
    it('有值 → 透传 openRouterProvider', async () => {
        h.cfg.current = {
            provider: 'openai', model: 'vl-1', apiKey: 'sk', baseUrl: 'https://openrouter.ai/api/v1',
            openRouterProvider: 'deepinfra',
        }
        const r = await analyzeImageTool.execute(args, ctx)
        expect(r.success).toBe(true)
        expect(h.params).toHaveLength(1)
        expect(h.params[0].openRouterProvider).toBe('deepinfra')
    })

    it('无值 → 不携带该键（空值绝不携带）', async () => {
        h.cfg.current = {
            provider: 'openai', model: 'vl-1', apiKey: 'sk', baseUrl: 'https://api.openai.com/v1',
        }
        const r = await analyzeImageTool.execute(args, ctx)
        expect(r.success).toBe(true)
        expect(h.params).toHaveLength(1)
        expect('openRouterProvider' in h.params[0]).toBe(false)
    })
})
