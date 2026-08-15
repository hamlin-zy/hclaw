// @vitest-environment jsdom
/**
 * useGlobalHotkeys hook 测试
 *
 * 保护：全局快捷键分发逻辑（Ctrl+N 新建会话 / Alt+↑↓ 切换会话 /
 * Ctrl+B 左右栏 / Ctrl+Shift+B / Ctrl+Shift+T 主题 / Esc 中断 Agent / Ctrl+K 命令面板）。
 *
 * 事件通过 document keydown 监听，store 为模块级 zustand 单例。
 * 注意：zustand setState 使用 Object.assign 生成新 state，vi.spyOn 的 mock 会被拷贝进新 state
 * 且 restoreAllMocks 无法恢复，因此用「beforeAll 捕获原始 action + setState 注入/恢复」方案隔离。
 */
import {describe, expect, it, vi, beforeAll, beforeEach, afterEach} from 'vitest'
import {renderHook, act} from '@testing-library/react'
import {useGlobalHotkeys} from '../../../src/renderer/hooks/useGlobalHotkeys'
import {useConversationStore} from '../../../src/renderer/stores/conversationStore'
import {useSidebarStore} from '../../../src/renderer/stores/sidebarStore'
import {useThemeStore} from '../../../src/renderer/stores/themeStore'
import {useAgentStore} from '../../../src/renderer/stores/agentStore'
import {useMenuBarStore} from '../../../src/renderer/stores/menuBarStore'

/** 已挂载 hook 实例集合，afterEach 统一卸载（防止 keydown 监听器跨测试累积） */
let mounted: Array<{unmount: () => void}> = []

function mountHook() {
    const hook = renderHook(() => useGlobalHotkeys())
    mounted.push(hook)
    return hook
}

/** 派发 keydown 事件（挂载后触发 hook 的 document 监听器） */
function pressKey(init: KeyboardEventInit) {
    const evt = new KeyboardEvent('keydown', init)
    act(() => {
        document.dispatchEvent(evt)
    })
    return evt
}

function makeSummary(id: string, overrides: Partial<{parentConvId: string; title: string; updatedAt: number; pinned: boolean}> = {}) {
    return {
        id,
        title: overrides.title ?? id,
        preview: '',
        createdAt: 0,
        updatedAt: overrides.updatedAt ?? 0,
        channel: undefined,
        ...overrides,
    }
}

/** 原始 action 引用（beforeAll 捕获，afterEach 恢复，避免 zustand setState 拷贝导致 mock 污染） */
let origActions: {
    createConversation: typeof useConversationStore.getState.createConversation
    setActiveConversation: typeof useConversationStore.getState.setActiveConversation
    abortAgent: typeof useAgentStore.getState.abortAgent
}

describe('useGlobalHotkeys', () => {
    beforeAll(() => {
        origActions = {
            createConversation: useConversationStore.getState().createConversation,
            setActiveConversation: useConversationStore.getState().setActiveConversation,
            abortAgent: useAgentStore.getState().abortAgent,
        }
    })

    beforeEach(() => {
        mounted = []
        // 重置各 store 状态 + 恢复原始 action
        useConversationStore.setState({
            currentWorkspacePath: null,
            activeConversationId: null,
            workspaces: {},
            loadedMessages: [],
            searchQuery: '',
            createConversation: origActions.createConversation,
            setActiveConversation: origActions.setActiveConversation,
        })
        useSidebarStore.setState({leftCollapsed: false, rightCollapsed: true})
        useMenuBarStore.setState({activeDialog: null})
        useAgentStore.setState({
            toolPopupData: null,
            combinedPopupData: null,
            pendingPermissionConfirm: null,
            workMode: 'primary',
            abortAgent: origActions.abortAgent,
        })
        useThemeStore.setState({theme: 'light'})
    })

    afterEach(() => {
        for (const hook of mounted) {
            hook.unmount()
        }
        mounted = []
        // 恢复 window.dispatchEvent 等 spyOn mock（避免同一属性重复 spyOn 导致 mock.calls 跨测试累积）
        vi.restoreAllMocks()
    })

    it('Ctrl+N 且无工作空间 → 派发 hclaw:new-conversation 事件', () => {
        const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
        mountHook()

        pressKey({key: 'n', ctrlKey: true})

        expect(dispatchSpy.mock.calls.some(([e]) =>
            (e as CustomEvent).type === 'hclaw:new-conversation')).toBe(true)
        // 不调用 createConversation
        expect(dispatchSpy.mock.calls.some(([e]) =>
            (e as CustomEvent).type === 'hclaw:focus-input')).toBe(false)
    })

    it('Ctrl+N 有工作空间 → 调用 createConversation 并在完成后派发焦点事件', async () => {
        useConversationStore.setState({currentWorkspacePath: '/ws'})
        const createMock = vi.fn().mockResolvedValue('conv-1')
        useConversationStore.setState({createConversation: createMock})
        const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
        mountHook()

        pressKey({key: 'n', ctrlKey: true})

        expect(createMock).toHaveBeenCalledTimes(1)
        // 微任务后验证 focus-input 事件
        await act(async () => {
            await Promise.resolve()
        })
        expect(dispatchSpy.mock.calls.some(([e]) =>
            (e as CustomEvent).type === 'hclaw:focus-input')).toBe(true)
    })

    it('Alt+↑ 在顶级会话间切换，跳过子会话', () => {
        const setActiveMock = vi.fn().mockResolvedValue(undefined)
        useConversationStore.setState({
            currentWorkspacePath: '/ws',
            activeConversationId: 'c2',
            workspaces: {
                '/ws': {
                    lastOpenedAt: 0,
                    conversations: [
                        makeSummary('c1', {updatedAt: 3}),
                        makeSummary('c2', {updatedAt: 2}),
                        makeSummary('child', {parentConvId: 'c2', updatedAt: 1}),
                    ],
                },
            },
            setActiveConversation: setActiveMock,
        })
        mountHook()

        pressKey({key: 'ArrowUp', altKey: true})

        // c2 上一级是 c1
        expect(setActiveMock).toHaveBeenCalledWith('c1')
    })

    it('Alt+↓ 在顶级会话间切换', () => {
        const setActiveMock = vi.fn().mockResolvedValue(undefined)
        useConversationStore.setState({
            currentWorkspacePath: '/ws',
            activeConversationId: 'c1',
            workspaces: {
                '/ws': {
                    lastOpenedAt: 0,
                    conversations: [
                        makeSummary('c1', {updatedAt: 3}),
                        makeSummary('c2', {updatedAt: 2}),
                    ],
                },
            },
            setActiveConversation: setActiveMock,
        })
        mountHook()

        pressKey({key: 'ArrowDown', altKey: true})

        expect(setActiveMock).toHaveBeenCalledWith('c2')
    })

    it('Alt+↑ 当前是子会话 → 先切回父会话', () => {
        const setActiveMock = vi.fn().mockResolvedValue(undefined)
        useConversationStore.setState({
            currentWorkspacePath: '/ws',
            activeConversationId: 'child',
            workspaces: {
                '/ws': {
                    lastOpenedAt: 0,
                    conversations: [
                        makeSummary('c1', {updatedAt: 3}),
                        makeSummary('child', {parentConvId: 'c1', updatedAt: 2}),
                    ],
                },
            },
            setActiveConversation: setActiveMock,
        })
        mountHook()

        pressKey({key: 'ArrowUp', altKey: true})

        expect(setActiveMock).toHaveBeenCalledWith('c1')
    })

    it('Alt+↑ 在边界（第一个会话）时不做切换', () => {
        const setActiveMock = vi.fn().mockResolvedValue(undefined)
        useConversationStore.setState({
            currentWorkspacePath: '/ws',
            activeConversationId: 'c1',
            workspaces: {
                '/ws': {
                    lastOpenedAt: 0,
                    conversations: [
                        makeSummary('c1', {updatedAt: 3}),
                        makeSummary('c2', {updatedAt: 2}),
                    ],
                },
            },
            setActiveConversation: setActiveMock,
        })
        mountHook()

        pressKey({key: 'ArrowUp', altKey: true})

        expect(setActiveMock).not.toHaveBeenCalled()
    })

    it('Alt+↓ 在边界（最后一个会话）时不做切换', () => {
        const setActiveMock = vi.fn().mockResolvedValue(undefined)
        useConversationStore.setState({
            currentWorkspacePath: '/ws',
            activeConversationId: 'c2',
            workspaces: {
                '/ws': {
                    lastOpenedAt: 0,
                    conversations: [
                        makeSummary('c1', {updatedAt: 3}),
                        makeSummary('c2', {updatedAt: 2}),
                    ],
                },
            },
            setActiveConversation: setActiveMock,
        })
        mountHook()

        pressKey({key: 'ArrowDown', altKey: true})

        expect(setActiveMock).not.toHaveBeenCalled()
    })

    it('Alt+↑ 仅一个顶级会话时不做切换', () => {
        const setActiveMock = vi.fn().mockResolvedValue(undefined)
        useConversationStore.setState({
            currentWorkspacePath: '/ws',
            activeConversationId: 'c1',
            workspaces: {
                '/ws': {
                    lastOpenedAt: 0,
                    conversations: [
                        makeSummary('c1', {updatedAt: 3}),
                        makeSummary('child', {parentConvId: 'c1', updatedAt: 2}),
                    ],
                },
            },
            setActiveConversation: setActiveMock,
        })
        mountHook()

        pressKey({key: 'ArrowUp', altKey: true})

        expect(setActiveMock).not.toHaveBeenCalled()
    })

    it('Alt+↑ 无活跃会话（currentId 为空）→ 不做切换', () => {
        const setActiveMock = vi.fn().mockResolvedValue(undefined)
        useConversationStore.setState({
            currentWorkspacePath: '/ws',
            activeConversationId: null,
            workspaces: {
                '/ws': {
                    lastOpenedAt: 0,
                    conversations: [
                        makeSummary('c1', {updatedAt: 3}),
                        makeSummary('c2', {updatedAt: 2}),
                    ],
                },
            },
            setActiveConversation: setActiveMock,
        })
        mountHook()

        pressKey({key: 'ArrowUp', altKey: true})

        expect(setActiveMock).not.toHaveBeenCalled()
    })

    it('Ctrl+B 切换左侧栏', () => {
        mountHook()

        pressKey({key: 'b', ctrlKey: true})

        expect(useSidebarStore.getState().leftCollapsed).toBe(true)
    })

    it('Ctrl+Shift+B 切换右侧栏', () => {
        mountHook()

        pressKey({key: 'b', ctrlKey: true, shiftKey: true})

        expect(useSidebarStore.getState().rightCollapsed).toBe(false)
    })

    it('Ctrl+Shift+T 切换主题', async () => {
        // themeStore.toggleTheme 会持久化到 SQLite（updateSettings），mock electronAPI 避免真实调用
        vi.stubGlobal('electronAPI', {
            configWrite: vi.fn().mockResolvedValue(true),
            settingsUpdate: vi.fn().mockResolvedValue({success: true}),
        })
        mountHook()

        pressKey({key: 't', ctrlKey: true, shiftKey: true})

        expect(useThemeStore.getState().theme).toBe('dark')
        vi.unstubAllGlobals()
    })

    it('Ctrl+N 时 Shift 修饰 → 不触发（仅 Ctrl+N）', () => {
        const createMock = vi.fn().mockResolvedValue('conv-1')
        useConversationStore.setState({currentWorkspacePath: '/ws', createConversation: createMock})
        const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
        mountHook()

        pressKey({key: 'n', ctrlKey: true, shiftKey: true})

        expect(createMock).not.toHaveBeenCalled()
        expect(dispatchSpy.mock.calls.some(([e]) =>
            (e as CustomEvent).type === 'hclaw:new-conversation')).toBe(false)
    })

    it('Esc 有活跃会话 → 调用 abortAgent', () => {
        const abortMock = vi.fn().mockResolvedValue(undefined)
        useAgentStore.setState({abortAgent: abortMock})
        useConversationStore.setState({activeConversationId: 'conv-1'})
        mountHook()

        pressKey({key: 'Escape'})

        expect(abortMock).toHaveBeenCalledWith('conv-1')
    })

    it('Esc 无活跃会话 → 不调用 abortAgent', () => {
        const abortMock = vi.fn().mockResolvedValue(undefined)
        useAgentStore.setState({abortAgent: abortMock})
        mountHook()

        pressKey({key: 'Escape'})

        expect(abortMock).not.toHaveBeenCalled()
    })

    it('Esc 有对话框打开（activeDialog）→ 交给对话框自身处理，不中断 Agent', () => {
        const abortMock = vi.fn().mockResolvedValue(undefined)
        useAgentStore.setState({abortAgent: abortMock})
        useMenuBarStore.setState({activeDialog: 'permission-confirm' as any})
        useConversationStore.setState({activeConversationId: 'conv-1'})
        mountHook()

        pressKey({key: 'Escape'})

        expect(abortMock).not.toHaveBeenCalled()
    })

    it('Esc 有工具弹窗打开（toolPopupData）→ 不中断 Agent', () => {
        const abortMock = vi.fn().mockResolvedValue(undefined)
        useAgentStore.setState({abortAgent: abortMock})
        useAgentStore.setState({toolPopupData: {toolName: 'bash', toolCallId: 'tc-1'} as any})
        useConversationStore.setState({activeConversationId: 'conv-1'})
        mountHook()

        pressKey({key: 'Escape'})

        expect(abortMock).not.toHaveBeenCalled()
    })

    it('Esc 有权限确认待处理（pendingPermissionConfirm）→ 不中断 Agent', () => {
        const abortMock = vi.fn().mockResolvedValue(undefined)
        useAgentStore.setState({abortAgent: abortMock})
        useAgentStore.setState({pendingPermissionConfirm: {question: 'test'} as any})
        useConversationStore.setState({activeConversationId: 'conv-1'})
        mountHook()

        pressKey({key: 'Escape'})

        expect(abortMock).not.toHaveBeenCalled()
    })

    it('Ctrl+K 派发命令面板切换事件', () => {
        const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
        mountHook()

        pressKey({key: 'k', ctrlKey: true})

        expect(dispatchSpy.mock.calls.some(([e]) =>
            (e as CustomEvent).type === 'hclaw:toggle-command-palette')).toBe(true)
    })

    it('卸载后移除 keydown 监听器', () => {
        mountHook().unmount()

        // 卸载后再派发不应触发 action
        const abortMock = vi.fn().mockResolvedValue(undefined)
        useAgentStore.setState({abortAgent: abortMock})
        useConversationStore.setState({activeConversationId: 'conv-1'})
        pressKey({key: 'Escape'})

        expect(abortMock).not.toHaveBeenCalled()
    })
})
