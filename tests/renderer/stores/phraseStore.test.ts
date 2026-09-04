// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {usePhraseStore, subscribePhraseChanged} from '../../../src/renderer/stores/phraseStore'

const item = (over: Partial<any> = {}) => ({id: 'phrase-1', content: 'hi', createdAt: 1, updatedAt: 1, lastUsedAt: 1, ...over})

describe('usePhraseStore', () => {
    beforeEach(() => {
        usePhraseStore.setState({phrases: [], loading: false, error: null})
        vi.restoreAllMocks()
    })

    it('load 解包 {ok,data} 并写入 phrases', async () => {
        const list = [item()]
        ;(window as any).electronAPI = {phrase: {list: vi.fn().mockResolvedValue({ok: true, data: list})}}
        await usePhraseStore.getState().load()
        expect(usePhraseStore.getState().phrases).toEqual(list)
    })

    it('load 失败解包 error', async () => {
        ;(window as any).electronAPI = {phrase: {list: vi.fn().mockResolvedValue({ok: false, error: 'err'})}}
        await usePhraseStore.getState().load()
        expect(usePhraseStore.getState().error).toBe('err')
    })

    it('touch 成功后本地更新 lastUsedAt', async () => {
        usePhraseStore.setState({phrases: [item()]})
        const returned = item({lastUsedAt: 999})
        ;(window as any).electronAPI = {phrase: {touch: vi.fn().mockResolvedValue({ok: true, data: returned})}}
        await usePhraseStore.getState().touch('phrase-1')
        expect(usePhraseStore.getState().phrases[0].lastUsedAt).toBe(999)
    })

    it('create 成功后触发 load', async () => {
        const created = item({id: 'phrase-2'})
        const list = vi.fn().mockResolvedValue({ok: true, data: [created]})
        ;(window as any).electronAPI = {phrase: {create: vi.fn().mockResolvedValue({ok: true, data: created}), list}}
        const res = await usePhraseStore.getState().create({content: 'new'})
        expect(res?.id).toBe('phrase-2')
        expect(list).toHaveBeenCalled()
    })

    it('onPhraseChanged 触发 reload', async () => {
        const list = vi.fn().mockResolvedValue({ok: true, data: [item()]})
        let captured: (() => void) | null = null
        ;(window as any).electronAPI = {
            phrase: {list},
            onPhraseChanged: (h: () => void) => { captured = h; return () => {} },
        }
        const unsub = subscribePhraseChanged()
        expect(captured).toBeTruthy()
        captured!()
        await new Promise(r => setTimeout(r, 0))
        expect(list).toHaveBeenCalled()
        expect(typeof unsub).toBe('function')
    })
})
