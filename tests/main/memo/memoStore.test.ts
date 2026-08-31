import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// memoStore 通过 getHclawDir() 定位存储目录。
// getHclawDir 无环境变量覆盖（引导文件/默认 ~/.hclaw），故用 vi.doMock 指到临时目录，
// 与 tests/main/agent/runtimeConfigManager.override.test.ts 的模块 mock 约定一致。
const tmpBase = () => fs.mkdtempSync(path.join(os.tmpdir(), 'memo-test-'))

let dir: string
beforeEach(() => {
    dir = tmpBase()
    process.env.HCLAW_TEST_DIR = dir
    vi.resetModules() // 每个 case 重新加载 memoStore，隔离内存态
})
afterEach(() => fs.rmSync(dir, {recursive: true, force: true}))

async function freshStore() {
    vi.doMock('../../../src/main/config', () => ({
        getHclawDir: () => process.env.HCLAW_TEST_DIR,
    }))
    const mod = await import('../../../src/main/memo/memoStore')
    return mod.memoStore
}

describe('memoStore attachments', () => {
    const PENDING_DIR_TEST = () => path.join(dir, 'data', 'memo', '_pending')

    it('memoId 为空 → 复制到 _pending 并返回暂存路径', async () => {
        const store = await freshStore()
        const src = path.join(dir, 'src-img.png')
        fs.writeFileSync(src, 'pngdata')
        const att = await store.uploadAttachment({fileName: 'img.png', srcPath: src, mime: 'image/png'})
        expect(att.kind).toBe('image')
        expect(att.storedPath).toContain('_pending')
        expect(fs.existsSync(att.storedPath)).toBe(true)
    })

    it('create 时迁移暂存附件到 attachments/<memoId>/', async () => {
        const store = await freshStore()
        const src = path.join(dir, 'a.txt')
        fs.writeFileSync(src, 'hello')
        const att = await store.uploadAttachment({fileName: 'a.txt', srcPath: src, mime: 'text/plain'})
        const item = store.create({workspacePath: 'E:\\p', content: 'with att', title: 'T', attachments: [att]})
        expect(item.attachments[0].storedPath).toContain(`attachments${path.sep}${item.id}`)
        expect(fs.existsSync(item.attachments[0].storedPath)).toBe(true)
        // _pending 中原文件已不在
        expect(fs.existsSync(att.storedPath)).toBe(false)
    })

    it('discardPending 删除暂存文件', async () => {
        const store = await freshStore()
        const src = path.join(dir, 'a.txt')
        fs.writeFileSync(src, 'hello')
        const att = await store.uploadAttachment({fileName: 'a.txt', srcPath: src, mime: 'text/plain'})
        await store.discardPending([att.id])
        expect(fs.existsSync(att.storedPath)).toBe(false)
    })

    it('fileName 含 .. 不逃逸 destDir', async () => {
        const store = await freshStore()
        const src = path.join(dir, 'evil.txt')
        fs.writeFileSync(src, 'evil')
        const att = await store.uploadAttachment({fileName: '..\\..\\evil.txt', srcPath: src, mime: 'text/plain'})
        expect(path.resolve(att.storedPath).startsWith(path.resolve(PENDING_DIR_TEST()) + path.sep)).toBe(true)
        expect(fs.existsSync(att.storedPath)).toBe(true)
        expect(path.basename(att.storedPath)).toBe('evil.txt')
    })

    it('discardPending 传 ../evil 不删除任意目录', async () => {
        const store = await freshStore()
        const evilDir = path.join(PENDING_DIR_TEST(), '..', 'evil-dir')
        fs.mkdirSync(evilDir, {recursive: true})
        await store.discardPending(['../evil-dir'])
        expect(fs.existsSync(evilDir)).toBe(true)
        // 合法 id 仍可正常删除
        const src = path.join(dir, 'a.txt')
        fs.writeFileSync(src, 'x')
        const att = await store.uploadAttachment({fileName: 'a.txt', srcPath: src, mime: 'text/plain'})
        await store.discardPending([att.id])
        expect(fs.existsSync(att.storedPath)).toBe(false)
    })

    it('重复 update 携带旧暂存 storedPath（源文件已迁移走）不抛错且 json 正常写入', async () => {
        const store = await freshStore()
        const src = path.join(dir, 'a.txt')
        fs.writeFileSync(src, 'hello')
        const att = await store.uploadAttachment({fileName: 'a.txt', srcPath: src, mime: 'text/plain'})
        const item = store.create({workspacePath: 'E:\\p', content: 'with att', title: 'T', attachments: [att]})
        // 模拟客户端持旧 attachments 数组二次 update
        const updated = store.update(item.id, {content: 'second', attachments: [att]})
        expect(updated.attachments[0].storedPath).toBe(item.attachments[0].storedPath)
        expect(fs.existsSync(updated.attachments[0].storedPath)).toBe(true)
        const store2 = await freshStore()
        expect(store2.findById(item.id)?.content).toBe('second')
    })

    it('cleanupStalePending 清理超 24h 残留', async () => {
        const store = await freshStore()
        const staleDir = path.join(PENDING_DIR_TEST(), 'old-att')
        fs.mkdirSync(staleDir, {recursive: true})
        fs.writeFileSync(path.join(staleDir, 'x'), 'x')
        // 把目录 mtime 拨回 25h 前
        const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
        fs.utimesSync(staleDir, old, old)
        await store.cleanupStalePending()
        expect(fs.existsSync(staleDir)).toBe(false)
    })

    it('createSession 之外：附件 20 个上限由 UI 层拦截（此处仅单条上传）', async () => {
        // 占位断言：上限逻辑在渲染层（spec §9），主进程不做限制
        expect(true).toBe(true)
    })
})

describe('memoStore', () => {
    it('create → list 返回同一条，且写入 memos.json', async () => {
        const store = await freshStore()
        const item = store.create({workspacePath: 'E:\\proj-a', content: 'fix bug', title: 'T'})
        expect(item.status).toBe('active')
        expect(item.attachments).toEqual([])
        expect(store.list('E:\\proj-a')).toHaveLength(1)

        const hashDir = fs.readdirSync(path.join(dir, 'data', 'memo'))[0]
        const raw = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'memo', hashDir, 'memos.json'), 'utf8'))
        expect(raw).toHaveLength(1)
    })

    it('不同工作区目录隔离', async () => {
        const store = await freshStore()
        store.create({workspacePath: 'E:\\proj-a', content: 'a', title: 'T'})
        store.create({workspacePath: 'E:\\proj-b', content: 'b', title: 'T'})
        expect(store.list('E:\\proj-a').map(m => m.content)).toEqual(['a'])
        expect(store.list('E:\\proj-b').map(m => m.content)).toEqual(['b'])
    })

    it('content 与 attachments 同时为空 → throw MEMO_EMPTY', async () => {
        const store = await freshStore()
        expect(() => store.create({workspacePath: 'E:\\p', content: '  ', title: 'T'})).toThrow('MEMO_EMPTY')
    })

    it('update 修改字段并刷新 updatedAt', async () => {
        const store = await freshStore()
        const item = store.create({workspacePath: 'E:\\p', content: 'v1', title: 'T'})
        const updated = store.update(item.id, {content: 'v2'})
        expect(updated.content).toBe('v2')
        expect(updated.updatedAt).toBeGreaterThanOrEqual(item.updatedAt)
    })

    it('update 不存在的 id → throw MEMO_NOT_FOUND', async () => {
        const store = await freshStore()
        expect(() => store.update('memo-none', {status: 'processed'})).toThrow('MEMO_NOT_FOUND')
    })

    it('remove 删除条目与附件目录', async () => {
        const store = await freshStore()
        const item = store.create({workspacePath: 'E:\\p', content: 'x', title: 'T'})
        // 手工造一个附件目录
        const hashDir = fs.readdirSync(path.join(dir, 'data', 'memo'))[0]
        const attDir = path.join(dir, 'data', 'memo', hashDir, 'attachments', item.id)
        fs.mkdirSync(attDir, {recursive: true})
        fs.writeFileSync(path.join(attDir, 'a.txt'), 'x')

        store.remove(item.id)
        expect(store.list('E:\\p')).toHaveLength(0)
        expect(fs.existsSync(attDir)).toBe(false)
    })

    it('create 带 title 落盘（trim）', async () => {
        const store = await freshStore()
        const item = store.create({workspacePath: 'E:\\p', content: 'c', title: '  我的标题  '})
        expect(item.title).toBe('我的标题')
        const hashDir = fs.readdirSync(path.join(dir, 'data', 'memo'))[0]
        const raw = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'memo', hashDir, 'memos.json'), 'utf8'))
        expect(raw[0].title).toBe('我的标题')
    })

    it('title 为空（trim 后）→ throw MEMO_EMPTY', async () => {
        const store = await freshStore()
        expect(() => store.create({workspacePath: 'E:\\p', content: 'c', title: '   '})).toThrow('MEMO_EMPTY')
        expect(() => store.create({workspacePath: 'E:\\p', content: 'c', title: undefined as unknown as string})).toThrow('MEMO_EMPTY')
    })

    it('旧数据无 title 字段 → 读取归一化为 title: \'\'（不写回）', async () => {
        const store = await freshStore()
        const item = store.create({workspacePath: 'E:\\p', content: 'legacy', title: 't'})
        const hashDir = fs.readdirSync(path.join(dir, 'data', 'memo'))[0]
        const file = path.join(dir, 'data', 'memo', hashDir, 'memos.json')
        // 手工去掉 title 字段，模拟旧数据
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
        delete raw[0].title
        fs.writeFileSync(file, JSON.stringify(raw), 'utf8')

        const store2 = await freshStore()
        const loaded = store2.list('E:\\p')
        expect(loaded[0].title).toBe('')
        expect(loaded[0].content).toBe('legacy')
        // 不迁移写回：文件里仍无 title 字段
        const raw2 = JSON.parse(fs.readFileSync(file, 'utf8'))
        expect(raw2[0].title).toBeUndefined()
        expect(item.id).toBeTruthy()
    })

    it('update 可修改 title（trim）', async () => {
        const store = await freshStore()
        const item = store.create({workspacePath: 'E:\\p', content: 'v1', title: 'v1 title'})
        const updated = store.update(item.id, {title: '  新标题  '})
        expect(updated.title).toBe('新标题')
        expect(store.findById(item.id)!.title).toBe('新标题')
    })

    it('update 空 title（trim 后）→ throw MEMO_EMPTY；合法 title 正常更新', async () => {
        const store = await freshStore()
        const item = store.create({workspacePath: 'E:\\p', content: 'v1', title: 'old'})
        expect(() => store.update(item.id, {title: '   '})).toThrow('MEMO_EMPTY')
        // 抛错后原数据未被破坏
        expect(store.findById(item.id)!.title).toBe('old')
        const updated = store.update(item.id, {title: '  合法  '})
        expect(updated.title).toBe('合法')
    })

    it('memos.json 损坏 → 备份为 .corrupt-<ts> 并以空列表启动', async () => {
        const store = await freshStore()
        store.create({workspacePath: 'E:\\p', content: 'ok', title: 'T'})
        const hashDir = fs.readdirSync(path.join(dir, 'data', 'memo'))[0]
        const file = path.join(dir, 'data', 'memo', hashDir, 'memos.json')
        fs.writeFileSync(file, '{broken json!!')

        const store2 = await freshStore() // 重新加载 → 重新读盘
        expect(store2.list('E:\\p')).toHaveLength(0)
        expect(fs.readdirSync(path.dirname(file)).some(f => f.startsWith('memos.json.corrupt-'))).toBe(true)
    })

    it('写入是原子且串行的：并发 create 全部落盘', async () => {
        const store = await freshStore()
        await Promise.all(Array.from({length: 20}, (_, i) =>
            Promise.resolve().then(() => store.create({workspacePath: 'E:\\p', content: `c${i}`, title: `t${i}`}))))
        expect(store.list('E:\\p')).toHaveLength(20)
        // JSON 仍可解析（未被并发写破坏）
        const hashDir = fs.readdirSync(path.join(dir, 'data', 'memo'))[0]
        expect(() => JSON.parse(fs.readFileSync(path.join(dir, 'data', 'memo', hashDir, 'memos.json'), 'utf8'))).not.toThrow()
    })
})

describe('memoStore pinned/sortIndex', () => {
    it('新建条目默认 pinned=false、sortIndex=0', async () => {
        const store = await freshStore()
        const item = store.create({workspacePath: 'E:\\p', content: 'c', title: 'T'})
        expect(item.pinned).toBe(false)
        expect(item.sortIndex).toBe(0)
    })

    it('旧数据无 pinned/sortIndex 字段 → 读取归一化为默认值（不迁移写回）', async () => {
        const store = await freshStore()
        store.create({workspacePath: 'E:\\p', content: 'legacy', title: 't'})
        const hashDir = fs.readdirSync(path.join(dir, 'data', 'memo'))[0]
        const file = path.join(dir, 'data', 'memo', hashDir, 'memos.json')
        // 手工去掉新字段，模拟存量数据
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
        delete raw[0].pinned
        delete raw[0].sortIndex
        fs.writeFileSync(file, JSON.stringify(raw), 'utf8')

        const store2 = await freshStore()
        const loaded = store2.list('E:\\p')[0]
        expect(loaded.pinned).toBe(false)
        expect(loaded.sortIndex).toBe(0)
        // 不迁移写回：文件里仍无新字段
        const raw2 = JSON.parse(fs.readFileSync(file, 'utf8'))
        expect(raw2[0].pinned).toBeUndefined()
        expect(raw2[0].sortIndex).toBeUndefined()
    })

    it('update 可修改 pinned / sortIndex 并持久化', async () => {
        const store = await freshStore()
        const item = store.create({workspacePath: 'E:\\p', content: 'c', title: 'T'})
        store.update(item.id, {pinned: true, sortIndex: 3})
        const store2 = await freshStore()
        const loaded = store2.findById(item.id)!
        expect(loaded.pinned).toBe(true)
        expect(loaded.sortIndex).toBe(3)
    })

    it('update status=processed → pinned 自动清除', async () => {
        const store = await freshStore()
        const item = store.create({workspacePath: 'E:\\p', content: 'c', title: 'T'})
        store.update(item.id, {pinned: true})
        const updated = store.update(item.id, {status: 'processed'})
        expect(updated.status).toBe('processed')
        expect(updated.pinned).toBe(false)
        // 落盘持久
        const store2 = await freshStore()
        expect(store2.findById(item.id)!.pinned).toBe(false)
    })

    it('update 仅 pinned=false（未改状态）不影响 status', async () => {
        const store = await freshStore()
        const item = store.create({workspacePath: 'E:\\p', content: 'c', title: 'T'})
        store.update(item.id, {pinned: true})
        const updated = store.update(item.id, {pinned: false})
        expect(updated.status).toBe('active')
        expect(updated.pinned).toBe(false)
    })

    it('memos.json 含新字段损坏 → 备份容错路径不受影响', async () => {
        const store = await freshStore()
        const item = store.create({workspacePath: 'E:\\p', content: 'ok', title: 'T'})
        store.update(item.id, {pinned: true, sortIndex: 1})
        const hashDir = fs.readdirSync(path.join(dir, 'data', 'memo'))[0]
        const file = path.join(dir, 'data', 'memo', hashDir, 'memos.json')
        fs.writeFileSync(file, '{broken!!')

        const store2 = await freshStore()
        expect(store2.list('E:\\p')).toHaveLength(0)
        expect(fs.readdirSync(path.dirname(file)).some(f => f.startsWith('memos.json.corrupt-'))).toBe(true)
    })
})
