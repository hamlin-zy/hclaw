import {describe, expect, it} from 'vitest'
import {createDefaultResult} from '@/main/agent/loop/helpers'

describe('createDefaultResult 意图分类（auto 路由规则）', () => {
    it('重构/架构类关键词 → complex + reasoning', () => {
        const r = createDefaultResult('帮我重构这个模块的架构')
        expect(r.complexity).toBe('complex')
        expect(r.suggestedModel).toBe('reasoning')
        expect(r.needsPlanning).toBe(true)
    })
    it('查看/搜索类短消息 → simple + lightweight', () => {
        const r = createDefaultResult('查看当前目录结构')
        expect(r.complexity).toBe('simple')
        expect(r.suggestedModel).toBe('lightweight')
    })
    it('普通短消息 → primary', () => {
        const r = createDefaultResult('你好')
        expect(r.suggestedModel).toBe('primary')
    })
    it('长文本（>400 字）→ complex + reasoning', () => {
        const r = createDefaultResult('x'.repeat(450))
        expect(r.complexity).toBe('complex')
        expect(r.suggestedModel).toBe('reasoning')
    })
})
