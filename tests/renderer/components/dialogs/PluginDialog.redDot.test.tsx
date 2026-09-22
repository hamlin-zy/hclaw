// @vitest-environment jsdom
/**
 * PluginDialog 红点展示过滤：禁用插件不亮「有新版本可用」。
 *
 * 缺口场景（本用例锁定的回归）：在**禁用**插件上点「同步版本」，
 * 主进程广播 payload 已按启用态过滤，但本窗口的乐观更新
 * `setPluginUpdates({...pluginUpdateMap, [name]: true})` 仍无条件写入 updateMap，
 * 导致该窗口红点照常亮起。
 *
 * 口径（方案 A：展示层封死）：数据保留 —— updateMap 照常写入、手动同步照常可用，
 * 仅在最终展示出口按 plugin.enabled 过滤。
 *
 * 渲染走真实 pluginStore / pluginUpdateStore + electronAPI 替身，
 * 避免 mock 掉 store 使接线被绕过（沿用 PluginDialog.capabilityRefresh 的套路）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {waitFor, act, cleanup, fireEvent} from '@testing-library/react'
import PluginDialog from '../../../../src/renderer/components/dialogs/PluginDialog'
import {usePluginStore} from '../../../../src/renderer/stores/pluginStore'
import {usePluginUpdateStore} from '../../../../src/renderer/stores/pluginUpdateStore'
import {createElectronApiMock, renderWithStores} from '../../helpers/renderWithStores'

const DOT_TITLE = '有新版本可用'

/** 单个 git 源插件 fixture（isBuiltin=false 时才渲染「同步版本」按钮） */
function pluginFixture(name: string, enabled: boolean) {
    return {
        name,
        source: 'github',
        path: `/plugins/${name}`,
        manifest: {name, version: '1.0.0', description: '演示插件'},
        enabled,
        isBuiltin: false,
        commands: [],
    }
}

function apiFor(plugin: ReturnType<typeof pluginFixture>, overrides: Record<string, unknown> = {}) {
    return createElectronApiMock({
        plugin: {
            list: vi.fn(async () => [plugin]),
            getRealCounts: vi.fn(async () => ({})),
            getVersions: vi.fn(async () => ({tags: [], branches: [], current: '1.0.0', latest: '', loading: false})),
            syncVersions: vi.fn(async () => ({
                success: true,
                versionInfo: {tags: [], branches: [], current: '1.0.0', latest: '1.1.0', loading: false, hasUpdate: true},
            })),
            ...overrides,
        },
    })
}

/** 渲染并等到挂载副作用（拉列表 / refreshFromCache）落地，避免异步清空 updateMap 干扰断言 */
async function renderSettled(api: ReturnType<typeof apiFor>, plugin: ReturnType<typeof pluginFixture>) {
    const utils = renderWithStores(<PluginDialog/>, {api: api.api})
    const list = api.api.plugin.list as ReturnType<typeof vi.fn>
    await waitFor(() => expect(list).toHaveBeenCalled())
    await waitFor(() => expect(usePluginStore.getState().loading).toBe(false))
    await act(async () => { await Promise.resolve() })
    return utils
}

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
    usePluginUpdateStore.getState().clear()
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('PluginDialog 红点按启用态过滤', () => {
    it('禁用插件：updateMap 已置 true 也不渲染红点（数据保留、仅展示过滤）', async () => {
        const plugin = pluginFixture('disabled-plugin', false)
        const api = apiFor(plugin)
        const {container} = await renderSettled(api, plugin)

        act(() => {
            usePluginUpdateStore.getState().setPluginUpdates({'disabled-plugin': true})
        })

        await waitFor(() => expect(container.querySelector('[data-name="update-dot"]')).toBeNull())
        // 数据未被丢弃：store 里标记仍在（手动同步/后续启用后仍可用）
        expect(usePluginUpdateStore.getState().updateMap['disabled-plugin']).toBe(true)
    })

    it('对照（防恒假断言）：启用插件 updateMap 置 true → 渲染红点', async () => {
        const plugin = pluginFixture('enabled-plugin', true)
        const api = apiFor(plugin)
        const {container} = await renderSettled(api, plugin)

        act(() => {
            usePluginUpdateStore.getState().setPluginUpdates({'enabled-plugin': true})
        })

        await waitFor(() => expect(container.querySelectorAll('[data-name="update-dot"]').length).toBe(1))
        expect(container.querySelector('[data-name="update-dot"]')?.getAttribute('aria-label')).toBe(DOT_TITLE)
    })

    it('禁用插件点「同步版本」：乐观更新写入 updateMap，但红点仍不亮', async () => {
        const plugin = pluginFixture('disabled-plugin', false)
        const api = apiFor(plugin)
        const {container, getByText} = await renderSettled(api, plugin)

        const syncBtn = container.querySelector('[data-name="plugin-dialog-sync-versions-button"]') as HTMLElement
        expect(syncBtn).toBeTruthy()
        fireEvent.click(syncBtn)

        await waitFor(() => expect(usePluginUpdateStore.getState().updateMap['disabled-plugin']).toBe(true))
        expect(getByText('版本列表已同步')).toBeTruthy()
        expect(container.querySelector('[data-name="update-dot"]')).toBeNull()
    })
})
