/**
 * channelStore 单元测试
 *
 * 覆盖：
 * - loadChannels：mock api.list → channels 填充 + toUI 转换
 *   （status/statusMessage/lastConnectedAt/errorCount/config 默认值）
 * - create / update / remove：成功 → 调用 api + reload；失败 → 返回 error 不 reload
 * - login：透传 api.login 结果
 * - onStatusChanged：模块顶层注册的监听触发 reload
 *
 * 隔离：channelStore 在模块顶层注册 onStatusChanged 监听，因此必须
 * 在 import 之前注入 window.electronAPI.channel（vi.hoisted），
 * 不触碰真实 IPC。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'

// 模块导入前注入 window（channelStore 顶层 create() 内注册 onStatusChanged）
const h = vi.hoisted(() => {
    const statusHandlers: Array<() => void> = []
    const channel = {
        onStatusChanged: vi.fn((fn: () => void) => { statusHandlers.push(fn) }),
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        login: vi.fn(),
    }
    ;(globalThis as any).window = {electronAPI: {channel}}
    return {channel, statusHandlers}
})

import {useChannelStore} from '@/renderer/stores/channelStore'

/** 后端原始渠道记录（缺 toUI 会补默认值的可选字段） */
const rawChannel = {
    id: 'c1',
    name: '测试渠道',
    type: 'wechat',
    enabled: true,
    config: {foo: 'bar'},
    createdAt: 1000,
    updatedAt: 2000,
}

beforeEach(() => {
    vi.clearAllMocks()
    h.channel.list.mockResolvedValue([])
    h.channel.create.mockResolvedValue({success: true})
    h.channel.update.mockResolvedValue({success: true})
    h.channel.delete.mockResolvedValue({success: true})
    h.channel.login.mockResolvedValue({success: true})
    useChannelStore.setState({channels: [], loading: false})
})

describe('loadChannels', () => {
    it('list 返回列表 → channels 正确填充并完成 toUI 默认值转换', async () => {
        h.channel.list.mockResolvedValue([rawChannel])
        await useChannelStore.getState().loadChannels()
        const state = useChannelStore.getState()
        expect(state.loading).toBe(false)
        expect(state.channels).toHaveLength(1)
        expect(state.channels[0]).toMatchObject({
            id: 'c1',
            name: '测试渠道',
            type: 'wechat',
            enabled: true,
            config: {foo: 'bar'},
            status: 'disconnected',
            statusMessage: '',
            lastConnectedAt: null,
            errorCount: 0,
            createdAt: 1000,
            updatedAt: 2000,
        })
    })

    it('已有 status/statusMessage/errorCount/lastConnectedAt 原样保留（不被默认值覆盖）', async () => {
        h.channel.list.mockResolvedValue([{
            ...rawChannel,
            status: 'connected',
            statusMessage: 'ok',
            errorCount: 3,
            lastConnectedAt: 999,
        }])
        await useChannelStore.getState().loadChannels()
        expect(useChannelStore.getState().channels[0]).toMatchObject({
            status: 'connected',
            statusMessage: 'ok',
            errorCount: 3,
            lastConnectedAt: 999,
        })
    })

    it('list 返回空列表 → channels 为空数组', async () => {
        h.channel.list.mockResolvedValue([])
        await useChannelStore.getState().loadChannels()
        expect(useChannelStore.getState().channels).toEqual([])
    })
})

describe('create / update / remove / login', () => {
    it('create 成功 → 调用 api.create（type/name/config）+ reload', async () => {
        h.channel.list.mockResolvedValue([rawChannel])
        const r = await useChannelStore.getState().create('wechat', '新渠道', {key: 'v'})
        expect(h.channel.create).toHaveBeenCalledWith({
            type: 'wechat',
            name: '新渠道',
            config: {key: 'v'},
        })
        expect(r).toEqual({success: true})
        // reload 生效：channels 被刷新
        expect(h.channel.list).toHaveBeenCalledTimes(1)
        expect(useChannelStore.getState().channels).toHaveLength(1)
    })

    it('create 失败 → 返回 error，不 reload', async () => {
        h.channel.create.mockResolvedValue({success: false, error: 'boom'})
        const r = await useChannelStore.getState().create('feishu', 'x', {})
        expect(r).toEqual({success: false, error: 'boom'})
        expect(h.channel.list).not.toHaveBeenCalled()
    })

    it('create 无返回（api 缺失）→ 返回 {success:false}，不 reload', async () => {
        h.channel.create.mockResolvedValue(undefined as any)
        const r = await useChannelStore.getState().create('wechat', 'x', {})
        expect(r).toEqual({success: false})
        expect(h.channel.list).not.toHaveBeenCalled()
    })

    it('update 成功 → 调用 api.update(id, updates) + reload', async () => {
        h.channel.update.mockResolvedValue({success: true})
        h.channel.list.mockResolvedValue([])
        await useChannelStore.getState().update('c1', {name: 'renamed'})
        expect(h.channel.update).toHaveBeenCalledWith('c1', {name: 'renamed'})
        expect(h.channel.list).toHaveBeenCalledTimes(1)
    })

    it('update 失败 → 返回 error，不 reload', async () => {
        h.channel.update.mockResolvedValue({success: false, error: 'nope'})
        await useChannelStore.getState().update('c1', {name: 'x'})
        expect(h.channel.list).not.toHaveBeenCalled()
    })

    it('remove 成功 → 调用 api.delete(id) + reload', async () => {
        h.channel.delete.mockResolvedValue({success: true})
        h.channel.list.mockResolvedValue([])
        await useChannelStore.getState().remove('c1')
        expect(h.channel.delete).toHaveBeenCalledWith('c1')
        expect(h.channel.list).toHaveBeenCalledTimes(1)
    })

    it('remove 失败 → 不 reload', async () => {
        h.channel.delete.mockResolvedValue({success: false, error: 'gone'})
        await useChannelStore.getState().remove('c1')
        expect(h.channel.list).not.toHaveBeenCalled()
    })

    it('login → 透传 api.login 结果', async () => {
        h.channel.login.mockResolvedValue({success: true, id: 'c1'})
        const r = await useChannelStore.getState().login('c1')
        expect(h.channel.login).toHaveBeenCalledWith('c1')
        expect(r).toEqual({success: true, id: 'c1'})
    })
})

describe('onStatusChanged（模块顶层注册）', () => {
    it('模块加载时注册了 onStatusChanged 监听', () => {
        expect(h.statusHandlers.length).toBeGreaterThanOrEqual(1)
    })

    it('触发 onStatusChanged → 重新加载渠道列表', async () => {
        h.channel.list.mockResolvedValue([rawChannel])
        const handler = h.statusHandlers[0]
        handler()
        await vi.waitFor(() => {
            expect(useChannelStore.getState().channels).toHaveLength(1)
        })
        expect(h.channel.list).toHaveBeenCalled()
    })
})
