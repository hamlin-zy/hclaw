// @vitest-environment jsdom
/**
 * ModelSchemeDialog 激活方案自动选中 · 异步 rehydration 回归
 *
 * 缺陷：selectedSchemeId 由 useState(activeSchemeId) 初始化，
 * 但 zustand persist 的 sqliteStorage 是异步的——组件挂载时 activeSchemeId 还是 null，
 * rehydrate 后变为真实值时，没有任何 effect 将 selectedSchemeId 同步过去，
 * 导致右侧面板始终显示「请选择或创建一个方案」。
 *
 * 本测试模拟：先挂载（store 初始空），再 setState 注入 schemes + activeSchemeId
 * （等价于异步 rehydrate 完成），验证右侧面板自动切换到激活方案编辑视图。
 */
import {describe, it, expect, afterEach} from 'vitest'
import {render, cleanup, waitFor} from '@testing-library/react'
import ModelSchemeDialog from '../../../../src/renderer/components/dialogs/ModelSchemeDialog'
import {useModelSchemeStore} from '../../../../src/renderer/stores/modelSchemeStore'
import type {ModelScheme} from '@shared/types'

afterEach(() => {
    cleanup()
    // 重置 store 到初始状态，避免影响其他测试
    useModelSchemeStore.setState({
        schemes: [],
        activeSchemeId: null,
    })
})

function makeScheme(name: string): ModelScheme {
    return {
        id: crypto.randomUUID(),
        name,
        roles: [
            {id: crypto.randomUUID(), role: 'primary', endpointId: 'p1', modelId: 'm1', modelType: 'text', enabled: true},
            {id: crypto.randomUUID(), role: 'lightweight', endpointId: '', modelId: '', modelType: 'text', enabled: false},
            {id: crypto.randomUUID(), role: 'reasoning', endpointId: '', modelId: '', modelType: 'text', enabled: false},
        ],
        enabled: true,
    }
}

describe('ModelSchemeDialog / 激活方案自动选中（异步 rehydration）', () => {
    it('store rehydrate 后右侧面板自动显示激活方案（空状态消失）', async () => {
        // Step 1: 挂载时 store 为空（模拟异步 rehydrate 尚未完成）
        const {container} = render(<ModelSchemeDialog/>)

        // 挂载后右侧面板应显示空状态
        expect(container.textContent).toContain('请选择或创建一个方案')

        // Step 2: 模拟 rehydrate 完成——store 获得真实 schemes + activeSchemeId
        const scheme = makeScheme('我的激活方案')
        useModelSchemeStore.setState({
            schemes: [scheme],
            activeSchemeId: scheme.id,
        })

        // Step 3: 右侧面板的空状态文案应消失（说明 selectedSchemeId 已自动同步）
        await waitFor(() => {
            expect(container.textContent).not.toContain('请选择或创建一个方案')
        })
    })
})
