// @vitest-environment jsdom
/**
 * PluginDialog 平移验收：capability:changed 订阅接线 + 三态渲染。
 *
 * 使用真实 pluginStore + electronAPI 替身，避免 mock 掉 store 导致接线被绕过。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {waitFor, act, cleanup, fireEvent} from '@testing-library/react'
import PluginDialog from '../../../../src/renderer/components/dialogs/PluginDialog'
import {usePluginStore} from '../../../../src/renderer/stores/pluginStore'
import {createElectronApiMock, renderWithStores, type ElectronApiMock} from '../../helpers/renderWithStores'

let apiHandle: ElectronApiMock

beforeEach(() => {
    usePluginStore.setState({
        plugins: [],
        realCounts: {},
        capabilityDetails: {},
        versionData: {},
        loading: true,
        error: null,
        initialized: false,
    })
    apiHandle = createElectronApiMock({
        plugin: {
            list: vi.fn(async () => []),
            getRealCounts: vi.fn(async () => ({})),
        },
    })
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('PluginDialog capability 刷新接线', () => {
    it('挂载即拉取插件列表，capability:changed 广播单独即可触发重取', async () => {
        renderWithStores(<PluginDialog/>, {api: apiHandle.api})
        const list = apiHandle.api.plugin.list as ReturnType<typeof vi.fn>

        await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
        expect(apiHandle.capabilityListenerCount()).toBe(1)

        act(() => apiHandle.emitCapabilityChanged())

        await waitFor(() => expect(list.mock.calls.length).toBe(2))
    })

    it('空列表渲染 EmptyState 文案', async () => {
        const {getByText} = renderWithStores(<PluginDialog/>, {api: apiHandle.api})
        await waitFor(() => expect(getByText('暂无已安装插件')).toBeTruthy())
    })

    it('渲染插件卡片并可展开详情（懒加载能力明细）', async () => {
        const fixture = {
            name: 'demo-plugin',
            source: 'github',
            path: '/plugins/demo',
            manifest: {name: 'demo-plugin', version: '1.0.0', description: '演示插件'},
            enabled: true,
            isBuiltin: false,
            commands: [{id: 'cmd:demo', name: 'demo'}],
        }
        const getCapabilityDetails = vi.fn(async () => ({skills: [{name: 'demo-skill', description: '演示技能描述'}], agents: [], mcps: []}))
        const api = createElectronApiMock({
            plugin: {
                list: vi.fn(async () => [fixture]),
                getRealCounts: vi.fn(async () => ({'demo-plugin': {skills: 1, agents: 0, mcps: 0}})),
                getCapabilityDetails,
                getVersions: vi.fn(async () => ({tags: [], branches: [], current: '1.0.0', latest: '', loading: false})),
            },
        })

        const {getByText, container} = renderWithStores(<PluginDialog/>, {api: api.api})
        await waitFor(() => expect(getByText('demo-plugin')).toBeTruthy())

        const toggle = container.querySelector('[data-name="collapsible-section-button"]') as HTMLElement
        expect(toggle).toBeTruthy()
        fireEvent.click(toggle)

        await waitFor(() => expect(getCapabilityDetails).toHaveBeenCalledWith('demo-plugin'))

        // 分类区块默认展开（前 N 条预览），懒加载到的明细立即可见
        await waitFor(() => expect(getByText('技能')).toBeTruthy())
        await waitFor(() => expect(getByText('demo-skill')).toBeTruthy())
    })
})
