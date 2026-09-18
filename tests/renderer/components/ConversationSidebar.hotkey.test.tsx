// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, fireEvent, waitFor, act} from '@testing-library/react'
import fs from 'fs'
import path from 'path'

vi.mock('../../../src/renderer/components/SchemeSelector', () => ({default: () => <div data-testid="scheme"/>}))
vi.mock('../../../src/renderer/services/newConversation', () => ({
    newConversation: vi.fn(async () => 'conv-new'),
}))

import ConversationSidebar from '../../../src/renderer/components/ConversationSidebar'
import {newConversation} from '../../../src/renderer/services/newConversation'
import {useSidebarStore} from '../../../src/renderer/stores/sidebarStore'
import {useConversationStore} from '../../../src/renderer/stores/conversationStore'
import {useLLMStore} from '../../../src/renderer/stores/llmStore'
import {useModelSchemeStore} from '../../../src/renderer/stores/modelSchemeStore'

/**
 * Ctrl+N（`hclaw:new-conversation`）监听必须挂在**常驻**的 ConversationSidebar 上。
 *
 * 原状：监听挂在 NewChatButton 内部，而该按钮在折叠侧栏 / 组视图下不渲染
 * → 监听不存在 → Ctrl+N 静默失效（§15.2-7 要求专门测这一条）。
 * 修复后：监听上移到 ConversationSidebar 顶层，三个新建入口共用 newConversation 服务。
 */

const SIDEBAR_TSX = path.resolve(process.cwd(), 'src/renderer/components/ConversationSidebar.tsx')

/** 取某函数（从 header 起、到顶层 `}` 止）的源码片段 */
function functionBody(src: string, header: string): string {
    const start = src.indexOf(header)
    expect(start, `未找到 ${header}`).toBeGreaterThan(-1)
    const end = src.indexOf('\n}', start)
    expect(end, `${header} 未找到顶层结束括号`).toBeGreaterThan(start)
    return src.slice(start, end)
}

function dispatchNewConversation(): void {
    window.dispatchEvent(new CustomEvent('hclaw:new-conversation'))
}

/** jsdom 下 persist 无数据：把系统状态推到 ready，避免初始化态干扰渲染 */
function makeReadyState(): void {
    useLLMStore.setState({
        hasRehydrated: true,
        providers: [{id: 'p1', name: '测试服务商', type: 'openai', baseUrl: 'http://localhost', enabled: true, models: []} as any],
    })
    useModelSchemeStore.setState({
        hasRehydrated: true,
        schemes: [{id: 's1', name: '测试方案'} as any],
        activeSchemeId: 's1',
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    makeReadyState()
    useSidebarStore.setState({leftCollapsed: false})
    useConversationStore.setState({
        viewScope: null,
        currentWorkspacePath: 'E:/workspace/media/hclaw',
        activeConversationId: null,
        workspaces: {},
    })
})

describe('Ctrl+N 监听上移到 ConversationSidebar', () => {
    it('组视图（顶部大按钮不渲染）下派发事件 → 仍调用 newConversation', () => {
        useConversationStore.setState({viewScope: {type: 'group', groupId: 'pg-a'} as any})
        const {container} = render(<ConversationSidebar/>)
        // 前提：组视图确实没有顶部大按钮（否则这条用例就退回成普通回归）
        expect(container.querySelector('[data-name="conversation-sidebar-new-button"]')).toBeNull()

        dispatchNewConversation()
        expect(newConversation).toHaveBeenCalledTimes(1)
    })

    it('单项目视图下同样生效（回归）', () => {
        useConversationStore.setState({viewScope: {type: 'project', path: 'E:/workspace/media/hclaw'} as any})
        const {container} = render(<ConversationSidebar/>)
        expect(container.querySelector('[data-name="conversation-sidebar-new-button"]')).not.toBeNull()

        dispatchNewConversation()
        expect(newConversation).toHaveBeenCalledTimes(1)
    })

    it('侧栏折叠时派发事件 → 仍调用 newConversation（本任务修掉的静默失效路径）', () => {
        useSidebarStore.setState({leftCollapsed: true})
        const {container} = render(<ConversationSidebar/>)
        // 折叠态没有任何新建按钮
        expect(container.querySelector('[data-name="conversation-sidebar-new-button"]')).toBeNull()

        dispatchNewConversation()
        expect(newConversation).toHaveBeenCalledTimes(1)
    })

    it('顶部大按钮点击 → 同样走 newConversation 服务（单一实现）', () => {
        const {container} = render(<ConversationSidebar/>)
        fireEvent.click(container.querySelector('[data-name="conversation-sidebar-new-button"]') as HTMLElement)
        expect(newConversation).toHaveBeenCalledTimes(1)
    })

    it('事件 → 服务返回 id → 派发一次 hclaw:focus-input（创建成功后聚焦输入框）', async () => {
        vi.mocked(newConversation).mockResolvedValueOnce('conv-new')
        const focusSpy = vi.fn()
        window.addEventListener('hclaw:focus-input', focusSpy)
        try {
            render(<ConversationSidebar/>)

            dispatchNewConversation()

            expect(newConversation).toHaveBeenCalledTimes(1)
            // 焦点事件由消费侧在服务 resolve 后派发（微任务后）
            await waitFor(() => expect(focusSpy).toHaveBeenCalledTimes(1))
        } finally {
            window.removeEventListener('hclaw:focus-input', focusSpy)
        }
    })

    it('服务返回 null（用户取消选目录）→ 不派发 focus-input', async () => {
        vi.mocked(newConversation).mockResolvedValueOnce(null)
        const focusSpy = vi.fn()
        window.addEventListener('hclaw:focus-input', focusSpy)
        try {
            render(<ConversationSidebar/>)

            dispatchNewConversation()

            // 冲掉服务 promise 的 then 微任务（含 0ms 宏任务兜底），确保「不派发」是稳定结论
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0))
            })
            expect(focusSpy).not.toHaveBeenCalled()
        } finally {
            window.removeEventListener('hclaw:focus-input', focusSpy)
        }
    })

    it('无视图作用域（全新用户）仍渲染顶部大按钮 —— 那是选目录的唯一入口', () => {
        useConversationStore.setState({viewScope: null})
        const {container} = render(<ConversationSidebar/>)
        expect(container.querySelector('[data-name="conversation-sidebar-new-button"]')).not.toBeNull()
    })

    it('源码契约：监听在 ConversationSidebar 内，NewChatButton 内不含该事件名', () => {
        const src = fs.readFileSync(SIDEBAR_TSX, 'utf-8')
        expect(functionBody(src, 'export default function ConversationSidebar()')).toContain('hclaw:new-conversation')
        expect(functionBody(src, 'function NewChatButton(')).not.toContain('hclaw:new-conversation')
    })
})
