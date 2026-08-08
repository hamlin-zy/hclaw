/**
 * ChunkedMessages / addMessage / createLoopState 单元测试
 */
import {describe, expect, it} from 'vitest'
import type {ChatMessage} from '../../../src/main/agent/model/types'
import {addMessage, createLoopState} from '../../../src/main/agent/state'

function makeMsg(idx: number, role: ChatMessage['role'] = 'user'): ChatMessage {
    return {id: `m${idx}`, role, content: `message ${idx}`}
}

describe('ChunkedMessages — 分块持久化追加', () => {
    it('append 后 toArray 内容与顺序一致', () => {
        let state = createLoopState([])
        const expected: string[] = []
        for (let i = 0; i < 100; i++) {
            state = addMessage(state, makeMsg(i))
            expected.push(`message ${i}`)
        }
        const contents = state.messages.map(m => m.content as string)
        expect(contents).toEqual(expected)
    })

    it('跨块追加（> CHUNK_SIZE 32）正确', () => {
        let state = createLoopState([])
        for (let i = 0; i < 70; i++) state = addMessage(state, makeMsg(i))
        expect(state.messages.length).toBe(70)
        expect(state.messages[0].id).toBe('m0')
        expect(state.messages[69].id).toBe('m69')
    })

    it('原状态不可变：addMessage 不修改旧状态', () => {
        const s0 = createLoopState([makeMsg(0)])
        const s1 = addMessage(s0, makeMsg(1))
        expect(s0.messages.length).toBe(1)
        expect(s1.messages.length).toBe(2)
        expect(Object.isFrozen(s1)).toBe(true)
    })

    it('createLoopState 从现有数组构建', () => {
        const msgs = [makeMsg(0), makeMsg(1), makeMsg(2)]
        const state = createLoopState(msgs)
        expect(state.messages).toEqual(msgs)
        expect(state.turnCount).toBe(0)
    })
})
