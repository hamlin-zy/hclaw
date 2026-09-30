/**
 * system_manage 工具 — 归档卷索引预算配置（memory.archiveIndex）链路测试
 *
 * ⚠️ 隔离保证：mock 掉 systemSettingsRepo，用内存 Map 承接读写，绝不触碰真实数据库。
 * 覆盖：zod 不得 strip archiveIndex（本期唯一剥键点）、顶层类别浅合并语义不回归、
 *       get_settings 展示索引预算（缺失时回落默认值）。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

// 内存 Map 实现（hoisted：vi.mock 工厂会被提升到文件顶部）
const store = vi.hoisted(() => new Map<string, string>())

vi.mock('../../../../../src/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {
        get: (key: string) => store.get(key) ?? null,
        getAll: () => Object.fromEntries(store),
        set: (key: string, value: string) => {
            store.set(key, value)
            return true
        },
        setJson: (key: string, value: unknown) => {
            store.set(key, JSON.stringify(value))
            return true
        },
    },
}))

import {systemManageTool} from '../../../../../src/main/agent/tools/builtin/systemManageTool'
import type {ToolContext} from '../../../../../src/main/agent/tools/types'

/** 按真实调用链先过 zod parse（剥键发生在这一步），再 execute */
async function run(settings: unknown) {
    const parsed = systemManageTool.inputSchema.parse({action: 'update_settings', settings})
    return systemManageTool.execute(parsed, {} as ToolContext)
}

function readSettings(): any {
    const raw = store.get('settings')
    return raw ? JSON.parse(raw) : {}
}

beforeEach(() => {
    store.clear()
})

describe('system_manage · memory.archiveIndex', () => {
    it('传 archiveIndex → zod 不 strip，落库保留 maxBytes', async () => {
        const result = await run({memory: {archiveIndex: {maxBytes: 4096}}})
        expect(result.success).toBe(true)
        expect(readSettings().memory?.archiveIndex).toBeDefined()
        expect(readSettings().memory.archiveIndex.maxBytes).toBe(4096)
    })

    it('与既有 memory.enabled 共存，三个子字段各自保留', async () => {
        const result = await run({
            memory: {enabled: false, archiveIndex: {maxBytes: 4096, summaryMaxChars: 30, recentKeep: 5}},
        })
        expect(result.success).toBe(true)
        const memory = readSettings().memory
        expect(memory.enabled).toBe(false)
        expect(memory.archiveIndex).toEqual({maxBytes: 4096, summaryMaxChars: 30, recentKeep: 5})
    })

    it('顶层类别浅合并不回归：更新 memory 不影响既有 ui.theme', async () => {
        store.set('settings', JSON.stringify({ui: {theme: 'dark'}}))
        const result = await run({memory: {archiveIndex: {maxBytes: 1024}}})
        expect(result.success).toBe(true)
        expect(readSettings().ui.theme).toBe('dark')
        expect(readSettings().memory.archiveIndex.maxBytes).toBe(1024)
    })

    it('get_settings 展示索引预算，未配置时回落默认值', async () => {
        store.set('settings', JSON.stringify({memory: {enabled: true}}))
        const result = await systemManageTool.execute(
            {action: 'get_settings'} as any,
            {} as ToolContext,
        )
        expect(result.success).toBe(true)
        expect(result.output).toContain('索引预算')
        expect(result.output).toContain('maxBytes=3072')
        expect(result.output).toContain('summaryMaxChars=20')
        expect(result.output).toContain('recentKeep=15')
    })

    it('get_settings 展示已配置的索引预算值（不回落到默认）', async () => {
        store.set('settings', JSON.stringify({memory: {enabled: true, archiveIndex: {maxBytes: 8192}}}))
        const result = await systemManageTool.execute(
            {action: 'get_settings'} as any,
            {} as ToolContext,
        )
        expect(result.success).toBe(true)
        expect(result.output).toContain('maxBytes=8192')
        // 未配置的子字段仍回落默认
        expect(result.output).toContain('summaryMaxChars=20')
    })
})
