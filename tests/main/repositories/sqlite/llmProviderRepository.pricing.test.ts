import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 隔离：重定向到 os.tmpdir() 下的独立临时目录，绝不触碰真实 ~/.hclaw/data/hclaw.db
vi.mock('../../../../src/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-provider-pricing-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

import {closeDatabase, getDatabase} from '../../../../src/main/repositories/sqlite'
import {
    SqliteProviderRepository,
    SqliteProviderModelRepository,
    type SqlProviderModel,
} from '../../../../src/main/repositories/sqlite/llmProviderRepository'
import {buildCustomPriceEntries} from '../../../../src/main/utils/customPriceEntries'

let db: ReturnType<typeof getDatabase>

const PRICING = {input: 3e-6, output: 15e-6, cacheRead: 0.3e-6, cacheWrite: 3.75e-6}

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

// 与 taskBatchRepository.test.ts 一致：直接执行生产 migration 文件建表，
// 验证 provider 相关迁移链（002 建 providers/provider_models → 016 加能力列 →
// 023/038 删能力列 → 030 加 features → 042 加 pricing）本身可运行且 schema 正确
const MIGRATIONS_DIR = path.join(__dirname, '../../../../src/main/repositories/sqlite/migrations')
const MIGRATION_FILES = [
    '001_initial.sql',
    '002_expanded_schema.sql',
    '016_add_model_capabilities.sql',
    '023_drop_supports_vision.sql',
    '030_add_provider_features.sql',
    '038_drop_supports_thinking.sql',
    '042_add_provider_model_pricing.sql',
]

beforeEach(() => {
    db = getDatabase()
    // DB 文件在同一测试文件内持久：先 DROP 两张表，保证 migration 链可重复重放
    db.exec('DROP TABLE IF EXISTS provider_models')
    db.exec('DROP TABLE IF EXISTS providers')
    for (const file of MIGRATION_FILES) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'))
    }
    // @photostructure/sqlite 不接受 undefined 绑定，字符串列显式给空值
    new SqliteProviderRepository().save({
        id: 'p1', name: 'Test Provider', type: 'openai',
        authType: 'api-key', baseUrl: '', credentials: {}, email: '',
        enabled: true, models: [],
    })
})

afterEach(() => {
    closeDatabase()
})

describe('SqliteProviderModelRepository — pricing 持久化', () => {
    it('saveByProviderId：写入 pricing，listByProviderId 读回解析后的对象', () => {
        const repo = new SqliteProviderModelRepository()
        repo.saveByProviderId('p1', [makeModel({pricing: PRICING})])

        const models = repo.listByProviderId('p1')
        expect(models).toHaveLength(1)
        expect(models[0].pricing).toEqual(PRICING)
    })

    it('无 pricing 的模型读回 pricing 为 undefined', () => {
        const repo = new SqliteProviderModelRepository()
        repo.saveByProviderId('p1', [makeModel()])

        const models = repo.listByProviderId('p1')
        expect(models[0].pricing).toBeUndefined()
    })

    it('save 更新路径：pricing 往返一致（保存 → 读回 → 再保存）', () => {
        const repo = new SqliteProviderModelRepository()
        repo.save(makeModel({pricing: PRICING}))
        expect(repo.getById('m1')?.pricing).toEqual(PRICING)

        // 读回值直接再保存（真实编辑弹窗保存链路），不丢 pricing
        const reloaded = repo.getById('m1')!
        repo.save(reloaded)
        expect(repo.getById('m1')?.pricing).toEqual(PRICING)
    })

    it('save 更新为无价：pricing 落空串，读回 undefined', () => {
        const repo = new SqliteProviderModelRepository()
        repo.save(makeModel({pricing: PRICING}))
        repo.save(makeModel()) // 同 id 覆盖为无价
        expect(repo.getById('m1')?.pricing).toBeUndefined()

        const raw = db.prepare("SELECT pricing FROM provider_models WHERE id = 'm1'").get() as {pricing: string}
        expect(raw.pricing).toBe('')
    })

    it('DB 中存储的是 JSON 串（USD/token 4 维）', () => {
        const repo = new SqliteProviderModelRepository()
        repo.save(makeModel({pricing: PRICING}))
        const raw = db.prepare("SELECT pricing FROM provider_models WHERE id = 'm1'").get() as {pricing: string}
        expect(JSON.parse(raw.pricing)).toEqual(PRICING)
    })
})

describe('buildCustomPriceEntries — 自定义价取数', () => {
    it('仅返回已配置 pricing 的模型，provider 名映射正确', () => {
        const repo = new SqliteProviderModelRepository()
        repo.saveByProviderId('p1', [
            makeModel({id: 'm-priced', modelName: 'priced-model', pricing: PRICING}),
            makeModel({id: 'm-free', modelName: 'free-model'}), // 无价 → 排除
        ])

        const entries = buildCustomPriceEntries()
        expect(entries).toHaveLength(1)
        expect(entries[0]).toEqual({
            providerId: 'p1',
            providerName: 'Test Provider',
            model: 'priced-model',
            pricing: PRICING,
        })
    })

    it('无任何自定义价时返回空数组（不抛错）', () => {
        const repo = new SqliteProviderModelRepository()
        repo.saveByProviderId('p1', [makeModel()])
        expect(buildCustomPriceEntries()).toEqual([])
    })
})
