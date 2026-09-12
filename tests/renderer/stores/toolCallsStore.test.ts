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
import {
    useToolCallsStore,
    PROGRESS_LOG_MAX,
    MAX_SUBAGENT_TEXT_LENGTH,
    SUBAGENT_TEXT_TRUNCATION_MARKER,
    type SubAgentStreamEntry,
} from '../../../src/renderer/stores/toolCallsStore'

// 测试环境为 node（vitest environment: 'node'），无 requestAnimationFrame。
// toolCallsStore 的批处理队列依赖它调度 flush，这里做最小 polyfill（setTimeout 宏任务）。
if (typeof globalThis.requestAnimationFrame === 'undefined') {
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = ((id: number) =>
        clearTimeout(id)) as unknown as typeof cancelAnimationFrame
}

/** 等待批处理队列被 rAF flush（多轮宏任务确保 rAF 回调已执行） */
async function flushBatchQueue(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
}

const TOOL_CALL_ID = 'tc-stream-1'

function textEntry(content: string, timestamp = 0): SubAgentStreamEntry {
    return {type: 'text', content, timestamp}
}

function thinkingEntry(content: string, timestamp = 0): SubAgentStreamEntry {
    return {type: 'thinking', content, timestamp}
}

function toolUseEntry(id = 't1', timestamp = 0): SubAgentStreamEntry {
    return {type: 'tool_use', toolName: 'bash', toolArgs: {cmd: 'echo hi'}, timestamp} as unknown as SubAgentStreamEntry
}

/** 读取指定 toolCall 的 subAgentStream（不存在则返回 undefined） */
function getStream(): SubAgentStreamEntry[] | undefined {
    return useToolCallsStore.getState().states[TOOL_CALL_ID]?.subAgentStream
}

beforeEach(() => {
    useToolCallsStore.setState({states: {}})
})

describe('appendSubAgentStream — 500 条滑动窗口', () => {
    // L1 修复后 appendSubAgentStream 只对已存在的 key 生效（与 flushBatch 同款守卫），
    // 需先注册 runtime key 再追加。
    beforeEach(() => {
        useToolCallsStore.getState().registerToolCall(TOOL_CALL_ID, {status: 'running'}, 'conv-test')
    })

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

describe('clearConversationToolCalls — 会话级即时清理', () => {
    it('按注册时的 convId 批量删除，仅命中该会话的 key', () => {
        const store = useToolCallsStore.getState()
        store.registerToolCall('tc-conv-a', {status: 'running'}, 'conv-A')
        store.registerToolCall('tc-conv-b', {status: 'running'}, 'conv-B')
        store.registerToolCall('tc-no-conv', {status: 'running'})

        useToolCallsStore.getState().clearConversationToolCalls('conv-A')

        const states = useToolCallsStore.getState().states
        expect(states['tc-conv-a']).toBeUndefined()
        // 其他会话及未标注 convId 的 key 不受影响
        expect(states['tc-conv-b']).toBeDefined()
        expect(states['tc-no-conv']).toBeDefined()
    })

    it('无匹配时返回原状态（不触发更新/不改变引用）', () => {
        const store = useToolCallsStore.getState()
        store.registerToolCall('tc-X', {status: 'running'}, 'conv-X')
        const before = useToolCallsStore.getState().states

        useToolCallsStore.getState().clearConversationToolCalls('conv-none')

        expect(useToolCallsStore.getState().states).toBe(before)
    })

    it('清空后 states 为不带旧 key 的新对象', () => {
        const store = useToolCallsStore.getState()
        store.registerToolCall('tc-Y', {status: 'running'}, 'conv-Y')
        useToolCallsStore.getState().clearConversationToolCalls('conv-Y')
        expect(useToolCallsStore.getState().states).toEqual({})
    })
})

describe('appendProgressLog — R2 条数上限（FIFO 丢最旧保最新）', () => {
    const TC = 'tc-progress-cap'

    // L1 修复后 appendProgressLog 只对已存在的 key 生效（与 flushBatch 同款守卫）。
    beforeEach(() => {
        useToolCallsStore.getState().registerToolCall(TC, {status: 'running'}, 'conv-test')
    })

    it('连续追加超过上限 → 长度封顶，且尾部保留最新条目', () => {
        const store = useToolCallsStore.getState()
        const total = PROGRESS_LOG_MAX + 50
        for (let i = 0; i < total; i++) {
            store.appendProgressLog(TC, `p${i}`)
        }

        const log = useToolCallsStore.getState().states[TC]!.progressLog!
        expect(log).toHaveLength(PROGRESS_LOG_MAX)
        // 尾部是最新一条（"最后活跃"时间戳依赖尾部条目）
        expect(log[log.length - 1].text).toBe(`p${total - 1}`)
        expect(log[log.length - 1].timestamp).toBeGreaterThan(0)
        // 头部是最旧的存活条目：最早的 50 条被 FIFO 丢弃
        expect(log[0].text).toBe(`p${total - PROGRESS_LOG_MAX}`)
        expect(log.some(e => e.text === 'p0')).toBe(false)
    })

    it('未超上限时不截断，长度等于追加条数', () => {
        const store = useToolCallsStore.getState()
        for (let i = 0; i < 5; i++) store.appendProgressLog(TC, `q${i}`)
        const log = useToolCallsStore.getState().states[TC]!.progressLog!
        expect(log.map(e => e.text)).toEqual(['q0', 'q1', 'q2', 'q3', 'q4'])
    })
})

describe('flushBatch — R4 只对已存在的 key 生效', () => {
    it('key 被 clearToolCall 删除后，迟到的 progress 更新不会复活它', async () => {
        const store = useToolCallsStore.getState()
        store.registerToolCall('tc-r4', {status: 'running'}, 'conv-r4')
        // 入队一批 progress 更新（走批处理，尚未 flush）
        store.updateToolCall('tc-r4', {progress: 'late-progress'})
        // 在 flush 之前删除该 key
        store.clearToolCall('tc-r4')

        await flushBatchQueue()

        const states = useToolCallsStore.getState().states
        expect(states['tc-r4']).toBeUndefined()
        expect(Object.keys(states)).not.toContain('tc-r4')
    })

    it('已注册的 key 收到批量 progress 更新 → 正常合并，保留 convId/status', async () => {
        const store = useToolCallsStore.getState()
        store.registerToolCall('tc-r4b', {status: 'running', progress: 'init'}, 'conv-r4b')
        store.batchUpdate([
            {toolCallId: 'tc-r4b', updates: {progress: 'p1'}},
            {toolCallId: 'tc-r4b', updates: {progress: 'p2', progressPercent: 42}},
        ])

        await flushBatchQueue()

        const state = useToolCallsStore.getState().states['tc-r4b']
        expect(state).toBeDefined()
        expect(state!.progress).toBe('p2')
        expect(state!.progressPercent).toBe(42)
        // 合并不丢失既有字段
        expect(state!.convId).toBe('conv-r4b')
        expect(state!.status).toBe('running')
    })
})

describe('appendSubAgentStream — R3 单条合并文本长度上限', () => {
    // L1 修复后 appendSubAgentStream 只对已存在的 key 生效（与 flushBatch 同款守卫）。
    beforeEach(() => {
        useToolCallsStore.getState().registerToolCall(TOOL_CALL_ID, {status: 'running'}, 'conv-test')
    })

    it('逐 token 合并超长文本 → 单条 content 封顶且保留尾部内容', () => {
        const store = useToolCallsStore.getState()
        const chunk = 'x'.repeat(1000)
        for (let i = 0; i < 50; i++) {
            store.appendSubAgentStream(TOOL_CALL_ID, textEntry(`[${i}]${chunk}`))
        }

        const stream = getStream()!
        // 仍是"尾部单条"形态（合并而非新建 entry）
        expect(stream).toHaveLength(1)
        expect(stream[0].type).toBe('text')

        const content = stream[0].content!
        expect(content.length).toBeLessThanOrEqual(MAX_SUBAGENT_TEXT_LENGTH)
        // 尾部（最新）内容保留，头部（最早）内容被丢弃
        expect(content).toContain('[49]')
        expect(content).not.toContain('[0]')
        // 可见截断提示（统一走常量，禁止硬编码字面量）
        expect(content).toContain(SUBAGENT_TEXT_TRUNCATION_MARKER)
    })

    it('边界用例：截断后内容恰为「尾部 keep 字符 + 标记」，长度与内容可精确预测', () => {
        const store = useToolCallsStore.getState()
        const marker = SUBAGENT_TEXT_TRUNCATION_MARKER
        const keep = MAX_SUBAGENT_TEXT_LENGTH - marker.length
        // 首段单独不超过上限（不触发截断），第二段追加后越过上限触发尾部截断
        const head = 'A'.repeat(MAX_SUBAGENT_TEXT_LENGTH - 10)
        const tail = 'B'.repeat(100)
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry(head))
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry(tail))

        const stream = getStream()!
        expect(stream).toHaveLength(1)
        const content = stream[0].content!

        const merged = head + tail
        // 与实现同一语义：保留 merged 尾部 keep 个字符后追加标记（逐字节一致，UI 无差异）
        expect(content).toBe(merged.slice(-keep) + marker)
        expect(content.length).toBe(MAX_SUBAGENT_TEXT_LENGTH)
        expect(content.endsWith(marker)).toBe(true)
        // 头部内容被丢弃，尾部标记内容保留
        expect(content.startsWith('A')).toBe(true)
        expect(content).toContain(tail)
    })

    it('连续多次截断后标记恰好出现 1 次（★ 内存优化 D1 防刷屏不变量）', () => {
        const store = useToolCallsStore.getState()
        const marker = SUBAGENT_TEXT_TRUNCATION_MARKER
        // 逐字符（1 字符/token）持续追加 > 20000 次，复现"逐 token 流式 + 反复截断"的真实场景。
        // 修复前：每轮截断无条件追加标记，旧标记落在保留窗口内累积（实测 1091 条）。
        for (let i = 0; i < 20001; i++) {
            store.appendSubAgentStream(TOOL_CALL_ID, textEntry('x'))
        }
        // 再追加一大段必然溢出，使状态落在"刚发生截断"之后。
        // 说明：标记为后缀是截断后状态的不变量；若最后一次 append 未溢出，
        //       新 token 文本会合法地追加在标记之后（标记位于串中，仍恰好 1 次）。
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry('y'.repeat(MAX_SUBAGENT_TEXT_LENGTH)))

        const stream = getStream()!
        expect(stream).toHaveLength(1)
        const content = stream[0].content!

        // 不变量 1：标记恰好出现 1 次
        expect(content.split(marker).length - 1).toBe(1)
        // 不变量 2：标记为后缀
        expect(content.endsWith(marker)).toBe(true)
        // 不变量 3：长度不超过上限
        expect(content.length).toBeLessThanOrEqual(MAX_SUBAGENT_TEXT_LENGTH)
    })

    it('★ B1：已截断状态再追加约 11985 字符 → 不残留任何半截标记片段', () => {
        const store = useToolCallsStore.getState()
        const marker = SUBAGENT_TEXT_TRUNCATION_MARKER

        // Step 1：构造「已截断至 MAX 且以标记结尾」的起点状态
        //   append(MAX 个 A) 时不溢出；再 append(1 个 B) 触发截断 →
        //   content = 尾部 keep 字符 + 标记，长度 = MAX，标记位于 [keep, MAX)。
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry('A'.repeat(MAX_SUBAGENT_TEXT_LENGTH)))
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry('B'))
        const truncated = getStream()![0].content!
        expect(truncated.length).toBe(MAX_SUBAGENT_TEXT_LENGTH)
        expect(truncated.endsWith(marker)).toBe(true)

        // Step 2：追加 11985 字符。此长度使 merged.slice(-keep) 的起点
        //   恰好落在旧标记内部（11985 + marker.length ∈ [keep, MAX)），
        //   即修复前 B1 的复现场景：标记被切穿 → 半截残片留在内容头部并被用户看到。
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry('C'.repeat(11985)))

        const stream = getStream()!
        expect(stream).toHaveLength(1)
        const content = stream[0].content!

        // 不变量 1：标记恰好出现 1 次
        expect(content.split(marker).length - 1).toBe(1)
        // 不变量 2：标记为后缀
        expect(content.endsWith(marker)).toBe(true)
        // 不变量 3：长度不超过上限
        expect(content.length).toBeLessThanOrEqual(MAX_SUBAGENT_TEXT_LENGTH)

        // 不变量 4（B1 核心）：剔除完整标记后的正文不得含任何标记的可辨识片段。
        //   修复前此处为 "较早内容)CCCC…"，即被切穿后残留的半截标记。
        const body = content.split(marker).join('')
        expect(body).not.toContain('已截断较早内容')
        expect(body).not.toContain('较早内容)')
        expect(body).not.toContain('(已截断')
        //   哨兵两端的 U+2063 亦不得残留（任何半截片段必然带出至少一个哨兵字符）
        expect(body).not.toContain('\u2063')
        //   正文确实保留了尾部新内容（并非误删成空串）
        expect(body).toContain('C'.repeat(11985))
    })

    it('★ B2：正文中偶然出现的同名中文字面量不被剔除（哨兵抗碰撞）', () => {
        const store = useToolCallsStore.getState()
        const marker = SUBAGENT_TEXT_TRUNCATION_MARKER
        const keep = MAX_SUBAGENT_TEXT_LENGTH - marker.length

        // 正文自然语言里恰好出现与可见文案同名的片段（不含不可见哨兵）。
        // 修复前标记就是该可见字面量，split(marker).join('') 会把它一并静默删除。
        const plain = '…(已截断较早内容)'
        expect(plain).not.toBe(marker)
        expect(plain.includes('\u2063')).toBe(false)

        store.appendSubAgentStream(TOOL_CALL_ID, textEntry('A'.repeat(MAX_SUBAGENT_TEXT_LENGTH)))
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry('B'.repeat(20000))) // 触发截断
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry(plain)) // 正文片段，位于尾部附近
        // 再次溢出触发第二/三次截断，plain 仍落在保留窗口内
        store.appendSubAgentStream(TOOL_CALL_ID, textEntry('C'.repeat(keep - 100)))

        const content = getStream()![0].content!
        // 正文片段属于内容，必须原样可见（不被哨兵剔除逻辑误删）
        expect(content).toContain(plain)
        // 真正的哨兵标记仍恰好 1 次且为后缀
        expect(content.split(marker).length - 1).toBe(1)
        expect(content.endsWith(marker)).toBe(true)
        expect(content.length).toBeLessThanOrEqual(MAX_SUBAGENT_TEXT_LENGTH)
    })
})

describe('appendProgressLog / appendSubAgentStream — L1 孤儿 key 守卫（与 flushBatch 同款）', () => {
    const GHOST = 'tc-ghost-no-conv'

    it('appendProgressLog：toolCallId 不存在 → 不新增任何 key（返回空 patch）', () => {
        const before = useToolCallsStore.getState().states
        useToolCallsStore.getState().appendProgressLog(GHOST, 'late-progress')
        const after = useToolCallsStore.getState().states
        expect(after[GHOST]).toBeUndefined()
        expect(Object.keys(after)).toHaveLength(0)
        // 空 patch：states 引用不变
        expect(after).toBe(before)
    })

    it('appendSubAgentStream：toolCallId 不存在 → 不新增任何 key（返回空 patch）', () => {
        const before = useToolCallsStore.getState().states
        useToolCallsStore.getState().appendSubAgentStream(GHOST, textEntry('late'))
        const after = useToolCallsStore.getState().states
        expect(after[GHOST]).toBeUndefined()
        expect(Object.keys(after)).toHaveLength(0)
        expect(after).toBe(before)
    })

    it('key 被 clearToolCall 删除后，迟到的 progress/subagent 流不会复活它', () => {
        const store = useToolCallsStore.getState()
        store.registerToolCall('tc-l1', {status: 'running'}, 'conv-l1')
        store.appendProgressLog('tc-l1', 'first')
        store.appendSubAgentStream('tc-l1', textEntry('first'))
        store.clearToolCall('tc-l1')

        store.appendProgressLog('tc-l1', 'late')
        store.appendSubAgentStream('tc-l1', textEntry('late'))

        const states = useToolCallsStore.getState().states
        expect(states['tc-l1']).toBeUndefined()
        expect(Object.keys(states)).toHaveLength(0)
    })

    it('key 被 clearConversationToolCalls 删除后同理（不复活无 convId 的孤儿 key）', () => {
        const store = useToolCallsStore.getState()
        store.registerToolCall('tc-l1b', {status: 'running'}, 'conv-l1b')
        useToolCallsStore.getState().clearConversationToolCalls('conv-l1b')

        store.appendProgressLog('tc-l1b', 'late')
        store.appendSubAgentStream('tc-l1b', textEntry('late'))

        const states = useToolCallsStore.getState().states
        expect(states['tc-l1b']).toBeUndefined()
        expect(Object.keys(states)).toHaveLength(0)
    })
})


describe('updateToolCall / setToolResult — fallback key 必须带 convId（防孤儿 key）', () => {
    it('updateToolCall：key 不存在 + 传 convId → 建出的 entry 带 convId，且可被 clearConversationToolCalls 删除', () => {
        const store = useToolCallsStore.getState()
        store.updateToolCall('tc-orphan-upd', {status: 'running'}, 'conv-x')

        const created = useToolCallsStore.getState().states['tc-orphan-upd']
        expect(created).toBeDefined()
        expect(created!.convId).toBe('conv-x')

        useToolCallsStore.getState().clearConversationToolCalls('conv-x')
        expect(useToolCallsStore.getState().states['tc-orphan-upd']).toBeUndefined()
    })

    it('setToolResult：key 不存在 + 传 convId → 建出的 entry 带 convId，且可被 clearConversationToolCalls 删除', () => {
        const store = useToolCallsStore.getState()
        store.setToolResult('tc-orphan-res', {success: true, output: 'ok'}, 'conv-y')

        const created = useToolCallsStore.getState().states['tc-orphan-res']
        expect(created).toBeDefined()
        expect(created!.convId).toBe('conv-y')
        expect(created!.status).toBe('success')

        useToolCallsStore.getState().clearConversationToolCalls('conv-y')
        expect(useToolCallsStore.getState().states['tc-orphan-res']).toBeUndefined()
    })

    it('回归护栏：不传 convId 时 updateToolCall / setToolResult 仍会建 key（禁止改成"丢弃"）', () => {
        const store = useToolCallsStore.getState()
        store.updateToolCall('tc-keep-upd', {status: 'running'})
        store.setToolResult('tc-keep-res', {success: true, output: 'ok'})

        const states = useToolCallsStore.getState().states
        // streamSubAgents 依赖此 fallback 建立父 agent 运行时 key，行为必须保留
        expect(states['tc-keep-upd']).toBeDefined()
        expect(states['tc-keep-upd'].convId).toBeUndefined()
        expect(states['tc-keep-res']).toBeDefined()
        expect(states['tc-keep-res'].status).toBe('success')
    })

    it('key 已存在时，传入 convId 不覆盖其原有 convId', () => {
        const store = useToolCallsStore.getState()
        store.registerToolCall('tc-existing', {status: 'running'}, 'conv-origin')
        store.updateToolCall('tc-existing', {status: 'running'}, 'conv-other')
        store.setToolResult('tc-existing', {success: true, output: 'ok'}, 'conv-other-2')

        const state = useToolCallsStore.getState().states['tc-existing']
        expect(state!.convId).toBe('conv-origin')
    })
})