/**
 * memoStore 单元测试
 *
 * 覆盖：
 * - load：memo.list 包装形状 {ok:true,data} 解包 → memos 填充
 * - create：成功 → 调用 api.create 并全量刷新；失败 → error 置位返回 null
 * - updateItem / remove：成功 → 全量刷新
 * - createSession：失败（resolve {ok:false,error}，不 reject）→ error 置位、返回 null
 * - subscribeMemoChanged：同 workspacePath 回调 → 重新 load；不同 workspacePath → 不刷新
 *
 * 隔离：node 环境 mock globalThis.window.electronAPI，不触碰真实 IPC。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'

const h = vi.hoisted(() => {
    const changedHandlers: Array<(payload: {workspacePath: string}) => void> = []
    const memo: Record<string, ReturnType<typeof vi.fn>> = {
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        createSession: vi.fn(),
    }
    const onMemoChanged = vi.fn((fn: (payload: {workspacePath: string}) => void) => {
        changedHandlers.push(fn)
        return () => {
            const idx = changedHandlers.indexOf(fn)
            if (idx >= 0) changedHandlers.splice(idx, 1)
        }
    })
    ;(globalThis as {window?: unknown}).window = {electronAPI: {memo, onMemoChanged}}
    return {memo, onMemoChanged, changedHandlers}
})

import {useMemoStore, subscribeMemoChanged} from '@/renderer/stores/memoStore'
import type {MemoItem} from '@/shared/types/memo'

const P = 'E:\\p'
const item = (id: string): MemoItem => ({
    id,
    workspacePath: P,
    content: 'a',
    title: 'T',
    createdAt: 1,
    updatedAt: 1,
    attachments: [],
    status: 'active',
})

describe('renderer memoStore', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        useMemoStore.setState({memos: [], loading: false, error: null})
    })

    it('load 拉取列表（解包 {ok:true,data}）', async () => {
        h.memo.list.mockResolvedValueOnce({ok: true, data: [item('m1')]})
        await useMemoStore.getState().load(P)
        expect(h.memo.list).toHaveBeenCalledWith(P)
        expect(useMemoStore.getState().memos).toHaveLength(1)
        expect(useMemoStore.getState().error).toBeNull()
    })

    it('load 失败 → error 置位、memos 清空', async () => {
        h.memo.list.mockResolvedValueOnce({ok: false, error: '读取失败'})
        await useMemoStore.getState().load(P)
        expect(useMemoStore.getState().memos).toEqual([])
        expect(useMemoStore.getState().error).toBe('读取失败')
    })

    it('create 成功 → 调用 api.create 并全量刷新', async () => {
        h.memo.create.mockResolvedValueOnce({ok: true, data: item('m2')})
        h.memo.list.mockResolvedValueOnce({ok: true, data: [item('m2')]})
        const r = await useMemoStore.getState().create({workspacePath: P, content: 'b', title: 'T1'})
        expect(h.memo.create).toHaveBeenCalledWith({workspacePath: P, content: 'b', title: 'T1'})
        expect(r).not.toBeNull()
        expect(useMemoStore.getState().memos).toHaveLength(1)
    })

    it('create 携带 capability → 透传给 api.create', async () => {
        h.memo.create.mockResolvedValueOnce({ok: true, data: item('m3')})
        h.memo.list.mockResolvedValueOnce({ok: true, data: [item('m3')]})
        const capability = {type: 'skill' as const, name: 'translator'}
        const r = await useMemoStore.getState().create({workspacePath: P, content: 'c', title: 'T2', capability})
        expect(h.memo.create).toHaveBeenCalledWith({workspacePath: P, content: 'c', title: 'T2', capability})
        expect(r).not.toBeNull()
    })

    it('create 失败 → error 置位、返回 null', async () => {
        h.memo.create.mockResolvedValueOnce({ok: false, error: '写入失败'})
        const r = await useMemoStore.getState().create({workspacePath: P, content: 'b', title: 'T'})
        expect(r).toBeNull()
        expect(useMemoStore.getState().error).toBe('写入失败')
    })

    it('updateItem / remove 成功 → 全量刷新', async () => {
        h.memo.update.mockResolvedValueOnce({ok: true, data: item('m1')})
        h.memo.list.mockResolvedValueOnce({ok: true, data: [item('m1')]})
        await useMemoStore.getState().updateItem('m1', {content: 'x'})
        expect(h.memo.update).toHaveBeenCalledWith('m1', {content: 'x'})
        expect(useMemoStore.getState().memos).toHaveLength(1)

        h.memo.remove.mockResolvedValueOnce({ok: true, data: true})
        h.memo.list.mockResolvedValueOnce({ok: true, data: []})
        await useMemoStore.getState().remove('m1')
        expect(h.memo.remove).toHaveBeenCalledWith('m1')
        expect(useMemoStore.getState().memos).toEqual([])
    })

    it('createSession 失败（resolve {ok:false,error}）→ error 置位、返回 null', async () => {
        h.memo.createSession.mockResolvedValueOnce({ok: false, error: '模型配置未初始化'})
        const r = await useMemoStore.getState().createSession('m1')
        expect(r).toBeNull()
        expect(useMemoStore.getState().error).toContain('模型配置未初始化')
    })

    it('createSession 成功 → 返回 {convId}', async () => {
        h.memo.createSession.mockResolvedValueOnce({ok: true, data: {convId: 'conv-9'}})
        h.memo.list.mockResolvedValueOnce({ok: true, data: [item('m1')]})
        const r = await useMemoStore.getState().createSession('m1')
        expect(r).toEqual({convId: 'conv-9'})
    })

    it('subscribeMemoChanged：同 workspacePath → 重新 load；不同 → 不刷新', async () => {
        const unsub = subscribeMemoChanged(() => P)
        expect(h.onMemoChanged).toHaveBeenCalledTimes(1)

        h.memo.list.mockResolvedValueOnce({ok: true, data: [item('m1')]})
        h.changedHandlers[0]({workspacePath: P})
        await vi.waitFor(() => expect(h.memo.list).toHaveBeenCalledTimes(1))

        h.memo.list.mockResolvedValueOnce({ok: true, data: [item('m1')]})
        h.changedHandlers[0]({workspacePath: 'E:\\other'})
        await new Promise((r) => setTimeout(r, 10))
        expect(h.memo.list).toHaveBeenCalledTimes(1)

        unsub()
        expect(h.changedHandlers).toHaveLength(0)
    })
})
