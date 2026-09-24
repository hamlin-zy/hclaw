import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

/** 最小 electronAPI 桩：仅本用例所需 */
const api = {configRead: vi.fn(), configWrite: vi.fn()}

vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))
vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {}, updateConvData: () => {}, removeConvData: () => {},
            flushPendingStreamData: () => {}, reconcileStreamingContent: () => {},
            refreshActiveBatch: () => {}, clearConvDoneUnread: () => {},
        }),
        setState: () => {},
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

import {useConversationStore} from '../../../src/renderer/stores/conversationStore'
import {SECTION_DEFAULT, CHILD_DEFAULT} from '../../../src/renderer/lib/conversationSections'

beforeEach(() => {
    vi.resetAllMocks()
    ;(globalThis as any).window = {electronAPI: {...api, projectGroup: {list: vi.fn(async () => [])}}}
    useConversationStore.setState({
        workspaces: {
            '/ws/a': {lastOpenedAt: 1, conversations: [{id: 'conv-1'}, {id: 'conv-2'}]},
            '/ws/b': {lastOpenedAt: 1, conversations: [{id: 'conv-x'}]},
        },
        currentWorkspacePath: '/ws/a',
        activeConversationId: null,
        viewScope: null,
        collapsedGroupIds: [],
        childWindowSizes: {'conv-1': 9, 'conv-x': 9},
    } as never)
})
afterEach(() => { delete (globalThis as any).window })

describe('setSectionWindowSize — 复位单向传播段 → 子（spec §5.4 L217）', () => {
    it('∧∧∧ 复位（count = 默认）时，该段所有父会话的子窗口一并回默认（清键 = 缺省 CHILD_DEFAULT）', () => {
        useConversationStore.getState().setSectionWindowSize('/ws/a', SECTION_DEFAULT)
        const s = useConversationStore.getState()
        expect(s.sectionWindowSizes['/ws/a']).toBe(SECTION_DEFAULT)
        expect(s.childWindowSizes['conv-1']).toBeUndefined()
        // 其它段的子窗口不受影响
        expect(s.childWindowSizes['conv-x']).toBe(9)
    })

    it('∨∨ / ∧∧（count ≠ 默认）不传播，子窗口保持', () => {
        useConversationStore.getState().setSectionWindowSize('/ws/a', 16)
        const s = useConversationStore.getState()
        expect(s.sectionWindowSizes['/ws/a']).toBe(16)
        expect(s.childWindowSizes['conv-1']).toBe(9)
    })

    it('子会话窗口下限仍为 CHILD_DEFAULT（复位语义之外的覆写不放宽）', () => {
        useConversationStore.getState().setChildWindowSize('conv-2', 1)
        expect(useConversationStore.getState().childWindowSizes['conv-2']).toBe(CHILD_DEFAULT)
    })
})

describe('childWindowSizes 真删回收（不挂 releaseConvCaches，与 doneUnreadIds 同口径）', () => {
    it('deleteConversation 后清掉该会话的子窗口覆写，其它会话不受影响', async () => {
        await useConversationStore.getState().deleteConversation('conv-1')
        const s = useConversationStore.getState()
        expect(s.childWindowSizes['conv-1']).toBeUndefined()
        expect(s.childWindowSizes['conv-x']).toBe(9)
    })

    it('removeWorkspace 后清掉该工作区全部会话的子窗口覆写，其它项目不受影响', async () => {
        const api = (globalThis as any).window.electronAPI
        api.workspace = {
            getByPath: vi.fn(async () => ({id: 'w1', path: '/ws/a'})),
            delete: vi.fn(async () => {}),
        }
        api.conversationListByWorkspace = vi.fn(async () => [{id: 'conv-1'}, {id: 'conv-2'}])
        api.conversationDeleteBatch = vi.fn(async () => {})

        await useConversationStore.getState().removeWorkspace('/ws/a')
        const s = useConversationStore.getState()
        expect(s.childWindowSizes['conv-1']).toBeUndefined()
        expect(s.childWindowSizes['conv-x']).toBe(9)
    })
})
