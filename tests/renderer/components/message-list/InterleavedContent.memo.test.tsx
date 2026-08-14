// @vitest-environment jsdom
import {describe, it, expect, vi} from 'vitest'
import {render} from '@testing-library/react'

// MarkdownRenderer 渲染 spy：断言"未变化块不重渲染"
const {markdownRenderSpy} = vi.hoisted(() => ({markdownRenderSpy: vi.fn()}))
vi.mock('../../../../src/renderer/components/message-list/MarkdownRenderer', () => ({
    default: () => { markdownRenderSpy(); return <div data-testid="md"/> },
}))

// ThinkBlock 渲染 spy：断言 think 块 comparator 是否放行（同内容 bail out / 内容变化才渲染）。
// 生产代码中 ThinkBlockMemo = memo(ThinkBlock, comparator)，测试只能通过 mock ThinkBlock
// 模块来观察 memo 是否重新调用 ThinkBlock（comparator 返回 false 才重渲染）。
const {thinkRenderSpy} = vi.hoisted(() => ({thinkRenderSpy: vi.fn()}))
vi.mock('../../../../src/renderer/components/ThinkBlock', () => ({
    default: ({thinkBlock}: {thinkBlock: {content: string}}) => {
        thinkRenderSpy()
        return <div data-testid="think">{thinkBlock.content}</div>
    },
}))

// store 桩（InterleavedContent 依赖 themeStore/agentStore/conversationStore）
vi.mock('../../../../src/renderer/stores/themeStore', () => ({
    useThemeStore: () => 'light',
}))
vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: () => ({messageDisplayMode: 'detailed'}),
}))
vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: () => ({activeConversationId: 'conv-1'}),
}))

import InterleavedContent from '../../../../src/renderer/components/message-list/InterleavedContent'
import type {Message} from '../../../../src/shared/types'

function makeMessage(contentBlocks: any[]): Message {
    return {id: 'm1', role: 'assistant', content: '', timestamp: 1, contentBlocks} as any
}

describe('InterleavedContent — memo 块隔离（方案 B2）', () => {
    it('未变化块不触发 markdown 解析（仅变化块重渲染）', () => {
        const blockA = {id: 'text-m1-0', type: 'text', text: '稳'}
        const blockB = {id: 'text-m1-1', type: 'text', text: '动'}
        const {rerender} = render(<InterleavedContent message={makeMessage([blockA, blockB])} isUser={false}/>)
        markdownRenderSpy.mockClear()
        // 块 A 引用不变（同对象），块 B 内容变化 → 仅 B 重新解析
        const blockB2 = {id: 'text-m1-1', type: 'text', text: '动动'}
        rerender(<InterleavedContent message={makeMessage([blockA, blockB2])} isUser={false}/>)
        expect(markdownRenderSpy).toHaveBeenCalledTimes(1)
    })

    it('think 块：新对象但内容相同 → 不重渲染（comparator 生效，timestamp 不参与比较）', () => {
        const thinkA = {id: 'think-m1-0', type: 'think', thinkBlock: {id: 'think-m1-0', content: '想', status: 'thinking', timestamp: 1}}
        const thinkB = {id: 'think-m1-0', type: 'think', thinkBlock: {id: 'think-m1-0', content: '想', status: 'thinking', timestamp: 2}}  // 新对象同内容，但 timestamp 易变（每次 flush 重生成）
        const textBlock = {id: 'text-m1-0', type: 'text', text: 'x'}
        const {rerender} = render(<InterleavedContent message={makeMessage([thinkA, textBlock])} isUser={false}/>)
        thinkRenderSpy.mockClear()
        rerender(<InterleavedContent message={makeMessage([thinkB, textBlock])} isUser={false}/>)
        expect(thinkRenderSpy).toHaveBeenCalledTimes(0)  // think 内容+status 相等 → comparator 放行 bail out
    })

    it('think 块：内容变化 → 重渲染（comparator 不是永远 bail out）', () => {
        const thinkA = {id: 'think-m1-0', type: 'think', thinkBlock: {id: 'think-m1-0', content: '想', status: 'thinking', timestamp: 1}}
        const thinkB = {id: 'think-m1-0', type: 'think', thinkBlock: {id: 'think-m1-0', content: '想更多', status: 'thinking', timestamp: 1}}  // 新对象且内容变化
        const textBlock = {id: 'text-m1-0', type: 'text', text: 'x'}
        const {rerender} = render(<InterleavedContent message={makeMessage([thinkA, textBlock])} isUser={false}/>)
        thinkRenderSpy.mockClear()
        rerender(<InterleavedContent message={makeMessage([thinkB, textBlock])} isUser={false}/>)
        expect(thinkRenderSpy).toHaveBeenCalledTimes(1)  // think 内容变化 → comparator 放行重渲染
    })
})
