import {describe, expect, it} from 'vitest'
import {buildStreamSnapshot, createPendingMsg, finalizePending} from '@/main/agent/manager.accumulator'

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
