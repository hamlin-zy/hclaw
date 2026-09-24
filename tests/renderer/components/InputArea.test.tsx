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
 * 8. paused 挂起期 Enter 不穿透（canSend 判定单源化：Enter 与按钮对齐）
 * 9. 积压附件（pendingAttachmentFiles）计入 canSend（修复按钮反向过度禁用）
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
    default: ({onSubmit, onOpenCommandPalette, canSend}: {onSubmit: () => void; onOpenCommandPalette: () => void; canSend?: boolean}) => (
        <div>
            <button data-name="input-toolbar-submit" disabled={!canSend} onClick={onSubmit}>发送</button>
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

/**
 * canSend 判定单源化（Enter 与按钮对齐）
 *
 * 根因：发送按钮受 canSend（含 !isPaused）约束，但 Enter 路径 handleKeyDown
 * 直接调 handleSubmit，不看 canSend → paused 挂起期（ask_user / 权限 / tools
 * 变动三类阻塞弹窗应答前）Enter 提交走空闲分支，消息 addMessage 落库后被
 * startAgent 的 paused 守卫静默吞掉，零反馈。
 *
 * 反向漂移：canSend 只算 attachedFiles、漏 pendingAttachmentFiles（积压附件），
 * 而 handleSubmit 的 hasFiles 含 pending → 积压态下按钮禁用、Enter 却能发。
 *
 * 修复（B+）：① canSend 补 pendingAttachmentFiles；② Enter 分支与 canSend 对齐
 * （preventDefault 保持先于判定：canSend=false 时仍不插入换行，与空输入现状一致）。
 */
describe('InputArea canSend 判定单源化', () => {
    it('paused 挂起期：Enter 不穿透（消息不落库、startAgent 不触发）', async () => {
        agentStoreState.convAgentStates = {
            'conv-1': {agentState: {status: 'paused', mode: 'auto', phase: 'starting'}},
        }
        const {getByPlaceholderText} = render(<InputArea />)

        const textarea = getByPlaceholderText('输入你的任务...') as HTMLTextAreaElement
        fireEvent.change(textarea, {target: {value: '挂起期误发'}})
        fireEvent.keyDown(textarea, {key: 'Enter'})

        // 修复前：空闲分支落库 + startAgent 被 paused 守卫静默吞 → 断言均红
        await waitFor(() => {
            expect(conversationStoreState.addMessage).not.toHaveBeenCalled()
            expect(agentStoreState.startAgent).not.toHaveBeenCalled()
        })
        // 输入内容保留在输入框（零丢失）
        expect(textarea.value).toBe('挂起期误发')
    })

    it('paused 挂起期：发送按钮同步禁用（isPaused 拦截护栏）', async () => {
        agentStoreState.convAgentStates = {
            'conv-1': {agentState: {status: 'paused', mode: 'auto', phase: 'starting'}},
        }
        const {getByPlaceholderText, container} = render(<InputArea />)

        fireEvent.change(getByPlaceholderText('输入你的任务...'), {target: {value: 'x'}})

        const submit = container.querySelector('[data-name="input-toolbar-submit"]') as HTMLButtonElement
        expect(submit.disabled).toBe(true)
    })

    it('积压附件（pending-only）计入 canSend：按钮可用（修复反向过度禁用）', async () => {
        const {getByPlaceholderText, container} = render(<InputArea />)

        // 1. 拖入附件 → attachedFiles
        //    drop 必须打在 onDrop 宿主（内层 input-area-drop-region）上：
        //    打 RTL container（React 树外）或根 [data-input-area]（onDrop 在其子节点，
        //    事件向上冒泡够不到）都不会触发 handleDrop
        const file = new File(['hello'], 'a.txt', {type: 'text/plain'})
        const dropTarget = container.querySelector('[data-name="input-area-drop-region"]') as HTMLElement
        expect(dropTarget).toBeTruthy()
        fireEvent.drop(dropTarget, {dataTransfer: {files: [file]}})
        await waitFor(() => {
            const submit = container.querySelector('[data-name="input-toolbar-submit"]') as HTMLButtonElement
            expect(submit.disabled).toBe(false)
        })

        // 2. 无文字 Enter → 纯附件积压提交 → attached 清空、pending 形成
        fireEvent.keyDown(getByPlaceholderText('输入你的任务...'), {key: 'Enter'})
        await waitFor(() => {
            expect(conversationStoreState.addMessage).toHaveBeenCalledTimes(1)
            expect(conversationStoreState.addMessage.mock.calls[0][0].content).toBe('(附件已保存，请发送指令)')
        })

        // 3. pending-only：修复前 canSend 漏 pending → 按钮禁用（红灯）；修复后可用
        await waitFor(() => {
            const submit = container.querySelector('[data-name="input-toolbar-submit"]') as HTMLButtonElement
            expect(submit.disabled).toBe(false)
        })
    })

    it('护栏：idle + 文本 + Enter 正常发送（canSend 对齐不误伤常规路径）', async () => {
        const {getByPlaceholderText} = render(<InputArea />)

        const textarea = getByPlaceholderText('输入你的任务...') as HTMLTextAreaElement
        fireEvent.change(textarea, {target: {value: '正常发送'}})
        fireEvent.keyDown(textarea, {key: 'Enter'})

        await waitFor(() => {
            expect(conversationStoreState.addMessage).toHaveBeenCalledTimes(1)
            expect(conversationStoreState.addMessage.mock.calls[0][0].content).toBe('正常发送')
            expect(agentStoreState.startAgent).toHaveBeenCalledTimes(1)
        })
        expect(textarea.value).toBe('')
    })

    it('护栏：空输入 + Enter 无动作（现状语义保持）', async () => {
        const {getByPlaceholderText} = render(<InputArea />)

        fireEvent.keyDown(getByPlaceholderText('输入你的任务...'), {key: 'Enter'})

        await waitFor(() => {
            expect(conversationStoreState.addMessage).not.toHaveBeenCalled()
        })
    })
})
