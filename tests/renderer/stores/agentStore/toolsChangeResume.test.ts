/**
 * tools 变动弹窗应答后的运行态恢复（修复 C = A + B）
 *
 * 根因链（systematic-debugging Phase 1 取证）：
 * - 三类阻塞弹窗（ask_user / 权限 / tools 变动）经 handleConvEvent 统一置 status='paused'
 * - 应答后的恢复路径不对称：respondQuestion（权限）显式恢复 running，
 *   respondToolsChange 只清 pending 不恢复 status → 滞留 paused
 * - handleAgentStart 守卫仅认 idle（streamCore.ts），settle 后毫秒级到达的
 *   agent_start 对 paused 无效 → 恢复被推迟到 LLM 首包 chunk
 *   （thinkingBatch/textBatch flush 才写 running）
 *
 * 该场景恰好 tools 前缀失配 → prompt 缓存全作废 → 全量 prefill → TTFT 十余秒级，
 * 空窗被放大到肉眼可见：isRunning=false（InputArea 终止按钮消失）+
 * isAgentRunning=false（MessageList statusNote 思考动画消失）→ 用户误判已停止。
 *
 * 修复约定（C = A + B）：
 * A. respondToolsChange：continue/snooze_today → status:'running'（对齐 respondQuestion）；
 *    cancel → 不恢复，交由 done(tools_change_cancelled) 收尾归 idle
 * B. handleAgentStart 守卫放宽 idle || paused → agent_start 到达即恢复
 *
 * 隔离策略：
 * - 用例组 1（respondToolsChange）：真实 useAgentStore + mock conversationStore
 *   （与 agentStore.toolsChangeTopLevel.test.ts 同构），断言真实 store 状态
 * - 用例组 2（handleAgentStart）：mock set/get 替身（与 streamCore.agentStart.providerName.test.ts 同构）
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

// ── conversationStore mock：respondToolsChange / updateConvData 活跃判定依赖 ──
vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => ({activeConversationId: 'conv-1'}),
    },
    flatString: (s: string) => s,
}))

import {useAgentStore} from '../../../../src/renderer/stores/agentStore'
import {handleAgentStart} from '../../../../src/renderer/stores/agentStore/handlers/streamCore'
import {createDefaultConvData, IDLE_STATE} from '../../../../src/renderer/stores/agentStore/defaultState'

const CONV = 'conv-1'
const PENDING = {requestId: 'r-tools-1', added: ['tool_a'], removed: ['tool_b']}
/** 弹窗挂起态：handleConvEvent 只改 status，phase 保留挂起前的值 */
const PAUSED_STATE = {...IDLE_STATE, status: 'paused' as const, phase: 'starting' as const}

/** 预置「弹窗挂起」现场：顶层 + per-conv 双写 pending 与 paused 状态 */
function seedBlockedState() {
    useAgentStore.setState({
        pendingToolsChangeConfirm: PENDING,
        agentState: {...PAUSED_STATE},
        convAgentStates: {
            [CONV]: {
                ...createDefaultConvData(),
                pendingToolsChangeConfirm: PENDING,
                agentState: {...PAUSED_STATE},
            },
        },
    })
}

describe('A: respondToolsChange 应答后恢复运行态', () => {
    beforeEach(() => {
        ;(globalThis as any).window = {
            electronAPI: {agentRespondToolsChange: vi.fn(async () => ({success: true}))},
        }
        seedBlockedState()
    })

    it('continue → status 恢复 running（per-conv 与顶层同步），pending 清空', async () => {
        await useAgentStore.getState().respondToolsChange('continue')

        const s = useAgentStore.getState()
        expect(s.convAgentStates[CONV].agentState.status).toBe('running')
        expect(s.agentState.status).toBe('running')
        expect(s.pendingToolsChangeConfirm).toBeNull()
        expect(s.convAgentStates[CONV].pendingToolsChangeConfirm).toBeNull()
        expect((window as any).electronAPI.agentRespondToolsChange).toHaveBeenCalledWith(
            expect.objectContaining({conversationId: CONV, requestId: 'r-tools-1', decision: 'continue'}),
        )
    })

    it('snooze_today → 同样恢复 running（放行路径，与 continue 同语义）', async () => {
        await useAgentStore.getState().respondToolsChange('snooze_today')

        expect(useAgentStore.getState().convAgentStates[CONV].agentState.status).toBe('running')
    })

    it('cancel → 保持 paused 不抢跑（终态由 done(tools_change_cancelled) 收尾）', async () => {
        await useAgentStore.getState().respondToolsChange('cancel')

        expect(useAgentStore.getState().convAgentStates[CONV].agentState.status).toBe('paused')
        expect(useAgentStore.getState().pendingToolsChangeConfirm).toBeNull()
    })

    it('phase 保留挂起前的值（恢复只动 status，不重置阶段文案）', async () => {
        await useAgentStore.getState().respondToolsChange('continue')

        expect(useAgentStore.getState().convAgentStates[CONV].agentState.phase).toBe('starting')
    })
})

// ── B 组：handleAgentStart 守卫（mock 替身，同 providerName 测试模式） ──
describe('B: handleAgentStart 对 paused 恢复运行态', () => {
    const mockUpdateConvData = vi.fn()
    const mockSet = vi.fn()

    function makeCtxWithStatus(status: string) {
        return {
            set: mockSet,
            get: () => ({
                convAgentStates: {
                    [CONV]: {agentState: {...IDLE_STATE, status, phase: 'starting'}},
                },
                updateConvData: mockUpdateConvData,
            }),
            convId: CONV,
            isAgentAborted: false,
            isActiveConv: true,
            event: {type: 'agent_start', model: 'm', provider: 'p', tools: []},
        }
    }

    beforeEach(() => {
        mockUpdateConvData.mockClear()
        mockSet.mockClear()
    })

    it('paused → agent_start 到达即恢复 running（修复前守卫仅认 idle，此为红灯断言）', () => {
        handleAgentStart(makeCtxWithStatus('paused') as any)

        expect(mockUpdateConvData).toHaveBeenCalledWith(CONV, expect.objectContaining({
            agentState: expect.objectContaining({status: 'running'}),
        }))
    })

    it('idle → 照旧归位 running（既有行为护栏）', () => {
        handleAgentStart(makeCtxWithStatus('idle') as any)

        expect(mockUpdateConvData).toHaveBeenCalledWith(CONV, expect.objectContaining({
            agentState: expect.objectContaining({status: 'running'}),
        }))
    })

    it('running → 不重复重置（既有守卫语义护栏，防无谓 store 写入）', () => {
        handleAgentStart(makeCtxWithStatus('running') as any)

        // turnIndex 递增本身也走 updateConvData（非状态重置），只过滤 agentState 类调用
        const stateWrites = mockUpdateConvData.mock.calls.filter(
            (c) => (c[1] as {agentState?: unknown})?.agentState !== undefined,
        )
        expect(stateWrites).toHaveLength(0)
    })
})
