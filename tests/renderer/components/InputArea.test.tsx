// @vitest-environment jsdom
/**
 * InputArea 能力内联选择测试
 *
 * 覆盖：
 * 1. 选中能力 → 输入正文 → 回车 → metadata 正确携带 → selectedCapability 清除
 * 2. skill 类型 displayMessage 带 / 前缀
 * 3. agent 类型 displayMessage 不带 / 前缀（含空格名不被截断）
 * 4. × 清除按钮移除徽标
 * 5. CommandPalette 回车选中能力后焦点回到主输入框
 * 6. 点击徽标本体重开 CommandPalette
 * 7. / 前缀检测解析成功时清除 selectedCapability
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, cleanup, waitFor} from '@testing-library/react'
import React from 'react'

// ── Mock stores ──────────────────────────────────────────────
const agentStoreState: any = {
    convAgentStates: {},
    startAgent: vi.fn(),
    abortAgent: vi.fn(),
    updateConvData: vi.fn(),
}
vi.mock('@/renderer/stores/agentStore', () => ({
    useAgentStore: Object.assign(
        vi.fn((selector: (s: any) => any) => selector(agentStoreState)),
        {getState: () => agentStoreState}
    ),
}))

const conversationStoreState: any = {
    activeConversationId: 'conv-1',
    addMessage: vi.fn(),
    createConversation: vi.fn(),
    setActiveConversation: vi.fn(),
    updateConversationMeta: vi.fn(),
    handoffDismissed: {},
    workspaces: {},
    currentWorkspacePath: null,
}
vi.mock('@/renderer/stores/conversationStore', () => ({
    useConversationStore: Object.assign(
        vi.fn((selector: (s: any) => any) => selector(conversationStoreState)),
        {getState: () => conversationStoreState}
    ),
}))

const llmStoreState = {
    providers: [{id: 'p1', models: [{id: 'm1', name: 'TestModel'}]}],
    activeProviderId: 'p1',
    activeModelId: 'm1',
}
vi.mock('@/renderer/stores/llmStore', () => ({
    useLLMStore: Object.assign(
        vi.fn((selector: (s: any) => any) => selector(llmStoreState)),
        {getState: () => llmStoreState}
    ),
}))

const inputHistoryState = {pushEntry: vi.fn()}
vi.mock('@/renderer/stores/inputHistoryStore', () => ({
    useInputHistoryStore: Object.assign(vi.fn(), {getState: () => inputHistoryState}),
}))

const settingsStoreState = {settings: {agent: {handoffThresholdRatio: 0}}}
vi.mock('@/renderer/stores/settingsStore', () => ({
    useSettingsStore: Object.assign(
        vi.fn((selector: (s: any) => any) => selector(settingsStoreState)),
        {getState: () => settingsStoreState}
    ),
}))

// ── Mock child components ─────────────────────────────────────
vi.mock('@/renderer/components/ModelAlertDialog', () => ({default: () => null}))
vi.mock('@/renderer/components/AttachedFilesBar', () => ({default: () => null}))
vi.mock('@/renderer/components/TodoStrip', () => ({default: () => null}))
vi.mock('@/renderer/components/PendingQuestionCard', () => ({default: () => null}))
vi.mock('@/renderer/components/InputToolbar', () => ({
    default: ({onSubmit, onOpenCommandPalette}: {onSubmit: () => void; onOpenCommandPalette: () => void}) => (
        <div>
            <button data-name="input-toolbar-submit" onClick={onSubmit}>发送</button>
            <button data-name="input-toolbar-cmdk" onClick={onOpenCommandPalette}>CmdK</button>
        </div>
    ),
}))
vi.mock('@/renderer/components/ConvModeSegs', () => ({default: () => null}))
vi.mock('@/renderer/components/HandoffDialog', () => ({HandoffDialog: () => null, type: {}}))
vi.mock('@/renderer/components/PhrasePicker', () => ({default: () => null}))
vi.mock('@/renderer/components/common/ImagePreviewModal', () => ({default: () => null}))
vi.mock('@/renderer/hooks/usePhrasePicker', () => ({
    usePhrasePicker: () => ({open: false, openOnShortcut: () => {}, close: () => {}}),
    pickPhraseInto: vi.fn(),
}))
vi.mock('@/renderer/services/shortcutManager', () => ({
    shortcutManager: {subscribe: () => () => {}, handleKeyDown: () => false, on: () => () => {}},
}))

// Mock framer-motion — 过滤掉动画属性避免 React 警告
vi.mock('framer-motion', () => ({
    motion: {
        div: ({children, className, onClick, onKeyDown, tabIndex, initial, animate, exit, transition, ...props}: any) => (
            <div className={className} onClick={onClick} onKeyDown={onKeyDown} tabIndex={tabIndex} {...props}>{children}</div>
        ),
    },
    AnimatePresence: ({children}: any) => <>{children}</>,
}))

// Mock CommandList to avoid IPC
vi.mock('@/renderer/components/plugin/CommandList', () => ({
    CommandList: ({onCommandClick, onCommandsLoaded, onFilteredCommandsChange}: any) => {
        const commands = [
            {id: 'cmd:deploy', name: 'deploy', description: '部署命令', hasArgs: true, source: 'user'},
            {id: 'tdd', name: 'tdd', description: 'TDD', hasArgs: false, source: 'skill'},
            {id: 'agent:local-general', name: 'General Agent', description: '通用', hasArgs: false, source: 'agent'},
        ]
        React.useEffect(() => {
            onCommandsLoaded?.(commands)
            onFilteredCommandsChange?.(commands)
        }, [])
        return (
            <div>
                {commands.map((cmd: any) => (
                    <button
                        key={cmd.id}
                        data-name={`command-palette-item-${cmd.id}`}
                        onClick={() => onCommandClick(cmd)}
                    >
                        {cmd.name}
                    </button>
                ))}
            </div>
        )
    },
}))

import InputArea from '@/renderer/components/InputArea'

beforeEach(() => {
    agentStoreState.convAgentStates = {}
    agentStoreState.startAgent.mockReset()
    agentStoreState.abortAgent.mockReset()
    agentStoreState.updateConvData.mockReset()
    conversationStoreState.addMessage.mockReset()
    conversationStoreState.createConversation.mockReset()
    inputHistoryState.pushEntry.mockReset()

    vi.stubGlobal('electronAPI', {
        commandPrepareMessage: vi.fn().mockResolvedValue('TEMPLATE: $ARGUMENTS'),
        commandResolveByName: vi.fn().mockResolvedValue(null),
        agentInjectMessage: vi.fn().mockResolvedValue({success: true}),
        contextGetUsage: vi.fn().mockResolvedValue(null),
    })
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

describe('InputArea 能力内联选择', () => {
    it('选能力 → 输入 → 回车 → metadata 正确 → selectedCapability 清除', async () => {
        const {getByText, getByPlaceholderText} = render(<InputArea />)

        // 1. 打开 CommandPalette
        fireEvent.click(getByText('CmdK'))
        await waitFor(() => expect(getByText('deploy')).toBeTruthy())

        // 2. 选择 deploy（source='user' → type='user'）
        fireEvent.click(getByText('deploy'))

        // 徽标出现
        await waitFor(() => {
            const badge = document.querySelector('[data-name="capability-badge"]')
            expect(badge).toBeTruthy()
            expect(badge!.textContent).toContain('deploy')
        })

        // 3. 输入正文
        const textarea = getByPlaceholderText('输入你的任务...') as HTMLTextAreaElement
        fireEvent.change(textarea, {target: {value: '部署到生产环境'}})

        // 4. 回车发送
        fireEvent.keyDown(textarea, {key: 'Enter'})

        // 5. 验证 addMessage 含正确 metadata
        await waitFor(() => {
            expect(conversationStoreState.addMessage).toHaveBeenCalledTimes(1)
            const call = conversationStoreState.addMessage.mock.calls[0][0]
            expect(call.content).toBe('/deploy\n部署到生产环境')
            expect(call.metadata).toEqual({
                commandTemplate: 'TEMPLATE: $ARGUMENTS',
                commandId: 'cmd:deploy',
                commandArgs: '部署到生产环境',
            })
        })

        // 6. startAgent 被调用
        expect(agentStoreState.startAgent).toHaveBeenCalledTimes(1)

        // 7. 徽标已清除
        await waitFor(() => {
            expect(document.querySelector('[data-name="capability-badge"]')).toBeNull()
        })
    })

    it('skill 类型 displayMessage 带 / 前缀', async () => {
        const {getByText, getByPlaceholderText} = render(<InputArea />)

        fireEvent.click(getByText('CmdK'))
        await waitFor(() => expect(getByText('tdd')).toBeTruthy())
        fireEvent.click(getByText('tdd'))

        const textarea = getByPlaceholderText('输入你的任务...') as HTMLTextAreaElement
        fireEvent.change(textarea, {target: {value: '写测试'}})
        fireEvent.keyDown(textarea, {key: 'Enter'})

        await waitFor(() => {
            expect(conversationStoreState.addMessage).toHaveBeenCalledTimes(1)
            const call = conversationStoreState.addMessage.mock.calls[0][0]
            expect(call.content).toBe('/tdd\n写测试')
            expect(call.metadata).toEqual({
                commandTemplate: 'TEMPLATE: $ARGUMENTS',
                commandId: 'tdd',
                commandArgs: '写测试',
            })
        })
    })

    it('agent 类型 displayMessage 不带 / 前缀（含空格名不被截断）', async () => {
        const {getByText, getByPlaceholderText} = render(<InputArea />)

        fireEvent.click(getByText('CmdK'))
        await waitFor(() => expect(getByText('General Agent')).toBeTruthy())
        fireEvent.click(getByText('General Agent'))

        const textarea = getByPlaceholderText('输入你的任务...') as HTMLTextAreaElement
        fireEvent.change(textarea, {target: {value: '写测试'}})
        fireEvent.keyDown(textarea, {key: 'Enter'})

        await waitFor(() => {
            expect(conversationStoreState.addMessage).toHaveBeenCalledTimes(1)
            const call = conversationStoreState.addMessage.mock.calls[0][0]
            expect(call.content).toBe('General Agent\n写测试')
            expect(call.metadata).toEqual({
                commandTemplate: 'TEMPLATE: $ARGUMENTS',
                commandId: 'agent:local-general',
                commandArgs: '写测试',
            })
        })
    })

    it('× 清除按钮移除已选能力徽标', async () => {
        const {getByText, getByLabelText} = render(<InputArea />)

        fireEvent.click(getByText('CmdK'))
        await waitFor(() => expect(getByText('deploy')).toBeTruthy())
        fireEvent.click(getByText('deploy'))

        await waitFor(() => {
            expect(document.querySelector('[data-name="capability-badge"]')).toBeTruthy()
        })

        // 点击 ×
        fireEvent.click(getByLabelText('清除已选能力 deploy'))

        await waitFor(() => {
            expect(document.querySelector('[data-name="capability-badge"]')).toBeNull()
        })
    })

    it('CommandPalette 回车选中能力后焦点回到主输入框', async () => {
        const {getByText, getByPlaceholderText} = render(<InputArea />)

        // 打开面板并聚焦面板搜索框（真实面板 autoFocus，jsdom 下手工模拟）
        fireEvent.click(getByText('CmdK'))
        const paletteInput = await waitFor(() => {
            const el = document.querySelector('[data-name="command-palette-input"]') as HTMLInputElement
            expect(el).toBeTruthy()
            return el
        })
        paletteInput.focus()
        expect(document.activeElement).toBe(paletteInput)

        // 回车选中当前高亮项 → 面板关闭 → 焦点必须交还主输入框
        fireEvent.keyDown(paletteInput, {key: 'Enter'})
        const textarea = getByPlaceholderText('输入你的任务...') as HTMLTextAreaElement
        await waitFor(() => {
            expect(document.activeElement).toBe(textarea)
        })
    })

    it('点击徽标本体重开 CommandPalette', async () => {
        const {getByText} = render(<InputArea />)

        // 选能力
        fireEvent.click(getByText('CmdK'))
        await waitFor(() => expect(getByText('deploy')).toBeTruthy())
        fireEvent.click(getByText('deploy'))

        await waitFor(() => {
            expect(document.querySelector('[data-name="capability-badge"]')).toBeTruthy()
        })

        // CommandPalette 应已关闭（选完后自动关）
        // 初始面板里的命令列表应不可见（已关闭）
        expect(document.querySelector('[data-name="command-palette-item-cmd:deploy"]')).toBeNull()

        // 点击徽标本体 → 重开面板
        fireEvent.click(document.querySelector('[data-name="capability-badge"]')!)

        await waitFor(() => {
            expect(document.querySelector('[data-name="command-palette-item-cmd:deploy"]')).toBeTruthy()
        })
    })

    it('已选能力时输入 / 前缀命令 → / 前缀覆盖已选能力并清除徽标', async () => {
        // / 前缀解析成功，返回另一条命令的模板
        (window as any).electronAPI.commandResolveByName.mockResolvedValue({
            commandId: 'cmd:tdd-cmd',
            template: 'TDD_TEMPLATE: $ARGUMENTS',
        })

        const {getByText, getByPlaceholderText} = render(<InputArea />)

        // 先选中 deploy 能力
        fireEvent.click(getByText('CmdK'))
        await waitFor(() => expect(getByText('deploy')).toBeTruthy())
        fireEvent.click(getByText('deploy'))
        await waitFor(() => {
            expect(document.querySelector('[data-name="capability-badge"]')).toBeTruthy()
        })

        // 输入 / 前缀命令（覆盖已选能力）
        const textarea = getByPlaceholderText('输入你的任务...') as HTMLTextAreaElement
        fireEvent.change(textarea, {target: {value: '/tdd-cmd 写测试'}})
        fireEvent.keyDown(textarea, {key: 'Enter'})

        // 走 / 前缀路径：commandResolveByName 被调用，已选能力的 commandPrepareMessage 不被调用
        await waitFor(() => {
            expect((window as any).electronAPI.commandResolveByName).toHaveBeenCalledWith('tdd-cmd', '写测试')
            expect((window as any).electronAPI.commandPrepareMessage).not.toHaveBeenCalled()
            expect(conversationStoreState.addMessage).toHaveBeenCalledTimes(1)
            const call = conversationStoreState.addMessage.mock.calls[0][0]
            expect(call.content).toBe('/tdd-cmd\n写测试')
            expect(call.metadata).toEqual({
                commandTemplate: 'TDD_TEMPLATE: $ARGUMENTS',
                commandId: 'cmd:tdd-cmd',
                commandArgs: '写测试',
            })
        })

        // 徽标已清除
        await waitFor(() => {
            expect(document.querySelector('[data-name="capability-badge"]')).toBeNull()
        })
    })
})
