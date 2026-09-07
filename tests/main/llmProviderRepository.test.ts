import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 隔离：重定向到 os.tmpdir() 下的独立临时目录，绝不触碰真实 ~/.hclaw/data/hclaw.db
vi.mock('../../src/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-provider-runtime-params-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

import {closeDatabase, getDatabase} from '../../src/main/repositories/sqlite'
import {
    SqliteProviderRepository,
    SqliteProviderModelRepository,
    type SqlProviderModel,
} from '../../src/main/repositories/sqlite/llmProviderRepository'

let db: ReturnType<typeof getDatabase>

function makeModel(overrides: Partial<SqlProviderModel> = {}): SqlProviderModel {
    return {
        id: 'm1',
        providerId: 'p1',
        modelName: 'test-model',
        modelType: 'text',
        enabled: true,
        ...overrides,
    }
}

// 直接执行生产 migration 文件建表（002 → 043，含运行时参数列）
const MIGRATIONS_DIR = path.join(__dirname, '../../src/main/repositories/sqlite/migrations')
const MIGRATION_FILES = [
    '001_initial.sql',
    '002_expanded_schema.sql',
    '016_add_model_capabilities.sql',
    '023_drop_supports_vision.sql',
    '030_add_provider_features.sql',
    '038_drop_supports_thinking.sql',
    '042_add_provider_model_pricing.sql',
    '043_add_provider_model_runtime_params.sql',
]

beforeEach(() => {
    db = getDatabase()
    db.exec('DROP TABLE IF EXISTS provider_models')
    db.exec('DROP TABLE IF EXISTS providers')
    for (const file of MIGRATION_FILES) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'))
    }
    new SqliteProviderRepository().save({
        id: 'p1', name: 'Test Provider', type: 'openai',
        authType: 'api-key', baseUrl: '', credentials: {}, email: '',
        enabled: true, models: [],
    })
})

afterEach(() => {
    closeDatabase()
})

describe('SqliteProviderModelRepository — 运行时参数 + modelTypes 持久化', () => {
    it('运行时参数 + modelTypes 往返（含 NULL 与旧列兼容）', () => {
        const repo = new SqliteProviderModelRepository()
        repo.saveByProviderId('p1', [
            makeModel({
                id: 'm-full',
                maxContextTokens: 128_000,
                temperature: 0.6,
                maxOutputTokens: 8192,
                modelTypes: ['text', 'image'],
            }),
            makeModel({id: 'm-bare', modelName: 'bare-model'}), // 未配置 → undefined（不落 0）
        ])

        const got = repo.listByProviderId('p1')
        expect(got).toHaveLength(2)

        const full = got.find((m) => m.id === 'm-full')!
        expect(full.maxContextTokens).toBe(128_000)
        expect(full.temperature).toBe(0.6)
        expect(full.maxOutputTokens).toBe(8192)
        expect(full.modelTypes).toEqual(['text', 'image'])

        const bare = got.find((m) => m.id === 'm-bare')!
        expect(bare.maxContextTokens).toBeUndefined()
        expect(bare.temperature).toBeUndefined()
        expect(bare.maxOutputTokens).toBeUndefined()
        // model_types 未配置 → undefined（回退由消费方 modelSelector 处理）
        expect(bare.modelTypes).toBeUndefined()
    })

    it('save 更新路径：运行时参数往返一致，不丢字段', () => {
        const repo = new SqliteProviderModelRepository()
        repo.save(makeModel({temperature: 0.9, modelTypes: ['embedding']}))
        const reloaded = repo.getById('m1')!
        expect(reloaded.temperature).toBe(0.9)
        repo.save(reloaded)
        const again = repo.getById('m1')!
        expect(again.temperature).toBe(0.9)
        expect(again.modelTypes).toEqual(['embedding'])
    })

    it('写入仅写新列：model_types 落库为 JSON 串，model_type 保持原值', () => {
        const repo = new SqliteProviderModelRepository()
        repo.save(makeModel({modelType: 'text', modelTypes: ['text', 'image']}))
        const raw = db.prepare("SELECT model_type, model_types FROM provider_models WHERE id = 'm1'").get() as {
            model_type: string
            model_types: string
        }
        expect(raw.model_type).toBe('text')
        expect(JSON.parse(raw.model_types)).toEqual(['text', 'image'])
    })

    it('旧数据兼容：model_types=NULL → 读取为 undefined（回退由消费方 modelSelector 处理）', () => {
        const repo = new SqliteProviderModelRepository()
        repo.save(makeModel({id: 'm-legacy'}))
        db.prepare("UPDATE provider_models SET model_type = 'image', model_types = NULL WHERE id = 'm-legacy'").run()

        const got = repo.getById('m-legacy')!
        expect(got.modelTypes).toBeUndefined()
    })

    it('model_types 非法 JSON / 非数组 → 读取为 undefined', () => {
        const repo = new SqliteProviderModelRepository()
        repo.save(makeModel({id: 'm-bad'}))
        db.prepare("UPDATE provider_models SET model_types = '{not-json' WHERE id = 'm-bad'").run()
        expect(repo.getById('m-bad')!.modelTypes).toBeUndefined()

        db.prepare("UPDATE provider_models SET model_types = '\"text\"' WHERE id = 'm-bad'").run()
        expect(repo.getById('m-bad')!.modelTypes).toBeUndefined()
    })
})
