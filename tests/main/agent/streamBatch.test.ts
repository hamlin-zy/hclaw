import {describe, it, expect, vi} from 'vitest'
import {createStreamBatchAccumulator} from '@/main/agent/streamBatch'
import type {AgentStreamEvent} from '@/main/agent/stream'

function makeText(content: string): AgentStreamEvent { return {type: 'text', content} }
function makeToolUse(): AgentStreamEvent {
    return {type: 'tool_use', toolCall: {id: 'tc-1', name: 'bash', arguments: {cmd: 'x'}}}
}

describe('createStreamBatchAccumulator — 内容级合并', () => {
    it('窗口内 N 个 text 合并为 1 条 post（内容拼接）', () => {
        const posts: AgentStreamEvent[] = []
        const acc = createStreamBatchAccumulator({post: (e) => posts.push(e)}, {windowMs: 32})
        acc.push(makeText('你')); acc.push(makeText('好')); acc.push(makeText('！'))
        acc.flush()
        expect(posts).toEqual([{type: 'text', content: '你好！'}])
    })

    it('thinking 合并对称', () => {
        const posts: AgentStreamEvent[] = []
        const acc = createStreamBatchAccumulator({post: (e) => posts.push(e)}, {windowMs: 32})
        acc.push({type: 'thinking', content: '思'}); acc.push({type: 'thinking', content: '考'})
        acc.flush()
        expect(posts).toEqual([{type: 'thinking', content: '思考'}])
    })

    it('other 事件立即透传（不合并、不延迟）', () => {
        const posts: AgentStreamEvent[] = []
        const acc = createStreamBatchAccumulator({post: (e) => posts.push(e)}, {windowMs: 32})
        acc.push(makeText('A')); acc.push(makeToolUse()); acc.push(makeText('B'))
        // tool_use 到达即 flush + post，无需等窗口
        expect(posts).toEqual([{type: 'text', content: 'A'}, makeToolUse()])
        acc.flush()
        expect(posts[2]).toEqual({type: 'text', content: 'B'})
    })

    it('顺序保证：other 前强制 flush 当前 text/thinking batch', () => {
        const posts: AgentStreamEvent[] = []
        const acc = createStreamBatchAccumulator({post: (e) => posts.push(e)}, {windowMs: 32})
        acc.push({type: 'thinking', content: '想'}); acc.push(makeToolUse())
        expect(posts[0]).toEqual({type: 'thinking', content: '想'})  // think 先于 tool_use
        expect(posts[1]).toEqual(makeToolUse())
    })

    it('保序：同窗口 thinking→text 交错按真实到达序 post（不得重排为 text 先）', () => {
        const posts: AgentStreamEvent[] = []
        const acc = createStreamBatchAccumulator({post: (e) => posts.push(e)}, {windowMs: 32})
        acc.push({type: 'thinking', content: '思'})
        acc.push({type: 'thinking', content: '考'})
        acc.push(makeText('A'))
        acc.flush()
        expect(posts).toEqual([
            {type: 'thinking', content: '思考'},
            {type: 'text', content: 'A'},
        ])
    })

    it('保序：text→thinking→text 真交错三段按时间序各自 post', () => {
        const posts: AgentStreamEvent[] = []
        const acc = createStreamBatchAccumulator({post: (e) => posts.push(e)}, {windowMs: 32})
        acc.push(makeText('A'))
        acc.push({type: 'thinking', content: '思'})
        acc.push(makeText('B'))
        acc.flush()
        expect(posts).toEqual([
            {type: 'text', content: 'A'},
            {type: 'thinking', content: '思'},
            {type: 'text', content: 'B'},
        ])
    })

    it('保序：thinking→text→thinking→text 交错按时间序 post 4 段', () => {
        const posts: AgentStreamEvent[] = []
        const acc = createStreamBatchAccumulator({post: (e) => posts.push(e)}, {windowMs: 32})
        acc.push({type: 'thinking', content: 'a'})
        acc.push(makeText('x'))
        acc.push({type: 'thinking', content: 'b'})
        acc.push(makeText('y'))
        acc.flush()
        expect(posts).toEqual([
            {type: 'thinking', content: 'a'},
            {type: 'text', content: 'x'},
            {type: 'thinking', content: 'b'},
            {type: 'text', content: 'y'},
        ])
    })

    it('合并+保序组合：相邻同型 chunk 合并、异型分段时间序不变', () => {
        const posts: AgentStreamEvent[] = []
        const acc = createStreamBatchAccumulator({post: (e) => posts.push(e)}, {windowMs: 32})
        acc.push({type: 'thinking', content: 'a'})
        acc.push({type: 'thinking', content: 'b'})
        acc.push(makeText('x'))
        acc.push(makeText('y'))
        acc.push({type: 'thinking', content: 'c'})
        acc.flush()
        expect(posts).toEqual([
            {type: 'thinking', content: 'ab'},
            {type: 'text', content: 'xy'},
            {type: 'thinking', content: 'c'},
        ])
    })

    it('保序：text→thinking 交替按到达序 post（防反向重排回归）', () => {
        const posts: AgentStreamEvent[] = []
        const acc = createStreamBatchAccumulator({post: (e) => posts.push(e)}, {windowMs: 32})
        acc.push(makeText('A'))
        acc.push({type: 'thinking', content: '思'})
        acc.flush()
        expect(posts).toEqual([
            {type: 'text', content: 'A'},
            {type: 'thinking', content: '思'},
        ])
    })

    it('窗口自动 flush 亦保序（fake timers）', () => {
        vi.useFakeTimers()
        const posts: AgentStreamEvent[] = []
        const acc = createStreamBatchAccumulator({post: (e) => posts.push(e)}, {
            windowMs: 32, setTimeout: setTimeout, clearTimeout: clearTimeout,
        })
        acc.push({type: 'thinking', content: 'a'})
        acc.push(makeText('x'))
        expect(posts).toEqual([])
        vi.advanceTimersByTime(32)
        expect(posts).toEqual([
            {type: 'thinking', content: 'a'},
            {type: 'text', content: 'x'},
        ])
        // 窗口自动 flush 后继续累积，保序语义不丢失
        acc.push({type: 'thinking', content: 'b'})
        acc.push(makeText('y'))
        vi.advanceTimersByTime(32)
        expect(posts).toEqual([
            {type: 'thinking', content: 'a'},
            {type: 'text', content: 'x'},
            {type: 'thinking', content: 'b'},
            {type: 'text', content: 'y'},
        ])
        vi.useRealTimers()
    })

    it('other 事件：透传前交错缓冲按时间序 flush，其后事件继续累积', () => {
        const posts: AgentStreamEvent[] = []
        const acc = createStreamBatchAccumulator({post: (e) => posts.push(e)}, {windowMs: 32})
        acc.push({type: 'thinking', content: 'a'})
        acc.push(makeText('x'))
        acc.push(makeToolUse())
        expect(posts).toEqual([
            {type: 'thinking', content: 'a'},
            {type: 'text', content: 'x'},
            makeToolUse(),
        ])
        acc.push(makeText('y'))
        acc.push({type: 'thinking', content: 'b'})
        acc.flush()
        expect(posts).toEqual([
            {type: 'thinking', content: 'a'},
            {type: 'text', content: 'x'},
            makeToolUse(),
            {type: 'text', content: 'y'},
            {type: 'thinking', content: 'b'},
        ])
    })

    it('窗口到点自动 flush（fake timers）', () => {
        vi.useFakeTimers()
        const posts: AgentStreamEvent[] = []
        const acc = createStreamBatchAccumulator({post: (e) => posts.push(e)}, {
            windowMs: 32, setTimeout: setTimeout, clearTimeout: clearTimeout,
        })
        acc.push(makeText('A')); acc.push(makeText('B'))
        expect(posts).toEqual([])  // 窗口内未发
        vi.advanceTimersByTime(32)
        expect(posts).toEqual([{type: 'text', content: 'AB'}])
        vi.useRealTimers()
    })

    it('空 batch flush 不产生 post（窗口内无事件不空发）', () => {
        const posts: AgentStreamEvent[] = []
        const acc = createStreamBatchAccumulator({post: (e) => posts.push(e)}, {windowMs: 32})
        acc.flush()
        expect(posts).toEqual([])
    })

    it('dispose 清空残留且不再调度', () => {
        const posts: AgentStreamEvent[] = []
        const acc = createStreamBatchAccumulator({post: (e) => posts.push(e)}, {windowMs: 32})
        acc.push(makeText('X'))
        acc.dispose()
        acc.flush()
        expect(posts).toEqual([])
    })

    it('dispose 前 flush 不丢内容（early_exit 路径先 flush 再 dispose）', () => {
        const posts: AgentStreamEvent[] = []
        const acc = createStreamBatchAccumulator({post: (e) => posts.push(e)}, {windowMs: 32})
        acc.push(makeText('尾')); acc.push(makeText('部')); acc.push(makeText('内容'))
        acc.push({type: 'thinking', content: '思考尾部'})
        acc.flush()
        acc.dispose()
        expect(posts).toEqual([
            {type: 'text', content: '尾部内容'},
            {type: 'thinking', content: '思考尾部'},
        ])
    })

    it('直接 dispose 不 flush（缓冲内容被丢弃，文档化模块语义）', () => {
        const posts: AgentStreamEvent[] = []
        const acc = createStreamBatchAccumulator({post: (e) => posts.push(e)}, {windowMs: 32})
        acc.push(makeText('丢弃')); acc.push({type: 'thinking', content: '丢弃思考'})
        acc.dispose()
        expect(posts).toEqual([])
    })
})
