// @vitest-environment jsdom
/**
 * ModelDetailModal — OpenRouter 固定服务商字段：渲染条件 + 候选加载 + 自由输入 +
 * 清空语义 + force 刷新 + preload 方法缺失降级。
 *
 * 契约：
 * - isOpenRouter=false → 不渲染字段、不调用 modelMetaEndpoints
 * - isOpenRouter=true  → 打开时按 model.name 拉取候选（force 省略）
 * - 聚焦展开候选面板；点选写入 slug；确定经 commitModelDetail 透传
 * - 自由输入列表外 slug（如 deepinfra/turbo）合法；清空 = undefined（自动路由）
 * - 刷新按钮以 force=true 重拉
 * - window.electronAPI.modelMetaEndpoints 缺失 → 无候选、不报错，仍可手输提交
 */
import {describe, it, expect, vi, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import {ModelDetailModal} from '../../src/renderer/components/dialogs/providerEdit/ModelDetailModal'

const providers = [
    {slug: 'deepinfra', name: 'DeepInfra', supportsImplicitCaching: true, contextLength: 163840, uptimeLast30m: 99.9},
    {slug: 'together', name: 'Together AI', supportsImplicitCaching: false, uptimeLast30m: 98.2},
]

function stubApi() {
    const eps = vi.fn().mockResolvedValue({fetchedAt: 1, providers})
    vi.stubGlobal('electronAPI', {modelMetaEndpoints: eps})
    return eps
}

const baseModel = {id: 'm1', name: 'deepseek/deepseek-chat', enabled: true}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('ModelDetailModal · OpenRouter 固定服务商', () => {
    it('isOpenRouter=false 时不渲染字段、不请求 endpoints', async () => {
        const eps = stubApi()
        render(<ModelDetailModal open providerName="OR" model={baseModel} settingsDefaults={{}} rate={7.2}
            onClose={() => {}} onConfirm={() => {}}/>)
        expect(screen.queryByPlaceholderText('自动路由（不指定服务商）')).toBeNull()
        expect(eps).not.toHaveBeenCalled()
    })

    it('打开时拉取候选；聚焦展开、点选写入 slug、确定透传', async () => {
        const eps = stubApi()
        const onConfirm = vi.fn()
        render(<ModelDetailModal open isOpenRouter providerName="OR" model={baseModel} settingsDefaults={{}} rate={7.2}
            onClose={() => {}} onConfirm={onConfirm}/>)
        const input = await screen.findByPlaceholderText('自动路由（不指定服务商）')
        await waitFor(() => expect(eps).toHaveBeenCalledWith('deepseek/deepseek-chat', undefined))

        fireEvent.focus(input)
        const opt = await screen.findByText('DeepInfra')
        expect(screen.getByText('deepinfra')).toBeTruthy()
        // supports_implicit_caching 是恒假信号（22 样本全 false，2026-09-19 实测），
        // 依赖它的「✓ 隐式缓存」徽标已移除，不得回流
        expect(screen.queryByText('✓ 隐式缓存')).toBeNull()
        expect(screen.getByText('99.9%')).toBeTruthy()

        fireEvent.mouseDown(opt.closest('button')!)
        expect((input as HTMLInputElement).value).toBe('deepinfra')

        fireEvent.click(screen.getByText('确定'))
        expect(onConfirm).toHaveBeenCalledTimes(1)
        expect(onConfirm.mock.calls[0][0].openRouterProvider).toBe('deepinfra')
    })

    it('自由输入列表外 slug；清空 = undefined（自动路由）', async () => {
        stubApi()
        const onConfirm = vi.fn()
        render(<ModelDetailModal open isOpenRouter providerName="OR" model={baseModel} settingsDefaults={{}} rate={7.2}
            onClose={() => {}} onConfirm={onConfirm}/>)
        const input = await screen.findByPlaceholderText('自动路由（不指定服务商）') as HTMLInputElement

        fireEvent.change(input, {target: {value: 'deepinfra/turbo'}})
        fireEvent.click(screen.getByText('确定'))
        expect(onConfirm.mock.calls[0][0].openRouterProvider).toBe('deepinfra/turbo')

        // 清空 → undefined（自动路由；commitModelDetail 负责 trim/空值）
        const onConfirm2 = vi.fn()
        render(<ModelDetailModal open isOpenRouter providerName="OR"
            model={{...baseModel, openRouterProvider: 'deepinfra/turbo'}} settingsDefaults={{}} rate={7.2}
            onClose={() => {}} onConfirm={onConfirm2}/>)
        const input2 = (await screen.findAllByPlaceholderText('自动路由（不指定服务商）'))[1] as HTMLInputElement
        expect(input2.value).toBe('deepinfra/turbo')
        fireEvent.change(input2, {target: {value: ''}})
        fireEvent.click(screen.getAllByText('确定')[1])
        expect(onConfirm2.mock.calls[0][0].openRouterProvider).toBeUndefined()
    })

    it('刷新按钮 force=true 重拉；endpoints 不存在时静默降级为纯文本', async () => {
        const eps = stubApi()
        render(<ModelDetailModal open isOpenRouter providerName="OR" model={baseModel} settingsDefaults={{}} rate={7.2}
            onClose={() => {}} onConfirm={() => {}}/>)
        await screen.findByPlaceholderText('自动路由（不指定服务商）')
        fireEvent.click(screen.getByTitle('刷新服务商列表'))
        await waitFor(() => expect(eps).toHaveBeenCalledWith('deepseek/deepseek-chat', true))
    })

    it('preload 方法未落地：无候选、不报错，仍可手输并提交', async () => {
        vi.stubGlobal('electronAPI', {})
        const onConfirm = vi.fn()
        render(<ModelDetailModal open isOpenRouter providerName="OR" model={baseModel} settingsDefaults={{}} rate={7.2}
            onClose={() => {}} onConfirm={onConfirm}/>)
        const input = await screen.findByPlaceholderText('自动路由（不指定服务商）') as HTMLInputElement
        fireEvent.focus(input)
        expect(screen.queryByText('DeepInfra')).toBeNull()
        fireEvent.change(input, {target: {value: 'novita'}})
        fireEvent.click(screen.getByText('确定'))
        expect(onConfirm.mock.calls[0][0].openRouterProvider).toBe('novita')
    })

    it('刷新失败保留已显示候选（不清空，面板不闪空）', async () => {
        const eps = stubApi()
        render(<ModelDetailModal open isOpenRouter providerName="OR" model={baseModel} settingsDefaults={{}} rate={7.2}
            onClose={() => {}} onConfirm={() => {}}/>)
        const input = await screen.findByPlaceholderText('自动路由（不指定服务商）')
        fireEvent.focus(input)
        await screen.findByText('DeepInfra')

        eps.mockRejectedValueOnce(new Error('network down'))
        fireEvent.click(screen.getByTitle('刷新服务商列表'))
        await waitFor(() => expect(eps).toHaveBeenCalledWith('deepseek/deepseek-chat', true))
        // 旧候选仍在（registry「失败不破坏缓存」在 UI 侧不被抵消）
        expect(screen.getByText('DeepInfra')).toBeTruthy()

        // 空结果（registry 降级返回 providers: []）同样保留旧候选
        eps.mockResolvedValueOnce({fetchedAt: 0, providers: []})
        fireEvent.click(screen.getByTitle('刷新服务商列表'))
        await waitFor(() => expect(eps).toHaveBeenCalledTimes(3))
        expect(screen.getByText('DeepInfra')).toBeTruthy()
    })

    it('面板打开时点击刷新按钮不收起面板（刷新后可继续选择）', async () => {
        const eps = stubApi()
        render(<ModelDetailModal open isOpenRouter providerName="OR" model={baseModel} settingsDefaults={{}} rate={7.2}
            onClose={() => {}} onConfirm={() => {}}/>)
        const input = await screen.findByPlaceholderText('自动路由（不指定服务商）')
        fireEvent.focus(input)
        await screen.findByText('DeepInfra')

        const refresh = screen.getByTitle('刷新服务商列表')
        fireEvent.mouseDown(refresh)   // 外部点击监听的收起路径
        fireEvent.click(refresh)
        await waitFor(() => expect(eps).toHaveBeenCalledWith('deepseek/deepseek-chat', true))
        expect(screen.getByText('DeepInfra')).toBeTruthy()
    })
})
