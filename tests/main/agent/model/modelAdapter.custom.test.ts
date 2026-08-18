import {describe, expect, it, vi} from 'vitest'

// 仅 stub 依赖链末端的 DB 仓库（model/index → modelSelector 模块级 new SqliteProviderRepository），
// 保持聚焦：createModelAdapter 与 OpenAIAdapter 均为真实实现，不 mock。
// 这正是 llmCaller.getAdapter.test.ts 全量 mock createModelAdapter 而漏掉 C1 的对照回归测试。
vi.mock('@/main/repositories/sqlite/llmProviderRepository', () => ({
    SqliteProviderRepository: vi.fn(function () { return {getById: vi.fn()} }),
}))

import {createModelAdapter} from '@/main/agent/model'
import {OpenAIAdapter} from '@/main/agent/model/openaiAdapter'

describe('createModelAdapter — custom 类型映射（C1 回归：direct 通道崩溃修复）', () => {
    it('custom → OpenAIAdapter（真实工厂，不 mock）', () => {
        const adapter = createModelAdapter({provider: 'custom', model: 'deepseek-v3', apiKey: 'sk'})
        expect(adapter).toBeInstanceOf(OpenAIAdapter)
    })

    it('openai → OpenAIAdapter（既有路径不受影响）', () => {
        const adapter = createModelAdapter({provider: 'openai', model: 'gpt-5', apiKey: 'sk'})
        expect(adapter).toBeInstanceOf(OpenAIAdapter)
    })
})
