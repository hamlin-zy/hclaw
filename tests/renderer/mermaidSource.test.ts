/**
 * isMermaidSource 识别契约（B 策略）
 *
 * 契约：
 * 1. 代码块语言标注为 `mermaid` → 一律按 mermaid 渲染。
 * 2. 无语言标注，但首行（去空白）以已知 mermaid diagram 关键字开头，且代码块至少两行 → 按 mermaid 渲染。
 * 3. 其余一律 false（交回 Prism / 普通代码块）。
 *
 * 判别力：若去掉「至少两行」约束，单行 'graph' 用例会翻绿；
 * 若去掉词边界，'flowchartx' 前缀用例会翻绿。
 */
import {describe, expect, it} from 'vitest'
import {isMermaidSource} from '@/renderer/components/message-list/mermaidSource'

describe('isMermaidSource', () => {
    describe('语言标注', () => {
        it('language-mermaid 标注一律识别（内容任意）', () => {
            expect(isMermaidSource('anything at all', 'mermaid')).toBe(true)
        })

        it('标注大小写不敏感（Mermaid / MERMAID）', () => {
            expect(isMermaidSource('x', 'Mermaid')).toBe(true)
            expect(isMermaidSource('x', 'MERMAID')).toBe(true)
        })

        it('其他语言标注不识别，即便内容像 mermaid', () => {
            expect(isMermaidSource('flowchart TB\nA-->B', 'ts')).toBe(false)
            expect(isMermaidSource('graph TD\nA-->B', 'text')).toBe(false)
        })
    })

    describe('无语言标注 → 首行关键字嗅探', () => {
        it('首行 flowchart 多行 → true', () => {
            expect(isMermaidSource('flowchart TB\n  A[开始] --> B[结束]')).toBe(true)
        })

        it('首行 graph 多行 → true', () => {
            expect(isMermaidSource('graph TD\nA-->B')).toBe(true)
        })

        it('首行 sequenceDiagram → true', () => {
            expect(isMermaidSource('sequenceDiagram\nA->>B: hi')).toBe(true)
        })

        it('首行带前导空白仍识别', () => {
            expect(isMermaidSource('   flowchart TB\n  A-->B')).toBe(true)
        })

        it('关键字大小写不敏感', () => {
            expect(isMermaidSource('FlowChart TB\nA-->B')).toBe(true)
        })
    })

    describe('误判防护', () => {
        it('单行内容不触发（至少两行）', () => {
            expect(isMermaidSource('graph')).toBe(false)
            expect(isMermaidSource('flowchart TB')).toBe(false)
        })

        it('首行关键字后紧跟字母（flowchartx）不触发（词边界）', () => {
            expect(isMermaidSource('flowchartx foo\nbar')).toBe(false)
        })

        it('普通代码首行不以关键字开头 → false', () => {
            expect(isMermaidSource('const graph = 1\nfoo()')).toBe(false)
        })

        it('空内容 / 纯空白 → false', () => {
            expect(isMermaidSource('')).toBe(false)
            expect(isMermaidSource('   \n  \n')).toBe(false)
        })
    })
})