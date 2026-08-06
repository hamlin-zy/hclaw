/**
 * toolCallsStore.appendSubAgentStream 单元测试（Task 2：500 条滑动窗口）
 *
 * 覆盖：
 * - 连续 text 条目合并（逐 token 流式输出合并为单条 entry）
 * - 非 text 条目（tool_use/thinking 等）不合并，正常追加
 * - 500 条以内正常追加，长度随追加增长
 * - 第 501 条触发截断：数组长度 ≤ 500+1（marker），最旧条目被移除
 * - 截断标记 _truncationMarker 存在且只出现一次（继续追加不重复插入）
 * - 合并后仍保留流式顺序（text 合并发生在尾部）
 *
 * toolCallsStore 仅依赖 zustand，无需 mock 其他模块。
 */
import {describe, expect, it, beforeEach} from 'vitest'
import {useToolCallsStore, type SubAgentStreamEntry} from '../../../src/renderer/stores/toolCallsStore'

const TOOL_CALL_ID = 'tc-stream-1'

function textEntry(content: string, timestamp = 0): SubAgentStreamEntry {
    return {type: 'text', content, timestamp}
}

function thinkingEntry(content: string, timestamp = 0): SubAgentStreamEntry {
    return {type: 'thinking', content, timestamp}
}

function toolUseEntry(id = 't1', timestamp = 0): SubAgentStreamEntry {
    return {type: 'tool_use', toolName: 'bash', toolArgs: {cmd: 'echo hi'}, timestamp}
}

/** 读取指定 toolCall 的 subAgentStream（不存在则返回 undefined） */
function getStream(): SubAgentStreamEntry[] | undefined {
    return useToolCallsStore.getState().states[TOOL_CALL_ID]?.subAgentStream
}

beforeEach(() => {
    useToolCallsStore.setState({states: {}})
})

describe('appendSubAgentStream — 500 条滑动窗口', () => {
    it('连续 text 条目合并：追加 content 而非新建 entry', () => {
        const store = useToolCallsStore.getState()
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry('Hello'))
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry(' world'))
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry('!'))

        const stream = getStream()!
        expect(stream).toHaveLength(1)
        expect(stream[0].type).toBe('text')
        expect(stream[0].content).toBe('Hello world!')
    })

    it('非 text 条目不合并，正常追加', () => {
        const store = useToolCallsStore.getState()
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry('先文本'))
        store.appendSubAgentStream(TOOL_CALL_ID, toolUseEntry('t1'))
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry('后文本'))

        const stream = getStream()!
        expect(stream).toHaveLength(3)
        expect(stream.map(e => e.type)).toEqual(['text', 'tool_use', 'text'])
        // 文本合并仅发生在"尾部连续 text"：第 1 个 text 与第 3 个 text 被 tool_use 隔开，不合并
        expect(stream[0].content).toBe('先文本')
        expect(stream[2].content).toBe('后文本')
    })

    it('500 条以内正常追加，长度增长', () => {
        const store = useToolCallsStore.getState()
        for (let i = 0; i < 500; i++) {
            store.appendSubAgentStream(TOOL_CALL_ID, thinkingEntry(`t${i}`, i))
        }
        const stream = getStream()!
        expect(stream).toHaveLength(500)
        // 顺序保留（无截断）
        expect(stream[0].content).toBe('t0')
        expect(stream[499].content).toBe('t499')
    })

    it('第 501 条触发截断：长度 ≤ 501（500+marker），最旧条目被移除', () => {
        const store = useToolCallsStore.getState()
        for (let i = 0; i < 501; i++) {
            store.appendSubAgentStream(TOOL_CALL_ID, thinkingEntry(`t${i}`, i))
        }
        const stream = getStream()!
        // 500 条上限 + 1 条截断标记
        expect(stream.length).toBeLessThanOrEqual(501)
        // 最旧的 1 条（t0）被移除
        expect(stream.some(e => e.content === 't0')).toBe(false)
        // 最新条目保留在尾部
        expect(stream[stream.length - 1].content).toBe('t500')
    })

    it('截断标记 _truncationMarker 存在且只出现一次，继续追加不重复插入', () => {
        const store = useToolCallsStore.getState()
        for (let i = 0; i < 501; i++) {
            store.appendSubAgentStream(TOOL_CALL_ID, thinkingEntry(`t${i}`, i))
        }

        // 首次截断后标记存在
        const markerCount = () => getStream()!.filter(e => (e as any)._truncationMarker).length
        expect(markerCount()).toBe(1)

        // 继续追加 30 条（模拟长流式继续输出）：长度稳定在 501，标记始终只出现一次
        for (let i = 501; i < 531; i++) {
            store.appendSubAgentStream(TOOL_CALL_ID, thinkingEntry(`t${i}`, i))
        }
        const stream = getStream()!
        expect(stream.length).toBeLessThanOrEqual(501)
        expect(markerCount()).toBe(1)
        // 最新内容仍在尾部
        expect(stream[stream.length - 1].content).toBe('t530')
    })

    it('合并后仍保留流式顺序（text 合并发生在尾部）', () => {
        const store = useToolCallsStore.getState()
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry('思考后'))
        store.appendSubAgentStream(TOOL_CALL_ID, toolUseEntry('t1'))
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry('继续'))
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry('输出'))

        const stream = getStream()!
        // tool_use 打断了前面的 text 合并；末尾两个 text 连续合并
        expect(stream).toHaveLength(3)
        expect(stream[0]).toMatchObject({type: 'text', content: '思考后'})
        expect(stream[1]).toMatchObject({type: 'tool_use', toolName: 'bash'})
        expect(stream[2]).toMatchObject({type: 'text', content: '继续输出'})
    })
})
