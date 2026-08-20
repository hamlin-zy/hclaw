import {describe, expect, it} from 'vitest'
import {accumulateStreamEvent, finalizePending, normalizeToolResult, appendCappedPart, isRenderedCopyFingerprintMatch} from '@/main/agent/manager.accumulator'
import {PENDING_MSG_MAX_BYTES} from '@/main/agent/manager.constants'
import type {PendingAssistantMsg} from '@/main/agent/manager.types'

function makePending(toolName: string, toolCallId = 'tc-1'): PendingAssistantMsg {
    return {
        id: 'msg-1',
        content: '',
        contentLength: 0,
        toolCalls: [{
            id: toolCallId,
            name: toolName,
            arguments: {},
            status: 'running',
        }],
        thinkContent: null,
        timestamp: 1000,
    }
}

describe('normalizeToolResult — 保留 _meta（需求1 链路）', () => {
    it('agent 工具结果携带 _meta.childConvId 时保留', () => {
        const r = normalizeToolResult({output: 'ok', success: true, _meta: {childConvId: 'conv-abc'}})
        expect(r.output).toBe('ok')
        expect(r._meta).toEqual({childConvId: 'conv-abc'})
    })

    it('无 _meta 时返回对象不含 _meta 字段（回归）', () => {
        const r = normalizeToolResult({output: 'x'})
        expect(r._meta).toBeUndefined()
    })

    it('null 输入返回空 output 且无 _meta（回归）', () => {
        const r = normalizeToolResult(null)
        expect(r.output).toBe('')
        expect(r._meta).toBeUndefined()
    })
})

describe('accumulateStreamEvent — tool_result 分支写入 taskId（双轨一致性，impl 同步修改）', () => {
    it('agent 工具：从 result._meta 恢复 taskId', () => {
        const pending = makePending('agent')
        const turnReset = new Set<string>()
        const out = accumulateStreamEvent(pending, 'conv-root', {
            type: 'tool_result',
            toolCallId: 'tc-1',
            result: {output: 'ok', success: true, _meta: {childConvId: 'conv-abc'}},
        } as any, turnReset)
        expect(out?.toolCalls[0].taskId).toBe('conv-abc')
        expect(out?.toolCalls[0].status).toBe('success')
        expect(out?.toolCalls[0].result?._meta).toEqual({childConvId: 'conv-abc'})
    })

    it('非 agent 工具不写入 taskId（回归）', () => {
        const pending = makePending('bash')
        const out = accumulateStreamEvent(pending, 'conv-root', {
            type: 'tool_result',
            toolCallId: 'tc-1',
            result: {output: 'ok', success: true, _meta: {childConvId: 'conv-abc'}},
        } as any, new Set<string>())
        expect(out?.toolCalls[0].taskId).toBeUndefined()
    })

    it('toolCallId 不存在时保持 pending 不变（回归）', () => {
        const pending = makePending('agent')
        const out = accumulateStreamEvent(pending, 'conv-root', {
            type: 'tool_result',
            toolCallId: 'no-such-id',
            result: {output: 'ok'},
        } as any, new Set<string>())
        expect(out).toBe(pending)
        expect(out?.toolCalls[0].taskId).toBeUndefined()
    })
})

// ── 新增：text 分支段内数组 + contentLength（方案 C） ──
describe('accumulateStreamEvent — text 分支段内数组 + contentLength', () => {
    it('text 累积：contentParts 追加 + contentLength 累加', () => {
        const pending = makePending('bash')
        const out = accumulateStreamEvent(pending, 'conv-root', {type: 'text', content: '你'} as any, new Set<string>())
        const out2 = accumulateStreamEvent(out!, 'conv-root', {type: 'text', content: '好'} as any, new Set<string>())
        expect(out2?.contentParts).toEqual(['你', '好'])
        expect(out2?.contentLength).toBe(2)
    })

    it('tool_use 的 textOffset 由 contentLength 派生', () => {
        const pending = makePending('bash')
        const withText = accumulateStreamEvent(pending, 'conv-root', {type: 'text', content: '前文'} as any, new Set<string>())
        const withTool = accumulateStreamEvent(withText!, 'conv-root', {
            type: 'tool_use', toolCall: {id: 'tc-2', name: 'bash', arguments: {}},
        } as any, new Set<string>())
        const added = withTool?.toolCalls.find(t => t.id === 'tc-2')
        expect(added?.textOffset).toBe(2)  // '前文'.length === 2
    })

    it('finalizePending：join contentParts → content，清空 parts', () => {
        const pending = makePending('bash')
        const acc = accumulateStreamEvent(pending, 'conv-root', {type: 'text', content: '合'} as any, new Set<string>())
        const acc2 = accumulateStreamEvent(acc!, 'conv-root', {type: 'text', content: '并'} as any, new Set<string>())
        const finalized = finalizePending(acc2!)
        expect(finalized.content).toBe('合并')
        expect(finalized.contentParts).toEqual([])
        expect(finalized.contentLength).toBe(2)
    })

    it('capField 等价：超限截断到 MAX，contentLength 同步', () => {
        const pending = makePending('bash')
        let out = pending
        const big = 'x'.repeat(PENDING_MSG_MAX_BYTES + 10)
        out = accumulateStreamEvent(out, 'conv-root', {type: 'text', content: big} as any, new Set<string>())!
        const finalized = finalizePending(out)
        expect(finalized.content.length).toBe(PENDING_MSG_MAX_BYTES)
        expect(finalized.contentLength).toBe(PENDING_MSG_MAX_BYTES)
    })

    // ── 跨段截断等价：锁定 off-by-one（方案 C 与旧算法逐字一致） ──
    it('跨段截断等价：多段越过上限，finalize 与旧算法逐字一致', () => {
        const pending = makePending('bash')
        const first = 'x'.repeat(PENDING_MSG_MAX_BYTES - 3)
        const second = 'y'.repeat(10)
        const out = accumulateStreamEvent(pending, 'conv-root', {type: 'text', content: first} as any, new Set<string>())
        const out2 = accumulateStreamEvent(out!, 'conv-root', {type: 'text', content: second} as any, new Set<string>())
        const finalized = finalizePending(out2!)
        expect(finalized.content.length).toBe(PENDING_MSG_MAX_BYTES)
        expect(finalized.content).toBe((first + second).slice(0, PENDING_MSG_MAX_BYTES))
        expect(finalized.contentLength).toBe(PENDING_MSG_MAX_BYTES)
    })

    // ── thinking 分支 finalize + 截断对称 ──
    it('thinking 分支：thinkParts 累积/finalize 拼接/超限截断对称', () => {
        const pending = makePending('bash')
        const out = accumulateStreamEvent(pending, 'conv-root', {type: 'thinking', content: '思'} as any, new Set<string>())
        const out2 = accumulateStreamEvent(out!, 'conv-root', {type: 'thinking', content: '考'} as any, new Set<string>())
        expect(out2?.thinkParts).toEqual(['思', '考'])
        expect(out2?.thinkLength).toBe(2)
        const finalized = finalizePending(out2!)
        expect(finalized.thinkContent).toBe('思考')
        expect(finalized.thinkParts).toEqual([])

        const truncated = makePending('bash')
        const big = 't'.repeat(PENDING_MSG_MAX_BYTES + 10)
        const acc = accumulateStreamEvent(truncated, 'conv-root', {type: 'thinking', content: big} as any, new Set<string>())!
        expect(acc.thinkLength).toBe(PENDING_MSG_MAX_BYTES)
        const finalizedTruncated = finalizePending(acc)
        expect(finalizedTruncated.thinkContent?.length).toBe(PENDING_MSG_MAX_BYTES)
        expect(finalizedTruncated.thinkParts).toEqual([])
    })

    // ── finalizePending 幂等：重复调用内容稳定 ──
    it('finalizePending 幂等：连续调用两次内容稳定', () => {
        const pending = makePending('bash')
        const withText = accumulateStreamEvent(pending, 'conv-root', {type: 'text', content: '正文'} as any, new Set<string>())
        const withThink = accumulateStreamEvent(withText!, 'conv-root', {type: 'thinking', content: '思考'} as any, new Set<string>())
        const f1 = finalizePending(withThink!)
        const content1 = f1.content
        const think1 = f1.thinkContent
        const f2 = finalizePending(f1)
        expect(f2.content).toBe(content1)
        expect(f2.thinkContent).toBe(think1)
    })
})

// ── appendCappedPart：段内累积 + 截断 helper 的边界行为 ──
describe('appendCappedPart — 段内累积 + 截断边界', () => {
    it('未超限：累加长度，truncated=false', () => {
        const parts: string[] = []
        const r1 = appendCappedPart(parts, '你', 0, 100)
        const r2 = appendCappedPart(parts, '好', r1.length, 100)
        expect(parts).toEqual(['你', '好'])
        expect(r2.length).toBe(2)
        expect(r2.truncated).toBe(false)
    })

    it('恰好等于上限：不截断，truncated=false', () => {
        const parts: string[] = []
        const r = appendCappedPart(parts, 'abcd', 0, 4)
        expect(r.length).toBe(4)
        expect(r.truncated).toBe(false)
        expect(parts).toEqual(['abcd'])
    })

    it('超限：截断末段到上限，truncated=true', () => {
        const parts: string[] = []
        const r = appendCappedPart(parts, 'abcdef', 0, 4)
        expect(r.length).toBe(4)
        expect(r.truncated).toBe(true)
        expect(parts).toEqual(['abcd'])
    })

    it('跨段超限：末段截断，逐字等价于旧算法（(ab+cdefg).slice(0,5)）', () => {
        const parts: string[] = []
        const r1 = appendCappedPart(parts, 'ab', 0, 5)
        const r2 = appendCappedPart(parts, 'cdefg', r1.length, 5)
        expect(r2.length).toBe(5)
        expect(r2.truncated).toBe(true)
        expect(parts.join('')).toBe('abcde')
    })

    it('空 chunk：追加空串，长度不变', () => {
        const parts: string[] = []
        const r = appendCappedPart(parts, '', 3, 10)
        expect(r.length).toBe(3)
        expect(r.truncated).toBe(false)
        expect(parts).toEqual([''])
    })
})

// ── registeredMsgId：主进程 pending 复用渲染端占位 id（幽灵消息双写根因修复） ──
describe('accumulateStreamEvent — registeredMsgId id 对齐', () => {
    it('首次创建（pending=null）：新 pending 使用渲染端占位 id', () => {
        const out = accumulateStreamEvent(
            null, 'conv-root', {type: 'text', content: '你好'} as any, new Set<string>(), 'placeholder-1',
        )
        expect(out?.id).toBe('placeholder-1')
        expect(out?.contentLength).toBe(2)
    })

    it('已存在 pending：id 被对齐到占位 id（幂等）', () => {
        const pending = makePending('bash', 'tc-1') // id='msg-1'
        const out = accumulateStreamEvent(
            pending, 'conv-root', {type: 'text', content: '追加'} as any, new Set<string>(), 'placeholder-1',
        )
        expect(out?.id).toBe('placeholder-1')
        // 内容仍正常累积
        const finalized = finalizePending(out!)
        expect(finalized.content).toBe('追加')
    })

    it('turn reset 重建 pending：新 pending 仍使用占位 id（不产生新随机 id）', () => {
        // 模拟 tool_result 后置 turn reset → 下一次 text 重建 pending
        const turnReset = new Set<string>()
        const pending = makePending('bash', 'tc-1')
        accumulateStreamEvent(pending, 'conv-root', {
            type: 'tool_result', toolCallId: 'tc-1', result: {output: 'ok'},
        } as any, turnReset)
        expect(turnReset.has('conv-root')).toBe(true)

        // 重建：注册 id 必须延续，否则 done 全量写会以新 id 插入幽灵副本
        const rebuilt = accumulateStreamEvent(
            null, 'conv-root', {type: 'text', content: '新回合'} as any, turnReset, 'placeholder-1',
        )
        expect(rebuilt?.id).toBe('placeholder-1')
        const finalized = finalizePending(rebuilt!)
        expect(finalized.content).toBe('新回合')
    })

    it('无 registeredMsgId：保持 createPendingMsg 随机 id（渲染端崩溃兜底路径不受影响）', () => {
        const out = accumulateStreamEvent(
            null, 'conv-root', {type: 'text', content: 'x'} as any, new Set<string>(),
        )
        expect(out?.id).toBeTruthy()
        expect(out?.id).not.toBe('placeholder-1')
    })
})

// ── isRenderedCopyFingerprintMatch：幽灵双写防御的指纹判定（#findRenderedCopy 核心逻辑） ──
describe('isRenderedCopyFingerprintMatch — 渲染端已落库文本指纹匹配', () => {
    it('前 200 字符一致 → 匹配（判定渲染端已落库，主进程不得 INSERT 副本）', () => {
        expect(isRenderedCopyFingerprintMatch('你好，我是助手回复', '你好，我是助手回复')).toBe(true)
    })

    it('内容不一致 → 不匹配（不同消息，走全量写兜底）', () => {
        expect(isRenderedCopyFingerprintMatch('回复 A', '回复 B')).toBe(false)
    })

    it('nearbyText 为空（渲染端占位无内容）→ 不匹配（防误杀：空占位不代表已落库）', () => {
        expect(isRenderedCopyFingerprintMatch('', '回复 A')).toBe(false)
    })

    it('pending 超过 200 字符：前 200 一致 → 匹配（截断指纹语义）', () => {
        const longContent = '甲'.repeat(300)
        expect(isRenderedCopyFingerprintMatch(longContent.slice(0, 200), longContent)).toBe(true)
    })

    it('恰好 200 字符边界 → 匹配', () => {
        const exact = '乙'.repeat(200)
        expect(isRenderedCopyFingerprintMatch(exact, exact)).toBe(true)
    })

    it('pending 短于 nearbyText（nearbyText 更长）→ 不匹配', () => {
        // nearbyText 已截断为 ≤200，若 pending 更短则内容必然不同
        expect(isRenderedCopyFingerprintMatch('abc', 'a')).toBe(false)
    })

    it('pending 为空但 nearbyText 非空 → 不匹配', () => {
        expect(isRenderedCopyFingerprintMatch('abc', '')).toBe(false)
    })

    it('大小写敏感：abc 与 ABC 不一致 → 不匹配', () => {
        expect(isRenderedCopyFingerprintMatch('abc', 'ABC')).toBe(false)
    })
})
