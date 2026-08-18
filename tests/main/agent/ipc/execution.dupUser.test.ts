/**
 * 回归测试：agent-start 重复 user 消息去重
 *
 * 背景（跨 turn 缓存断裂根因之一）：渲染端先 addMessage 落库、再 startAgent
 * 传同一消息。新会话首条消息在 throttle 首次立即 flush 场景必现，若 execution.ts
 * 无条件 push history 的 user 再 push params.message，重建序列出现 [user, user]
 * 重复，与 loop 内存态（单 user）逐 token 不一致 → KV cache 从首条消息处断裂
 * （实测 conv-08fd8ff2 首调 input=17 恰好=第二个重复 user 的 token）。
 */
import {describe, it, expect} from 'vitest'
import {isDuplicatePendingUserMessage} from '@/main/agent/ipc/execution'

describe('isDuplicatePendingUserMessage — 末条 user 与待发送消息去重判定', () => {
    it('history 末条 user 与 params.message 一致 → 判定为重复（应跳过）', () => {
        const history = [
            {role: 'user', content: '/code-simplifier\n未提交的代码有没有优化空间？'},
        ]
        expect(isDuplicatePendingUserMessage(history, '/code-simplifier\n未提交的代码有没有优化空间？'))
            .toBe(true)
    })

    it('history 末条是 assistant（上次 agent 已完成）→ 不去重', () => {
        const history = [
            {role: 'user', content: '很好'},
            {role: 'assistant', content: '好的，已完成'},
        ]
        // 末条是 assistant → 条件"末条是 user"不满足 → 不去重（两次"很好"都是独立消息）
        expect(isDuplicatePendingUserMessage(history, '很好')).toBe(false)
    })

    it('history 末条 user 是第二次相同内容（已落库待发送）→ 去重（由 params 唯一推送）', () => {
        const history = [
            {role: 'user', content: '很好'},
            {role: 'assistant', content: '好的，已完成'},
            {role: 'user', content: '很好'},  // 第二次相同内容，已落库、未回复
        ]
        // 末条 user2 与 params.message 相同 → 去重，避免 [很好, 很好] 重复
        expect(isDuplicatePendingUserMessage(history, '很好')).toBe(true)
    })

    it('history 末条 user 内容不同 → 不去重', () => {
        const history = [
            {role: 'user', content: '旧消息'},
        ]
        expect(isDuplicatePendingUserMessage(history, '新消息')).toBe(false)
    })

    it('history 为空 → 不去重', () => {
        expect(isDuplicatePendingUserMessage([], '任意消息')).toBe(false)
    })

    it('content 非字符串（多模态数组）→ 不去重（安全兜底）', () => {
        const history = [
            {role: 'user', content: [{type: 'text', text: '图片消息'}]},
        ]
        expect(isDuplicatePendingUserMessage(history as any, '图片消息')).toBe(false)
    })

    it('附件数量不一致 → 不去重', () => {
        const history = [
            {role: 'user', content: '看这个文件', attachments: [{path: '/a.png'}]},
        ]
        expect(isDuplicatePendingUserMessage(history, '看这个文件', [])).toBe(false)
        expect(isDuplicatePendingUserMessage(history, '看这个文件', [{path: '/a.png'}])).toBe(true)
    })

    it('history 有完整历史、末条恰为待发送 user（新会话首条已落库场景）→ 去重', () => {
        // 模拟 conv-08fd8ff2：新会话首条 /code-simplifier 已落库，agent-start 读回
        const history = [
            {role: 'user', content: '/code-simplifier\n未提交的代码有没有优化空间？不要影响已实现的功能'},
        ]
        expect(isDuplicatePendingUserMessage(
            history,
            '/code-simplifier\n未提交的代码有没有优化空间？不要影响已实现的功能',
        )).toBe(true)
    })
})
