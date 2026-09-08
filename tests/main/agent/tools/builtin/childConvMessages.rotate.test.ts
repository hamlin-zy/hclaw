import {describe, expect, it} from 'vitest'
import {
    createChildConvAccumulator,
    rotateChildConvAccumulator,
    handleChildEvent,
    buildCurrentMessage,
} from '@/main/agent/tools/builtin/childConvMessages'
import type {Message} from '@shared/types'

function makeRepo() {
    const written: Message[][] = []
    return {written, writeMessages: (_c: string, msgs: Message[]) => { written.push(msgs); return true }}
}

describe('rotateChildConvAccumulator — 注入消息时轮换累积器', () => {
    it('旧消息收尾（endedAt）+ 累积器重置为新 id/空缓冲', () => {
        const repo = makeRepo()
        const acc = createChildConvAccumulator()
        const oldId = acc.assistantMsgId

        handleChildEvent(acc, {type: 'text', content: '第一段输出'} as any)
        handleChildEvent(acc, {
            type: 'tool_use',
            toolCall: {id: 'tc-1', name: 'bash', input: {command: 'ls'}, status: 'success'},
        } as any)

        rotateChildConvAccumulator(acc, repo, 'conv-1')

        // 旧消息已收尾落库，带 endedAt
        expect(repo.written.length).toBe(1)
        const oldMsg = repo.written[0][0]
        expect(oldMsg.id).toBe(oldId)
        expect(oldMsg.endedAt).toBeGreaterThan(0)
        expect(oldMsg.content).toContain('第一段输出')

        // 累积器重置：新 id、空缓冲
        expect(acc.assistantMsgId).not.toBe(oldId)
        expect(acc.textContent).toBe('')
        expect(acc.blocks.length).toBe(0)
        expect(acc.toolCalls.size).toBe(0)
        expect(acc.llmStats.length).toBe(0)
        expect(acc.hasError).toBe(false)

        // 重置后新内容构建为新消息
        handleChildEvent(acc, {type: 'text', content: '注入后的输出'} as any)
        const newMsg = buildCurrentMessage(acc, Date.now())
        expect(newMsg?.id).toBe(acc.assistantMsgId)
        expect(newMsg?.content).toBe('注入后的输出')
    })

    it('空累积时轮换不落库旧消息，仅重置', () => {
        const repo = makeRepo()
        const acc = createChildConvAccumulator()
        rotateChildConvAccumulator(acc, repo, 'conv-1')
        expect(repo.written.length).toBe(0)
        expect(acc.textContent).toBe('')
    })
})
