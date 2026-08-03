import {describe, expect, it} from 'vitest'
import type {ConversationSummary} from '@shared/types'
import {collectDescendants} from '@/renderer/stores/conversationTree'

/** 构造最小 ConversationSummary（仅测试需要的字段） */
function conv(id: string, parentConvId?: string): ConversationSummary {
    return {
        id,
        title: id,
        preview: '',
        updatedAt: 0,
        status: 'active',
        ...(parentConvId ? {parentConvId} : {}),
    } as ConversationSummary
}

describe('collectDescendants — 级联删除后代收集', () => {
    it('一级子会话：root → [c1, c2]，删除 root 收集全部', () => {
        const convs = [conv('root'), conv('c1', 'root'), conv('c2', 'root')]
        const result = collectDescendants(convs, ['root'])
        expect(new Set(result)).toEqual(new Set(['root', 'c1', 'c2']))
    })

    it('嵌套（深度 2+）：root → c1 → c1a → c1a1，递归收集', () => {
        const convs = [
            conv('root'),
            conv('c1', 'root'),
            conv('c1a', 'c1'),
            conv('c1a1', 'c1a'),
        ]
        const result = collectDescendants(convs, ['root'])
        expect(new Set(result)).toEqual(new Set(['root', 'c1', 'c1a', 'c1a1']))
    })

    it('删除集合去重：root → [c1, c2]，同时选 root 与 c1 无重复', () => {
        const convs = [conv('root'), conv('c1', 'root'), conv('c2', 'root')]
        const result = collectDescendants(convs, ['root', 'c1'])
        expect(new Set(result)).toEqual(new Set(['root', 'c1', 'c2']))
    })

    it('批量含多个父 + 独立子树：a → a1，b → b1 → b1a', () => {
        const convs = [
            conv('a'), conv('a1', 'a'),
            conv('b'), conv('b1', 'b'), conv('b1a', 'b1'),
        ]
        const result = collectDescendants(convs, ['a', 'b'])
        expect(new Set(result)).toEqual(new Set(['a', 'a1', 'b', 'b1', 'b1a']))
    })

    it('无子会话：删除叶子只返回自身（回归）', () => {
        const convs = [conv('root'), conv('leaf', 'root')]
        const result = collectDescendants(convs, ['leaf'])
        expect(result).toEqual(['leaf'])
    })

    it('孤儿子会话（父已删除）：自身可删不崩溃（回归）', () => {
        const orphan = conv('orphan', 'deleted-parent')
        const result = collectDescendants([orphan], ['orphan'])
        expect(result).toEqual(['orphan'])
    })
})
