/**
 * handleToolsChangeConfirm 顶层镜像单元测试
 *
 * 背景（bug 2 根因闭环）：ToolsChangeModal 读取顶层 useAgentStore(s=>s.pendingToolsChangeConfirm)
 * 渲染弹窗，respondToolsChange 也只从顶层读 requestId。而 handleConvEvent 仅写 per-conv 字段、
 * onTopLevelUpdate 是 no-op → 顶层从未被写入非 null → 弹窗永不出现 → renderer 永不应答 →
 * worker 侧无限等待 → 会话死锁。
 *
 * 修复：handleToolsChangeConfirm 在事件会话为活跃会话时经 onTopLevelUpdate 镜像到顶层。
 *
 * 行为约定：
 * 1. 活跃会话收到 tools_change_confirm → 顶层 pendingToolsChangeConfirm 被写入（弹窗可渲染）
 * 2. 非活跃会话 → 顶层保持 null（不镜像；不在当前会话上弹窗，由 per-conv 状态 + 刷新恢复承载）
 * 3. per-conv 字段两种情况下都写入（paused 状态显示等依赖它）
 *
 * 隔离：mock agentStore 索引与 conversationStore，不触碰真实 store 链
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'

// 可检查的迷你 store 实现（vi.hoisted 使 vi.mock 工厂可引用）
const h = vi.hoisted(() => {
    const top: Record<string, any> = {pendingToolsChangeConfirm: null}
    const convStates: Record<string, any> = {}
    let activeId: string | null = null
    return {
        top,
        convStates,
        setActive(id: string | null) { activeId = id },
        getActive: () => activeId,
    }
})

// 仅 mock conversationStore（streamInteraction 用它判断活跃会话）；
// agentStore 使用真实实例，断言真实 store 状态
vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => ({activeConversationId: h.getActive()}),
    },
}))

import {handleToolsChangeConfirm} from '../../../src/renderer/stores/agentStore/handlers/streamInteraction'
import {useAgentStore} from '../../../src/renderer/stores/agentStore'
import type {StreamCtx} from '../../../src/renderer/stores/agentStore/handlers/streamContext'

function makeCtx(convId: string, requestId: string): StreamCtx {
    return {
        convId,
        get: (() => ({})) as any,
        set: (() => {}) as any,
        isAgentAborted: false,
        event: {type: 'tools_change_confirm', requestId, added: ['tool_a'], removed: ['tool_b']},
    } as unknown as StreamCtx
}

describe('handleToolsChangeConfirm（tools 变动确认顶层镜像）', () => {
    beforeEach(() => {
        useAgentStore.setState({pendingToolsChangeConfirm: null, convAgentStates: {}})
        h.setActive(null)
    })

    it('活跃会话：顶层 pendingToolsChangeConfirm 被写入（弹窗可渲染）', async () => {
        h.setActive('conv-a')
        await handleToolsChangeConfirm(makeCtx('conv-a', 'r1'))
        expect(useAgentStore.getState().pendingToolsChangeConfirm).toEqual({
            requestId: 'r1',
            added: ['tool_a'],
            removed: ['tool_b'],
        })
        // per-conv 同步写入（paused 阻塞态显示依赖它）
        const convA = useAgentStore.getState().convAgentStates['conv-a']
        expect(convA.pendingToolsChangeConfirm).toEqual({
            requestId: 'r1',
            added: ['tool_a'],
            removed: ['tool_b'],
        })
        expect(convA.agentState.status).toBe('paused')
    })

    it('非活跃会话：顶层保持 null（不镜像；由 per-conv 状态承载）', async () => {
        h.setActive('conv-other')
        await handleToolsChangeConfirm(makeCtx('conv-a', 'r2'))

        expect(useAgentStore.getState().pendingToolsChangeConfirm).toBeNull()
        // per-conv 仍写入
        expect(useAgentStore.getState().convAgentStates['conv-a'].pendingToolsChangeConfirm?.requestId).toBe('r2')
    })

    it('agent 已中止时不写入任何状态', async () => {
        h.setActive('conv-a')
        const ctx = makeCtx('conv-a', 'r3')
        ;(ctx as any).isAgentAborted = true
        await handleToolsChangeConfirm(ctx)

        expect(useAgentStore.getState().pendingToolsChangeConfirm).toBeNull()
        expect(useAgentStore.getState().convAgentStates['conv-a']).toBeUndefined()
    })
})
