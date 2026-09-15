// @vitest-environment jsdom
/**
 * CommandsDialog 试点验收：能力变更订阅接线（Q13）
 *
 * 覆盖「编辑命令保存 → 主进程广播 capability:changed → 页面自动重新拉取」，
 * 以及独立的「广播即重取」接线断言。使用真实 userCommandStore + electronAPI 替身，
 * 避免 mock 掉 store 导致接线被绕过。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {screen, fireEvent, waitFor, act, cleanup} from '@testing-library/react'
import CommandsDialog from '../../../../src/renderer/components/dialogs/CommandsDialog'
import {useUserCommandStore} from '../../../../src/renderer/stores/userCommandStore'
import {createElectronApiMock, renderWithStores, type ElectronApiMock} from '../../helpers/renderWithStores'

const storeCommand = {
    id: 'user:daily',
    name: 'daily',
    description: '写日报',
    content: '请写今日日报',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
}

const capabilityEntry = {
    id: 'user:daily',
    name: 'daily',
    description: '写日报',
    type: 'command' as const,
    source: 'user' as const,
    enabled: true,
    content: '请写今日日报',
    searchText: 'daily',
}

let apiHandle: ElectronApiMock

beforeEach(() => {
    useUserCommandStore.setState({commands: [], loading: false, initialized: false})
    apiHandle = createElectronApiMock({
        command: {
            getUserCommands: vi.fn(async () => ({success: true, data: [storeCommand]})),
            update: vi.fn(async () => ({success: true})),
        },
        capability: {
            getByType: vi.fn(async () => [capabilityEntry]),
        },
    })
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    useUserCommandStore.setState({commands: [], loading: false, initialized: false})
})

describe('CommandsDialog capability 刷新接线', () => {
    it('编辑命令保存 → 触发 capability:changed → 页面自动重新拉取', async () => {
        renderWithStores(<CommandsDialog/>, {api: apiHandle.api})
        const getByType = apiHandle.api.capability.getByType as ReturnType<typeof vi.fn>

        // 初次挂载即拉取
        await waitFor(() => expect(getByType).toHaveBeenCalledTimes(1))

        // 打开编辑弹窗（本地用户命令卡片上的编辑按钮）
        const editBtn = await waitFor(() => {
            const el = document.querySelector('[data-name="commands-dialog-edit-button"]')
            if (!el) throw new Error('edit button not ready')
            return el as HTMLElement
        })
        fireEvent.click(editBtn)

        const textarea = await screen.findByPlaceholderText(/命令模板/)
        fireEvent.change(textarea, {target: {value: '编辑后的内容'}})
        fireEvent.click(screen.getByText('保存'))

        // 保存写入落盘（store 乐观更新 + IPC）
        await waitFor(() => expect(apiHandle.api.command.update).toHaveBeenCalledTimes(1))

        // 保存自身触发的刷新先结算，隔离出「广播驱动」的那一次
        await waitFor(() => expect(getByType.mock.calls.length).toBeGreaterThanOrEqual(2))
        const countAfterSave = getByType.mock.calls.length

        // 模拟主进程广播 capability:changed
        act(() => apiHandle.emitCapabilityChanged())

        await waitFor(() => expect(getByType.mock.calls.length).toBeGreaterThan(countAfterSave))
    })

    it('capability:changed 广播单独即可触发页面重取', async () => {
        renderWithStores(<CommandsDialog/>, {api: apiHandle.api})
        const getByType = apiHandle.api.capability.getByType as ReturnType<typeof vi.fn>

        await waitFor(() => expect(getByType).toHaveBeenCalledTimes(1))
        expect(apiHandle.capabilityListenerCount()).toBe(1)

        act(() => apiHandle.emitCapabilityChanged())

        await waitFor(() => expect(getByType.mock.calls.length).toBe(2))
    })
})
