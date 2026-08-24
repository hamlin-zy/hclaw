import {describe, expect, it} from 'vitest'
import {
    accumulateStreamEvent,
    buildStreamSnapshot,
    createPendingMsg,
    finalizePending,
    type StreamSnapshot,
} from '@/main/agent/manager.accumulator'

/**
 * 崩溃恢复流快照（P1-改动4）：渲染进程崩溃重载后，recoverSessions 以主进程
 * 累积器为唯一事实源重建流式状态。快照必须只读——不得消费（finalize）活跃
 * pending，否则后续 text/thinking 事件会因 parts 已清空而丢段。
 */
function makeLivePending() {
    const pending = createPendingMsg()
    pending.id = 'msg-live'
    pending.contentParts = ['第一段', '第二段']
    pending.contentLength = 6
    pending.thinkParts = ['思考A', '思考B']
    pending.thinkLength = 4
    pending.toolCalls.push({
        id: 'tc-A',
        name: 'bash',
        arguments: {},
        status: 'running',
        textOffset: 6,
    })
    return pending
}

describe('buildStreamSnapshot — 只读快照', () => {
    it('pending 为 null（尚未产生任何累积）→ 返回 null', () => {
        expect(buildStreamSnapshot(null)).toBeNull()
    })

    it('返回跨段全文与思考全文（join parts，不依赖 finalize）', () => {
        const pending = makeLivePending()
        const snap = buildStreamSnapshot(pending)!
        expect(snap.streamingMessageId).toBe('msg-live')
        expect(snap.content).toBe('第一段第二段')
        expect(snap.thinkContent).toBe('思考A思考B')
        expect(snap.toolCalls).toHaveLength(1)
        expect(snap.toolCalls[0].status).toBe('running')
    })

    it('只读：不消费 pending 的 parts（后续事件继续累积不受影响）', () => {
        const pending = makeLivePending()
        buildStreamSnapshot(pending)
        expect(pending.contentParts).toEqual(['第一段', '第二段'])
        expect(pending.thinkParts).toEqual(['思考A', '思考B'])
        // finalize 后仍能拿到全文（parts 未被清空）
        expect(finalizePending(pending).content).toBe('第一段第二段')
    })

    it('空累积（仅 id，首 token 前的边界）→ 返回带空内容的快照供 id 对齐', () => {
        const pending = createPendingMsg()
        pending.id = 'msg-empty'
        const snap = buildStreamSnapshot(pending)!
        expect(snap.streamingMessageId).toBe('msg-empty')
        expect(snap.content).toBe('')
        expect(snap.thinkContent).toBeNull()
        expect(snap.toolCalls).toHaveLength(0)
        expect(snap.dbTextBlockCount).toBe(0)
    })

    it('dbTextBlockCount 透传（渲染端以此作为 textSeq 基线，防恢复后块 id 碰撞）', () => {
        const pending = makeLivePending()
        const snap = buildStreamSnapshot(pending, 3)!
        expect(snap.dbTextBlockCount).toBe(3)
    })
})

// ─── 快照 v2：统一恢复路径的状态覆盖面（spec §4.2）──────────────

describe('buildStreamSnapshot v2 — 状态覆盖面扩展', () => {
    it('空 pending 时 v2 字段为安全默认值（非 undefined，渲染端免判空）', () => {
        const snap = buildStreamSnapshot(createPendingMsg())!
        expect(snap.toolStates).toEqual({})
        expect(snap.progressLog).toEqual({})
        expect(snap.subAgentStream).toEqual({})
        expect(snap.pendingQuestion).toBeNull()
        expect(snap.pendingPermissionConfirm).toBeNull()
        expect(snap.runningToolCount).toBe(0)
        expect(snap.executingToolsMessage).toBeNull()
    })

    it('tool_progress / tool_detail 喂入 toolStates', () => {
        let pending = accumulateStreamEvent(null, 'conv-test', {type: 'tool_use', toolCall: {id: 'tc-1', name: 'bash', arguments: {}}})
        pending = accumulateStreamEvent(pending, 'conv-test', {type: 'tool_progress', toolCallId: 'tc-1', progress: '下载中 30%'})
        pending = accumulateStreamEvent(pending, 'conv-test', {type: 'tool_detail', toolCallId: 'tc-1', toolName: 'bash', status: 'running', progress: 30, eta: 5})
        const snap = buildStreamSnapshot(pending)!
        expect(snap.toolStates['tc-1']).toMatchObject({progress: '下载中 30%', progressPercent: 30, eta: 5})
    })

    it('progressLog 由 tool_progress 喂入，上限 200 条 FIFO', () => {
        let pending = accumulateStreamEvent(null, 'conv-test', {type: 'tool_use', toolCall: {id: 'tc-2', name: 'bash', arguments: {}}})
        for (let i = 0; i < 220; i++) {
            pending = accumulateStreamEvent(pending, 'conv-test', {type: 'tool_progress', toolCallId: 'tc-2', progress: `step-${i}`})
        }
        const log = buildStreamSnapshot(pending)!.progressLog['tc-2']!
        expect(log).toHaveLength(200)
        // 最旧的被挤出：首条应为 step-20（前 20 条被 FIFO 挤出）
        expect(JSON.stringify(log[0])).not.toContain('step-0')
        expect(log[0].text).toContain('step-20')
    })

    it('subagent_progress 喂入 subAgentStream，上限 500 条', () => {
        let pending = accumulateStreamEvent(null, 'conv-test', {type: 'subagent_start', taskId: 't-1', description: '子任务'})
        for (let i = 0; i < 510; i++) {
            pending = accumulateStreamEvent(pending, 'conv-test', {type: 'subagent_progress', taskId: 't-1', subAgentEvent: 'log', progress: `#${i}`})
        }
        const stream = buildStreamSnapshot(pending)!.subAgentStream['t-1']!
        expect(stream).toHaveLength(500)
        expect(stream[stream.length - 1].text).toContain('#509')
    })

    it('ask_user / permission_confirm 进入快照，done/error 后清空', () => {
        let pending = accumulateStreamEvent(null, 'conv-test', {type: 'ask_user', question: '选哪个?', options: ['A', 'B']})
        let snap = buildStreamSnapshot(pending)!
        expect(snap.pendingQuestion).toMatchObject({question: '选哪个?'})
        pending = accumulateStreamEvent(pending, 'conv-test', {type: 'permission_confirm', question: '允许执行?'})
        snap = buildStreamSnapshot(pending)!
        expect(snap.pendingPermissionConfirm).toMatchObject({question: '允许执行?'})
        pending = accumulateStreamEvent(pending, 'conv-test', {type: 'done', reason: 'completed'})
        snap = buildStreamSnapshot(pending)!
        expect(snap.pendingQuestion).toBeNull()
        expect(snap.pendingPermissionConfirm).toBeNull()
    })

    it('runningToolCount 随 tools_start/tool_completed 维护并进快照', () => {
        let pending = accumulateStreamEvent(null, 'conv-test', {type: 'tools_start', toolCount: 2})
        pending = accumulateStreamEvent(pending, 'conv-test', {type: 'tool_use', toolCall: {id: 'tc-x', name: 'bash', arguments: {}}})
        let snap = buildStreamSnapshot(pending)!
        expect(snap.runningToolCount).toBeGreaterThan(0)
        pending = accumulateStreamEvent(pending, 'conv-test', {type: 'tool_completed', toolCallId: 'tc-x', result: {output: 'ok', success: true}})
        snap = buildStreamSnapshot(pending)!
        expect(snap.runningToolCount).toBe(0)
    })

    it('v2 快照仍保持只读语义（不消费累积缓冲）', () => {
        let pending = accumulateStreamEvent(null, 'conv-test', {type: 'ask_user', question: 'q'})
        const before = JSON.stringify(pending)
        buildStreamSnapshot(pending)
        expect(JSON.stringify(pending)).toBe(before)
    })

    it('StreamSnapshot 类型包含 v2 必需字段（编译期契约）', () => {
        const snap: StreamSnapshot = {...buildStreamSnapshot(createPendingMsg())!}
        void snap.progressLog
        void snap.subAgentStream
        void snap.toolStates
        expect(true).toBe(true)
    })
})

