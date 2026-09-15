// @vitest-environment jsdom
/**
 * conversationStore 渲染层加固 · 切换竞态 / 列表并发（第 2、3 项）回归测试
 *
 * 2) `switchActiveConversation` 的 await 之后仍无条件写「全局」状态：
 *    `applyConvModesToAgentStore`（写 agentStore 顶层 permissionMode/messageDisplayMode）、
 *    `refreshActiveBatch`、`scheduleActiveTruncate`。A→B→A 快速切换时 B 的迟到响应会把
 *    全局模式/定时器改成 B 的。
 * 3) `loadConversations` 无并发锁 + 无条件改写 activeConversationId。
 *
 * 使用真实 zustand store（断言 agentStore 顶层字段与 messagesMap 内容），仅 stub electronAPI。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'

const {getCurrentMock, listMock, readTailMock, readMetaMock, getPermMock, configReadMock} = vi.hoisted(() => ({
    getCurrentMock: vi.fn(),
    listMock: vi.fn(),
    readTailMock: vi.fn(),
    readMetaMock: vi.fn(),
    getPermMock: vi.fn(),
    configReadMock: vi.fn(),
}))

vi.stubGlobal('window', {
    electronAPI: {
        workspace: {getCurrent: getCurrentMock, getGitBranch: vi.fn(async () => null)},
        conversationList: listMock,
        conversationReadTail: readTailMock,
        conversationReadMeta: readMetaMock,
        agentGetPermissionMode: getPermMock,
        configRead: configReadMock,
    },
})

import {useConversationStore} from '../../../src/renderer/stores/conversationStore'
import {useAgentStore} from '../../../src/renderer/stores/agentStore'

const BIG_LEN = 10 * 1024
const BIG_OUTPUT = 'X'.repeat(BIG_LEN)
const TRUNC_PROMPT = '\n\n*(输出过长，已截断。展开加载完整内容)*'

function userMsg(convId: string): Message {
    return {id: `m-u-${convId}`, role: 'user', content: `hi-${convId}`, timestamp: 1}
}

/** 含超大工具结果的消息：用于观察 30s 主动截断定时器指向哪个会话 */
function bigAssistantMsg(convId: string): Message {
    return {
        id: `m-big-${convId}`,
        role: 'assistant',
        content: '正文',
        timestamp: 2,
        toolCalls: [{
            id: `tc-${convId}`,
            name: 'bash',
            arguments: {cmd: 'echo'},
            status: 'success',
            result: {output: BIG_OUTPUT},
        }],
    }
}

/** flush 微任务链（fake timers 下 Promise 链仍走真实微任务队列） */
async function flush(times = 40): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve()
}

beforeEach(() => {
    vi.useFakeTimers()
    getCurrentMock.mockReset().mockResolvedValue({path: '/ws'})
    listMock.mockReset().mockResolvedValue([])
    readTailMock.mockReset().mockResolvedValue({messages: [], totalCount: 0})
    readMetaMock.mockReset().mockResolvedValue(null)
    getPermMock.mockReset().mockResolvedValue('safe')
    configReadMock.mockReset().mockResolvedValue({mode: 'detailed'})

    useAgentStore.setState({permissionMode: 'safe', messageDisplayMode: 'detailed'})
    useConversationStore.setState({
        currentWorkspacePath: '/ws',
        activeConversationId: null,
        workspaces: {'/ws': {lastOpenedAt: 0, conversations: []}},
        messagesMap: {},
        loadedMessages: [],
        hasMoreMap: {},
        loadingMoreMap: {},
        renderedConversationIds: [],
        conversationLastActiveAt: {},
    })
})

afterEach(() => {
    vi.useRealTimers()
})

// ─────────────────────────────────────────────────────────
// 2) 切换竞态：迟到响应不得改写全局状态
// ─────────────────────────────────────────────────────────

describe('2) switchActiveConversation 竞态防护', () => {
    /**
     * A→B→A 时序（B 的首屏水合响应保持「在途」，直到测试显式放行）：
     *   ① setActiveConversation('a') → active=a，await 在途
     *   ② setActiveConversation('b') → active=b，await 在途
     *   ③ 放行 A 的响应（此刻 active 已是 b）
     *   ④ setActiveConversation('a') → 同步快路径（messagesMap['a'] 已含 user 消息）
     *   ⑤ 放行 B 的迟到响应（此刻 active 已是 a）
     * 返回时 ①~④ 已完成，⑤ 由调用方触发后断言。
     */
    async function runAToBToA() {
        readMetaMock.mockImplementation(async (convId: string) => convId === 'a'
            ? {permissionMode: 'safe', displayMode: 'detailed'}
            : {permissionMode: 'auto', displayMode: 'compact'})

        const deferred = new Map<string, (v: any) => void>()
        readTailMock.mockImplementation((convId: string) => new Promise(r => {
            deferred.set(convId, r)
        }))

        const store = useConversationStore.getState()
        const p1 = store.setActiveConversation('a')
        const p2 = store.setActiveConversation('b')
        expect(deferred.has('a')).toBe(true)
        expect(deferred.has('b')).toBe(true)

        deferred.get('a')!({messages: [userMsg('a')], totalCount: 1})
        await p1
        await flush()

        const p3 = store.setActiveConversation('a')
        await p3
        await flush()

        return {deferred, p2}
    }

    it('B 的迟到响应不得改写 agentStore 全局 permissionMode/messageDisplayMode', async () => {
        const {deferred, p2} = await runAToBToA()

        deferred.get('b')!({messages: [userMsg('b')], totalCount: 1})
        await p2
        await flush()

        // 全局模式必须仍是 A 的（迟到 B 响应不得污染）
        expect(useAgentStore.getState().permissionMode).toBe('safe')
        expect(useAgentStore.getState().messageDisplayMode).toBe('detailed')
    })

    it('B 的迟到响应不得把 30s 主动截断定时器指向 B', async () => {
        const {deferred, p2} = await runAToBToA()

        deferred.get('b')!({messages: [userMsg('b')], totalCount: 1})
        await p2
        await flush()

        // 主动截断定时器必须指向 A：为两个会话补上「尚未截断」的大工具结果，
        // 推进 30s 后只有定时器目标会被截断（水合时已截断的输出无法区分目标，
        // 故此处在水合完成后重新注入未截断的大结果）。
        const seeded = useConversationStore.getState().messagesMap
        useConversationStore.setState({
            messagesMap: {
                ...seeded,
                a: [userMsg('a'), bigAssistantMsg('a')],
                b: [userMsg('b'), bigAssistantMsg('b')],
            },
        })
        vi.advanceTimersByTime(30000)
        await flush()

        const map = useConversationStore.getState().messagesMap
        const outputOf = (convId: string) =>
            map[convId]?.find(m => m.id === `m-big-${convId}`)?.toolCalls?.[0].result?.output as string

        expect(outputOf('a')).toBe(BIG_OUTPUT.slice(0, 2000) + TRUNC_PROMPT)
        expect(outputOf('b')).toBe(BIG_OUTPUT)
    })
})

// ─────────────────────────────────────────────────────────
// 3) loadConversations 并发锁 + active 改写条件
// ─────────────────────────────────────────────────────────

describe('3) loadConversations 并发锁与 active 改写条件', () => {
    const LIST = [
        {id: 'conv-a', title: 'a', workspacePath: '/ws', createdAt: 1, updatedAt: 1},
        {id: 'conv-b', title: 'b', workspacePath: '/ws', createdAt: 2, updatedAt: 2},
        {id: 'conv-root', title: 'root', workspacePath: '/ws', createdAt: 3, updatedAt: 3},
    ]

    it('并发两次调用只发起一次 conversationList 与一次预热（每个会话只读一次）', async () => {
        listMock.mockResolvedValue(LIST)
        readTailMock.mockImplementation(async (convId: string) => ({
            messages: [userMsg(convId)],
            totalCount: 1,
        }))

        const store = useConversationStore.getState()
        const p1 = store.loadConversations()
        const p2 = store.loadConversations()
        await Promise.all([p1, p2])
        await flush(80)

        expect(listMock).toHaveBeenCalledTimes(1)
        expect(getCurrentMock).toHaveBeenCalledTimes(1)

        const ids = readTailMock.mock.calls.map(c => c[0] as string)
        expect(new Set(ids).size).toBe(ids.length) // 无重复读取
        expect(ids.sort()).toEqual(['conv-a', 'conv-b', 'conv-root'])
    })

    it('已有 active 会话时调用不会改写 activeConversationId（onConversationCreated 兜底不打断当前会话）', async () => {
        listMock.mockResolvedValue(LIST)
        useConversationStore.setState({activeConversationId: 'conv-b'})

        await useConversationStore.getState().loadConversations()
        await flush(80)

        expect(useConversationStore.getState().activeConversationId).toBe('conv-b')
    })

    it('无 active 会话（启动）时仍自动选中并加载根会话', async () => {
        listMock.mockResolvedValue(LIST)
        useConversationStore.setState({activeConversationId: null})

        await useConversationStore.getState().loadConversations()
        await flush(80)

        const s = useConversationStore.getState()
        expect(s.activeConversationId).toBe('conv-root')
        expect(s.messagesMap['conv-root']).toBeDefined()
    })
})
