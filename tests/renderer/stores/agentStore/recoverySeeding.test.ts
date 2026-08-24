// @vitest-environment jsdom
/**
 * planRecovery — 崩溃恢复播种决策（P1-改动3）单元测试
 *
 * 统一恢复路径（spec §4.2）：planRecovery 仅负责 stale 工具对账（D7 保留）。
 * 快照 v2 → 渲染层状态的完整播种指令由 buildSeedInstruction 构建。
 */
import {describe, expect, it} from 'vitest'
import {planRecovery} from '../../../../src/renderer/stores/agentStore/helpers/recoverySeeding'
import type {Message, ToolCall} from '@shared/types'

function runningTool(id: string): ToolCall {
    return {id, name: 'bash', arguments: {}, status: 'running'}
}

function assistantMsg(id: string, toolCalls?: ToolCall[], endedAt?: number): Message {
    return {
        id, role: 'assistant', content: '', timestamp: 1000,
        ...(toolCalls ? {toolCalls} : {}),
        ...(endedAt != null ? {endedAt} : {}),
    } as Message
}

const SNAP = (id: string, content = '', opts: {think?: string; tools?: ToolCall[]; dbTextBlockCount?: number} = {}) => ({
    streamingMessageId: id,
    content,
    thinkContent: opts.think ?? null,
    toolCalls: opts.tools ?? [],
    dbTextBlockCount: opts.dbTextBlockCount ?? 0,
    toolStates: {},
    progressLog: {},
    subAgentStream: {},
    pendingQuestion: null,
    pendingPermissionConfirm: null,
    runningToolCount: 0,
    executingToolsMessage: null,
})

describe('planRecovery — 快照存在（worker 存活，权威事实源）', () => {
    it('DB 中 running 但快照不含的工具 → stale（结果在崩溃窗口丢失）', () => {
        const plan = planRecovery(
            SNAP('msg-live', '', {tools: [runningTool('tc-live')]}),
            [assistantMsg('msg-live', [runningTool('tc-lost'), runningTool('tc-live')])],
        )
        expect(plan.staleToolIds).toEqual(['tc-lost'])
    })

    it('快照中 running 工具不进 stale 名单', () => {
        const plan = planRecovery(
            SNAP('msg-live', '', {tools: [runningTool('tc-live')]}),
            [assistantMsg('msg-live', [runningTool('tc-live')])],
        )
        expect(plan.staleToolIds).toEqual([])
    })

    it('已完成工具（success/error）不进 stale 名单', () => {
        const done = {...runningTool('tc-done'), status: 'success' as const}
        const plan = planRecovery(
            SNAP('msg-live', '', {tools: [runningTool('tc-live')]}),
            [assistantMsg('msg-live', [done, runningTool('tc-live')])],
        )
        expect(plan.staleToolIds).toEqual([])
    })
})

describe('planRecovery — 快照不存在（pending 未建）', () => {
    it('无快照时 DB 中全部 running/pending 工具视为 stale', () => {
        const plan = planRecovery(null, [assistantMsg('msg-old', [runningTool('tc-1'), runningTool('tc-2')])])
        expect(plan.staleToolIds.sort()).toEqual(['tc-1', 'tc-2'])
    })

    it('已完成工具（success/error）不进 stale 名单', () => {
        const done = {...runningTool('tc-done'), status: 'success' as const}
        const plan = planRecovery(null, [assistantMsg('msg-old', [done])])
        expect(plan.staleToolIds).toEqual([])
    })
})