import {describe, it, expect, vi, beforeEach} from 'vitest'

const handlers = new Map<string, (e: unknown, ...args: any[]) => unknown>()
const sent: string[] = []
const fakeWin = {isDestroyed: () => false, webContents: {send: (ch: string) => sent.push(ch)}}

vi.mock('electron', () => ({
    ipcMain: {handle: (ch: string, fn: unknown) => { handlers.set(ch, fn as any) }},
    BrowserWindow: {getAllWindows: () => [fakeWin]},
}))

// phraseStore 依赖 config/sqlite 链，vitest 环境下不可用，mock 掉（对齐 memoIPC.test 的做法）
vi.mock('../../../src/main/phrase/phraseStore', () => ({
    phraseStore: {
        create: () => ({id: 'phrase-x', content: 'a', createdAt: 1, updatedAt: 1, lastUsedAt: 1}),
        update: (id: string, patch: any) => {
            if (!patch?.content?.trim()) throw new Error('PHRASE_EMPTY')
            return {id, content: patch.content, createdAt: 1, updatedAt: 1, lastUsedAt: 1}
        },
        remove: () => {},
        touch: (id: string) => {
            if (id !== 'phrase-x') throw new Error('PHRASE_NOT_FOUND')
            return {id: 'phrase-x', content: 'a', createdAt: 1, updatedAt: 1, lastUsedAt: 1}
        },
        list: () => [],
    },
}))

describe('phraseIPC', () => {
    beforeEach(() => { handlers.clear(); sent.length = 0; vi.resetModules() })

    it('注册 5 个通道', async () => {
        await import('../../../src/main/phrase/phraseIPC')
        for (const ch of ['phrase:list', 'phrase:create', 'phrase:update', 'phrase:delete', 'phrase:touch']) {
            expect(handlers.has(ch)).toBe(true)
        }
    })

    it('create 空 content 返回结构化错误且不广播', async () => {
        await import('../../../src/main/phrase/phraseIPC')
        const fn = handlers.get('phrase:create')!
        const res = await fn(null, {content: '  '}) as any
        expect(res.ok).toBe(false)
        expect(res.error).toContain('短语内容不能为空')
        expect(sent).not.toContain('phrase_changed')
    })

    it('写操作成功后广播 phrase_changed', async () => {
        await import('../../../src/main/phrase/phraseIPC')
        const create = handlers.get('phrase:create')!
        await create(null, {content: 'a'})
        expect(sent).toContain('phrase_changed')
    })

    it('update 空 content 返回结构化错误', async () => {
        await import('../../../src/main/phrase/phraseIPC')
        const fn = handlers.get('phrase:update')!
        const res = await fn(null, {id: 'phrase-x', patch: {content: '  '}}) as any
        expect(res.ok).toBe(false)
        expect(res.error).toContain('短语内容不能为空')
    })

    it('touch 未知 id 返回结构化错误', async () => {
        await import('../../../src/main/phrase/phraseIPC')
        const fn = handlers.get('phrase:touch')!
        const res = await fn(null, 'nope') as any
        expect(res.ok).toBe(false)
        expect(res.error).toContain('短语不存在')
    })
})
