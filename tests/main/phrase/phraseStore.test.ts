import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// phraseStore 通过 getHclawDir() 定位存储目录（~/.hclaw/data/phrases/phrases.json）。
// getHclawDir 无环境变量覆盖，故用 vi.doMock 指到临时目录，
// 与 tests/main/memo/memoStore.test.ts 的模块 mock 约定一致。
const tmpBase = () => fs.mkdtempSync(path.join(os.tmpdir(), 'phrase-test-'))

let dir: string
beforeEach(() => {
    dir = tmpBase()
    process.env.HCLAW_TEST_DIR = dir
    vi.resetModules()
})
afterEach(() => fs.rmSync(dir, {recursive: true, force: true}))

async function freshStore(opts?: {failRename?: boolean}) {
    vi.resetModules() // 保证同测试内二次 import 不复用缓存模块
    vi.doMock('../../../src/main/config', () => ({
        getHclawDir: () => process.env.HCLAW_TEST_DIR,
    }))
    if (opts?.failRename) {
        // ESM 命名空间不可 spy（Module namespace is not configurable），
        // 故用 vi.doMock 包装 fs，让 renameSync 在 tmp→rename 阶段抛错
        vi.doMock('fs', async (importOriginal) => {
            const actual = await importOriginal<typeof import('fs')>()
            return {...actual, renameSync: () => { throw new Error('rename failed') }}
        })
    }
    const mod = await import('../../../src/main/phrase/phraseStore')
    return mod.phraseStore
}

describe('phraseStore', () => {
    it('create 后 list 返回新短语，且空 content 抛 PHRASE_EMPTY', async () => {
        const store = await freshStore()
        expect(() => store.create({content: '   '})).toThrow('PHRASE_EMPTY')
        const item = store.create({content: 'hello phrase'})
        expect(item.id).toMatch(/^phrase-/)
        expect(store.list()).toHaveLength(1)
        expect(store.list()[0].content).toBe('hello phrase')
    })

    it('touch 仅更新 lastUsedAt，不更新 updatedAt', async () => {
        const store = await freshStore()
        const item = store.create({content: 'a'})
        const beforeUpdated = item.updatedAt
        const beforeLast = item.lastUsedAt
        await new Promise(r => setTimeout(r, 2))
        const touched = store.touch(item.id)
        expect(touched.lastUsedAt).toBeGreaterThan(beforeLast)
        expect(touched.updatedAt).toBe(beforeUpdated)
    })

    it('update 改 content 并更新 updatedAt', async () => {
        const store = await freshStore()
        const item = store.create({content: 'a'})
        const updated = store.update(item.id, {content: 'b'})
        expect(updated.content).toBe('b')
        expect(updated.updatedAt).toBeGreaterThanOrEqual(item.updatedAt)
    })

    it('update/touch 未知 id 抛 PHRASE_NOT_FOUND', async () => {
        const store = await freshStore()
        expect(() => store.update('nope', {content: 'x'})).toThrow('PHRASE_NOT_FOUND')
        expect(() => store.touch('nope')).toThrow('PHRASE_NOT_FOUND')
    })

    it('remove 删除指定短语', async () => {
        const store = await freshStore()
        const a = store.create({content: 'a'})
        store.create({content: 'b'})
        store.remove(a.id)
        expect(store.list()).toHaveLength(1)
        expect(store.list()[0].content).toBe('b')
    })

    it('损坏 JSON 容错：备份 corrupt 文件并空列表启动', async () => {
        const store = await freshStore()
        const file = path.join(dir, 'data', 'phrases', 'phrases.json')
        fs.mkdirSync(path.dirname(file), {recursive: true})
        fs.writeFileSync(file, '{ not valid json')
        expect(store.list()).toEqual([])
        const backups = fs.readdirSync(path.dirname(file)).filter(f => f.includes('corrupt'))
        expect(backups.length).toBe(1)
    })

    it('原子写失败不损坏原文件：renameSync 抛错时原 phrases.json 保持完整', async () => {
        const store = await freshStore()
        store.create({content: 'keep'})
        const file = path.join(dir, 'data', 'phrases', 'phrases.json')
        const snapshot = fs.readFileSync(file, 'utf8')

        const failing = await freshStore({failRename: true})
        expect(() => failing.create({content: 'new'})).toThrow('rename failed')

        // 原文件未被破坏，数据仍完整可读
        expect(fs.readFileSync(file, 'utf8')).toBe(snapshot)
        expect(store.list().map(p => p.content)).toEqual(['keep'])
    })
})
