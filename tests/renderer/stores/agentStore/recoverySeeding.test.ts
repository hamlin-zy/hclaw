// @vitest-environment jsdom
/**
 * planRecovery — 崩溃恢复播种决策（P1-改动3）单元测试
 *
 * 缺陷：recoverSessions 以 DB 最后一条 assistant 消息的 metadata.content 播种
 * 流式状态。assistant 正文不存 metadata（只在 blocks）→ 崩溃后 streamBuffer
 * 恒为空 → 空白幽灵气泡；当前轮消息行未落库时会错位选中上一条历史消息。
 *
 * 修复：以主进程流快照为唯一事实源——快照存在则以快照 id/内容播种；
 * DB 中 running 但快照不含的工具（结果在崩溃窗口丢失）标记取消；
 * 快照中 running 的工具保持运行态。
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
})

describe('planRecovery — 快照存在（worker 存活，权威事实源）', () => {
    it('以快照 id/全文/思考播种，不使用 DB metadata.content', () => {
        const plan = planRecovery(SNAP('msg-live', '跨段全文', {think: '思考全文'}), [
            assistantMsg('msg-old'),
            assistantMsg('msg-live'),
        ])
        expect(plan.seed).toEqual({
            streamingMessageId: 'msg-live',
            streamBuffer: '跨段全文',
            thinkingContent: '思考全文',
        })
    })

    it('DB 行未建（首 flush 前崩溃）：仍按快照 id 播种，由调用方占位', () => {
        const plan = planRecovery(SNAP('msg-live', '正文'), [assistantMsg('msg-old')])
        expect(plan.seed?.streamingMessageId).toBe('msg-live')
    })

    it('工具状态：快照中的 running 工具 → live；DB 中 running 但快照不含 → stale（结果丢失）', () => {
        const plan = planRecovery(
            SNAP('msg-live', '', {tools: [runningTool('tc-live')]}),
            [assistantMsg('msg-live', [runningTool('tc-lost'), runningTool('tc-live')])],
        )
        expect(plan.liveToolIds).toEqual(['tc-live'])
        expect(plan.staleToolIds).toEqual(['tc-lost'])
    })

    it('无思考内容时 thinkingContent 为 null（不残留旧值）', () => {
        const plan = planRecovery(SNAP('msg-live', '正文'), [])
        expect(plan.seed!.thinkingContent).toBeNull()
    })

    it('空内容快照（首 token 前）也播种：保证后续事件按 id 正确挂靠', () => {
        const plan = planRecovery(SNAP('msg-live'), [])
        expect(plan.seed).toEqual({
            streamingMessageId: 'msg-live',
            streamBuffer: '',
            thinkingContent: null,
        })
    })
})

describe('planRecovery — 快照不存在（pending 未建）', () => {
    it('DB 中仍有进行中（endedAt 为空）的 assistant 残留消息 → 复用其 id 作为恢复载体（防幽灵）', () => {
        // ★ 修复：首 token 前崩溃 + DB 已落库残留消息（块级增量在流式期间写库），
        //   应复用该消息 id，而非丢弃让下一轮生成新 id（幽灵双写）。
        const plan = planRecovery(null, [assistantMsg('msg-inflight', undefined, undefined)])
        expect(plan.seed).toEqual({
            streamingMessageId: 'msg-inflight',
            streamBuffer: '',
            thinkingContent: null,
        })
    })

    it('全为已结束（endedAt 已写）历史消息 → seed 为 null（不指向历史，防错位）', () => {
        const plan = planRecovery(null, [assistantMsg('msg-old', undefined, 1000)])
        expect(plan.seed).toBeNull()
    })

    it('无快照时 DB 中全部 running 工具视为 stale', () => {
        const plan = planRecovery(null, [assistantMsg('msg-old', [runningTool('tc-1'), runningTool('tc-2')])])
        expect(plan.staleToolIds.sort()).toEqual(['tc-1', 'tc-2'])
        expect(plan.liveToolIds).toEqual([])
    })

    it('已完成工具（success/error）不进 stale 名单', () => {
        const done = {...runningTool('tc-done'), status: 'success' as const}
        const plan = planRecovery(null, [assistantMsg('msg-old', [done])])
        expect(plan.staleToolIds).toEqual([])
    })
})
