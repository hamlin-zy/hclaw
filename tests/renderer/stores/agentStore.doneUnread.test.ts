/**
 * 后台会话「完成未读」标记（agentStore.doneUnreadIds）单元测试
 *
 * 契约（brainstorming 拍板口径）：
 * 1. 仅 completed / max_turns_reached 置位；aborted / error / loop_detected /
 *    tools_change_cancelled 一律不置位（用户主动取消不该提醒、错误态另有语义）。
 * 2. done 时该会话即当前激活会话 → 不置位（用户正看着它，不需要补提示）。
 * 3. 子会话（parentConvId 非空）与定时任务会话（channel='schedule'）不置位
 *    ——「子会话排除」「调度会话不提示」两条门禁。
 * 4. completed 且 pendingMessages 非空（收尾后会立刻续跑）不置位；max_turns_reached
 *    不触发续跑（与 handleDone 收尾分支同口径）→ 照常置位。
 *
 * 结构性不变量（本需求核心）：
 * 标记存 agentStore **顶层** doneUnreadIds，而非 convAgentStates[convId] —— 后者会被
 * LRU 驱逐（releaseConvCaches）与 10 分钟渲染清理释放，标记会随之静默消失，
 * 正是本需求要消灭的「信号无声丢失」。
 *
 * 隔离：mock conversationStore（只提供 handleDone 读取的字段），agentStore 用真实实例。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'

const h = vi.hoisted(() => {
    const workspaces: Record<string, any> = {}
    let activeId: string | null = null
    return {
        workspaces,
        setActive(id: string | null) { activeId = id },
        getActive: () => activeId,
        setWorkspaces(ws: Record<string, any>) {
            for (const k of Object.keys(workspaces)) delete workspaces[k]
            Object.assign(workspaces, ws)
        },
    }
})

// 只替换 store 实例；findConvAcrossWorkspaces 等纯函数取真实实现（避免测试里
// 复制一份「摘要定位」逻辑形成第二真相）
vi.mock('../../../src/renderer/stores/conversationStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/renderer/stores/conversationStore')>()),
    useConversationStore: {
        getState: () => ({
            activeConversationId: h.getActive(),
            workspaces: h.workspaces,
            messagesMap: {},
            updateMessageForConv: () => {},
            updateMessage: () => {},
            deleteMessageForConv: () => {},
        }),
    },
}))

import {handleDone} from '../../../src/renderer/stores/agentStore/handlers/streamInteraction'
import {useAgentStore} from '../../../src/renderer/stores/agentStore'
import {createDefaultConvData} from '../../../src/renderer/stores/agentStore/defaultState'
import type {StreamCtx} from '../../../src/renderer/stores/agentStore/handlers/streamContext'

const ROOT = 'c-root'
const CHILD = 'c-child'
const SCHED = 'c-sched'

const convSummary = (id: string, over: Record<string, unknown> = {}) => ({
    id, title: id, preview: '', createdAt: 0, updatedAt: 0, status: 'active', ...over,
})

function makeCtx(convId: string, reason: string, isActiveConv: boolean): StreamCtx {
    return {
        set: () => {},
        get: () => useAgentStore.getState(),
        convId,
        isActiveConv,
        isAgentAborted: false,
        event: {type: 'done', reason},
    } as unknown as StreamCtx
}

/** 写入该会话的运行时数据（默认空数据：streamingMessageId=null → 收尾消息块短路） */
function seedConvData(convId: string, over: Record<string, unknown> = {}) {
    useAgentStore.setState({convAgentStates: {[convId]: {...createDefaultConvData(), ...over}}})
}

beforeEach(() => {
    useAgentStore.setState({convAgentStates: {}, doneUnreadIds: {}})
    h.setActive(null)
    h.setWorkspaces({
        '/ws/a': {
            lastOpenedAt: 0,
            conversations: [
                convSummary(ROOT),
                convSummary(CHILD, {parentConvId: ROOT}),
                convSummary(SCHED, {channel: 'schedule'}),
            ],
        },
    })
})

describe('doneUnreadIds 置位口径', () => {
    it('非激活顶层会话 + completed → 置位（带完成时间戳）', async () => {
        h.setActive('c-other')
        seedConvData(ROOT)
        await handleDone(makeCtx(ROOT, 'completed', false))
        expect(typeof useAgentStore.getState().doneUnreadIds[ROOT]).toBe('number')
    })

    it('非激活顶层会话 + max_turns_reached → 置位', async () => {
        h.setActive('c-other')
        seedConvData(ROOT)
        await handleDone(makeCtx(ROOT, 'max_turns_reached', false))
        expect(useAgentStore.getState().doneUnreadIds[ROOT]).toBeDefined()
    })

    it('done 会话即当前激活会话 → 不置位', async () => {
        h.setActive(ROOT)
        seedConvData(ROOT)
        await handleDone(makeCtx(ROOT, 'completed', true))
        expect(useAgentStore.getState().doneUnreadIds[ROOT]).toBeUndefined()
    })

    it.each(['aborted', 'loop_detected', 'tools_change_cancelled', 'error'])(
        'reason=%s → 不置位',
        async (reason) => {
            h.setActive('c-other')
            seedConvData(ROOT)
            await handleDone(makeCtx(ROOT, reason, false))
            expect(useAgentStore.getState().doneUnreadIds[ROOT]).toBeUndefined()
        },
    )

    it('子会话完成 → 不置位（子会话排除）', async () => {
        h.setActive('c-other')
        seedConvData(CHILD)
        await handleDone(makeCtx(CHILD, 'completed', false))
        expect(useAgentStore.getState().doneUnreadIds[CHILD]).toBeUndefined()
    })

    it('定时任务会话完成 → 不置位', async () => {
        h.setActive('c-other')
        seedConvData(SCHED)
        await handleDone(makeCtx(SCHED, 'completed', false))
        expect(useAgentStore.getState().doneUnreadIds[SCHED]).toBeUndefined()
    })

    it('completed 且 pendingMessages 非空（收尾后立刻续跑）→ 不置位', async () => {
        h.setActive('c-other')
        seedConvData(ROOT, {pendingMessages: [{content: 'queued'}]})
        await handleDone(makeCtx(ROOT, 'completed', false))
        expect(useAgentStore.getState().doneUnreadIds[ROOT]).toBeUndefined()
    })

    it('max_turns_reached 且 pendingMessages 非空（不触发续跑）→ 照常置位', async () => {
        h.setActive('c-other')
        seedConvData(ROOT, {pendingMessages: [{content: 'queued'}]})
        await handleDone(makeCtx(ROOT, 'max_turns_reached', false))
        expect(useAgentStore.getState().doneUnreadIds[ROOT]).toBeDefined()
    })

    it('会话摘要查不到（未加载项目段）→ 按普通顶层会话放行（宁可亮，不可静默不亮）', async () => {
        h.setActive('c-other')
        h.setWorkspaces({})
        seedConvData('c-unknown')
        await handleDone(makeCtx('c-unknown', 'completed', false))
        expect(useAgentStore.getState().doneUnreadIds['c-unknown']).toBeDefined()
    })
})

describe('doneUnreadIds 清除与不变量', () => {
    it('clearConvDoneUnread 只移除目标会话，其余保留', () => {
        useAgentStore.setState({doneUnreadIds: {a: 1, b: 2}})
        useAgentStore.getState().clearConvDoneUnread('a')
        expect(useAgentStore.getState().doneUnreadIds).toEqual({b: 2})
    })

    it('clearConvDoneUnread 对不存在的 convId 不产生新引用（避免无谓渲染）', () => {
        const before = {a: 1}
        useAgentStore.setState({doneUnreadIds: before})
        useAgentStore.getState().clearConvDoneUnread('zzz')
        expect(useAgentStore.getState().doneUnreadIds).toBe(before)
    })

    it('convAgentStates 被释放（LRU 驱逐 / 渲染清理同路径）后标记仍在', async () => {
        h.setActive('c-other')
        seedConvData(ROOT)
        await handleDone(makeCtx(ROOT, 'completed', false))
        // 模拟 releaseConvCaches：会话运行时数据整批丢弃
        useAgentStore.setState({convAgentStates: {}})
        expect(useAgentStore.getState().doneUnreadIds[ROOT]).toBeDefined()
    })
})
