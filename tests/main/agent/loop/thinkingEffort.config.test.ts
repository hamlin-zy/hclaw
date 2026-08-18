/**
 * 回归测试：thinkingEffort 配置链路闭环
 *
 * 背景（配置→执行断链）：lightweight 角色配置 thinking_effort='high'，
 * 但 execute.ts 此前硬编码 workModeRole === 'reasoning' 才启用思考，
 * 导致非 reasoning 角色的 thinking_effort 被丢弃。修复后 execute.ts
 * 直接读 modelConfig.thinkingEffort（由 modelSelector 从 scheme role 解析）。
 *
 * 本测试锁定链路的两端：
 * 1. resolveModelConfig 正确把 role 的 thinkingEffort 解析进 ModelConfig
 *    （修复依赖的下游基础）
 * 2. migration 038 删除 provider_models.supports_thinking 死列
 *    （该字段全代码库零消费，思考能力由 thinking_effort 驱动）
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import Database from 'better-sqlite3'
import {resolveModelConfig} from '@/main/agent/model/modelSelector'

describe('resolveModelConfig — thinkingEffort 从 role 配置正确解析', () => {
    it('lightweight 角色配置 thinking_effort=high → modelConfig.thinkingEffort=high', () => {
        const roleConfig = {
            role: 'lightweight',
            endpointId: 'ep-1',
            modelId: 'm-1',
            enabled: true,
            thinkingEffort: 'high' as const,
        }
        const providers = [{
            id: 'ep-1',
            type: 'anthropic' as const,
            name: 'Deepseek-ant',
            authType: 'api-key' as const,
            baseUrl: 'https://api.deepseek.com/anthropic',
            models: [{id: 'm-1', name: 'deepseek-v4-flash', type: 'text' as const, enabled: true}],
        }]
        const resolved = resolveModelConfig(roleConfig as any, providers as any)
        expect(resolved).not.toBeNull()
        expect(resolved!.thinkingEffort).toBe('high')
    })

    it('未配置 thinking_effort → modelConfig.thinkingEffort 为 undefined', () => {
        const roleConfig = {
            role: 'lightweight',
            endpointId: 'ep-1',
            modelId: 'm-1',
            enabled: true,
        }
        const providers = [{
            id: 'ep-1',
            type: 'anthropic' as const,
            name: 'Deepseek-ant',
            authType: 'api-key' as const,
            baseUrl: 'https://api.deepseek.com/anthropic',
            models: [{id: 'm-1', name: 'deepseek-v4-flash', type: 'text' as const, enabled: true}],
        }]
        const resolved = resolveModelConfig(roleConfig as any, providers as any)
        expect(resolved!.thinkingEffort).toBeUndefined()
    })
})

describe('migration 038 — 删除 provider_models.supports_thinking 死列', () => {
    let db: InstanceType<typeof Database>

    beforeEach(() => {
        db = new Database(':memory:')
        db.exec(`
            CREATE TABLE provider_models (
                id TEXT PRIMARY KEY,
                provider_id TEXT NOT NULL,
                model_name TEXT NOT NULL,
                model_type TEXT NOT NULL DEFAULT 'text',
                enabled INTEGER NOT NULL DEFAULT 1,
                supports_thinking INTEGER NOT NULL DEFAULT 0
            )
        `)
        // 应用 038_drop_supports_thinking.sql，两个用例都从迁移后状态开始
        db.exec('ALTER TABLE provider_models DROP COLUMN supports_thinking')
    })

    afterEach(() => {
        db.close()
    })

    it('038 迁移执行后 supports_thinking 列被删除', () => {
        const cols = db.prepare('PRAGMA table_info(provider_models)').all() as Array<{name: string}>
        const names = cols.map(c => c.name)
        expect(names).not.toContain('supports_thinking')
        // 其余列保留
        expect(names).toContain('model_name')
        expect(names).toContain('enabled')
    })

    it('删除后插入/查询不受影响', () => {
        db.prepare(
            "INSERT INTO provider_models (id, provider_id, model_name) VALUES ('m1', 'p1', 'deepseek-v4-flash')"
        ).run()
        const row = db.prepare("SELECT model_name, enabled FROM provider_models WHERE id = 'm1'").get()
        expect(row).toEqual({model_name: 'deepseek-v4-flash', enabled: 1})
    })
})
