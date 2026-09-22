/**
 * dispatch 层「isActiveConv 计算源」测试（D1）
 *
 * 已有 agentStore.doneUnread.test.ts 直接调 handleDone(ctx)，isActiveConv 是**手传**的
 * —— 它验证的是 handleDone 的消费口径，验证不了「谁算出 isActiveConv」。
 * 本文件覆盖 dispatch 层 handleStreamEventImpl：
 *   const isActiveConv = convId === useConversationStore.getState().activeConversationId
 * 即「激活态真相来自 conversationStore.activeConversationId」这一链路。
 *
 * 隔离：mock conversationStore（只提供 activeConversationId / workspaces，其余纯函数取
 * importOriginal 真实实现），agentStore 用真实实例（真实 markConvDoneUnread）。
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

import {handleStreamEventImpl} from '../../../src/renderer/stores/agentStore/handlers/streamEvents'
import {useAgentStore} from '../../../src/renderer/stores/agentStore'
import {createDefaultConvData} from '../../../src/renderer/stores/agentStore/defaultState'

const CONV = 'c-dispatch'
const OTHER = 'c-other'

/** 只提供 findConvAcrossWorkspaces 定位用摘要（顶层普通会话） */
const convSummary = (id: string) => ({
    id, title: id, preview: '', createdAt: 0, updatedAt: 0, status: 'active',
})

/** 投递一条 done 事件（走 dispatch 层，不手传 ctx） */
async function dispatchDone(reason = 'completed') {
    await handleStreamEventImpl(
        useAgentStore.setState as any,
        useAgentStore.getState,
        {event: {type: 'done', reason}, conversationId: CONV} as any,
    )
}

beforeEach(() => {
    useAgentStore.setState({
        convAgentStates: {[CONV]: createDefaultConvData()},
        doneUnreadIds: {},
    })
    h.setActive(null)
    h.setWorkspaces({'/ws/a': {lastOpenedAt: 0, conversations: [convSummary(CONV), convSummary(OTHER)]}})
})

describe('handleStreamEventImpl — done 事件的 isActiveConv 计算源（D1）', () => {
    it('activeConversationId 指向别的会话 → 置位（dispatch 自己算出「非激活」）', async () => {
        h.setActive(OTHER)

        await dispatchDone('completed')

        expect(typeof useAgentStore.getState().doneUnreadIds[CONV]).toBe('number')
    })

    it('没有激活会话（null）→ 置位', async () => {
        h.setActive(null)

        await dispatchDone('completed')

        expect(typeof useAgentStore.getState().doneUnreadIds[CONV]).toBe('number')
    })

    it('activeConversationId 就是该会话 → 不置位（用户正看着它）', async () => {
        h.setActive(CONV)

        await dispatchDone('completed')

        expect(useAgentStore.getState().doneUnreadIds[CONV]).toBeUndefined()
    })

    it('非置位 reason（aborted）即便非激活也不置位（口径未被 dispatch 层放宽）', async () => {
        h.setActive(OTHER)

        await dispatchDone('aborted')

        expect(useAgentStore.getState().doneUnreadIds[CONV]).toBeUndefined()
    })
})
