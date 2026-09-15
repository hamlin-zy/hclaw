// @vitest-environment jsdom
/**
 * CommandsDialog 的 PluginGroupCard 迁移到 CollapsibleSection 后
 * 折叠语义、批量按钮 stopPropagation、DOM content model 与 a11y 回归护栏。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, fireEvent, cleanup, waitFor, screen} from '@testing-library/react'
import CommandsDialog from '../../../../src/renderer/components/dialogs/CommandsDialog'
import {useUserCommandStore} from '../../../../src/renderer/stores/userCommandStore'
import {createElectronApiMock, renderWithStores, type ElectronApiMock} from '../../helpers/renderWithStores'

const pluginCaps = [
    {id: 'plugin:demo:a', name: 'cmdA', description: 'A', source: 'plugin' as const, pluginEnabled: true, pluginName: 'demo', hasArgs: false},
    {id: 'plugin:demo:b', name: 'cmdB', description: 'B', source: 'plugin' as const, pluginEnabled: true, pluginName: 'demo', hasArgs: false},
]

let apiHandle: ElectronApiMock

beforeEach(() => {
    useUserCommandStore.setState({commands: [], loading: false, initialized: false})
    apiHandle = createElectronApiMock({
        capability: {getByType: vi.fn(async () => pluginCaps)},
    })
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    useUserCommandStore.setState({commands: [], loading: false, initialized: false})
})

async function openPluginTab() {
    renderWithStores(<CommandsDialog />, {api: apiHandle.api})
    const tab = await screen.findByText('插件')
    fireEvent.click(tab)
    await waitFor(() => {
        expect(document.querySelector('[data-name="commands-dialog-plugin-group-header"]')).toBeTruthy()
    })
}

describe('CommandsDialog / PluginGroupCard 迁移后语义', () => {
    it('初始折叠：header aria-expanded=false，命令卡片不渲染', async () => {
        await openPluginTab()
        const header = document.querySelector('[data-name="commands-dialog-plugin-group-header"]') as HTMLElement
        expect(header.tagName).toBe('DIV')
        expect(header.getAttribute('aria-expanded')).toBe('false')
        expect(document.querySelectorAll('[data-name="commands-dialog-plugin-command-card"]').length).toBe(0)
    })

    it('点击 header → 渲染命令卡片，aria-expanded=true', async () => {
        await openPluginTab()
        fireEvent.click(document.querySelector('[data-name="commands-dialog-plugin-group-header"]')!)
        expect(document.querySelectorAll('[data-name="commands-dialog-plugin-command-card"]').length).toBe(2)
        expect((document.querySelector('[data-name="commands-dialog-plugin-group-header"]') as HTMLElement).getAttribute('aria-expanded')).toBe('true')
    })

    it('批量按钮 e.stopPropagation()：点击后不改变折叠状态', async () => {
        await openPluginTab()
        const batchBtn = document.querySelector('[data-name="commands-dialog-batch-toggle-button"]') as HTMLButtonElement
        expect(batchBtn).toBeTruthy()
        fireEvent.click(batchBtn)
        // 仍处于折叠
        expect(document.querySelectorAll('[data-name="commands-dialog-plugin-command-card"]').length).toBe(0)
        expect((document.querySelector('[data-name="commands-dialog-plugin-group-header"]') as HTMLElement).getAttribute('aria-expanded')).toBe('false')
    })

    it('DOM content model：无 button 嵌套 button；批量 button 无 button 祖先', async () => {
        await openPluginTab()
        expect(document.querySelectorAll('button button').length).toBe(0)
        const batchBtn = document.querySelector('[data-name="commands-dialog-batch-toggle-button"]') as HTMLElement
        expect(batchBtn.parentElement!.closest('button')).toBeNull()
    })

    it('【本轮新增】a11y：header 具备 role=button 与 tabIndex=0', async () => {
        await openPluginTab()
        const header = document.querySelector('[data-name="commands-dialog-plugin-group-header"]') as HTMLElement
        expect(header.getAttribute('role')).toBe('button')
        expect(header.getAttribute('tabindex')).toBe('0')
    })

    it('【本轮新增】键盘：Enter 可展开折叠', async () => {
        await openPluginTab()
        fireEvent.keyDown(document.querySelector('[data-name="commands-dialog-plugin-group-header"]')!, {key: 'Enter'})
        expect(document.querySelectorAll('[data-name="commands-dialog-plugin-command-card"]').length).toBe(2)
        expect((document.querySelector('[data-name="commands-dialog-plugin-group-header"]') as HTMLElement).getAttribute('aria-expanded')).toBe('true')
    })

    it('【本轮新增】键盘：Space 可展开折叠且 preventDefault 防滚动', async () => {
        await openPluginTab()
        const notPrevented = fireEvent.keyDown(document.querySelector('[data-name="commands-dialog-plugin-group-header"]')!, {key: ' '})
        expect(notPrevented).toBe(false)
        expect(document.querySelectorAll('[data-name="commands-dialog-plugin-command-card"]').length).toBe(2)
    })

    it('【本轮新增】键盘：内层批量按钮上的 Enter / Space 不触发外层折叠', async () => {
        await openPluginTab()
        const batchBtn = document.querySelector('[data-name="commands-dialog-batch-toggle-button"]') as HTMLButtonElement
        fireEvent.keyDown(batchBtn, {key: 'Enter'})
        fireEvent.keyDown(batchBtn, {key: ' '})
        expect(document.querySelectorAll('[data-name="commands-dialog-plugin-command-card"]').length).toBe(0)
        expect((document.querySelector('[data-name="commands-dialog-plugin-group-header"]') as HTMLElement).getAttribute('aria-expanded')).toBe('false')
    })

    it('【本轮新增】noMargin：CollapsibleSection 根不携带 mb-[var(--space-relaxed)]，且已无 !mb-0 hack', async () => {
        await openPluginTab()
        const header = document.querySelector('[data-name="commands-dialog-plugin-group-header"]') as HTMLElement
        // header 的父级 = CollapsibleSection 根 div
        const csRoot = header.parentElement as HTMLElement
        expect(csRoot.className).not.toContain('mb-[var(--space-relaxed)]')
        expect(csRoot.className).not.toContain('!mb-0')
    })
})
