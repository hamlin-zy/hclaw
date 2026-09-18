// 纯函数单测：组视图「最近会话」跨项目列表构造
import {describe, it, expect} from 'vitest'
import {buildRecentConversations} from '../../../src/renderer/lib/recentConversations'
import type {ConversationSummary} from '../../../src/shared/types/infra'

const conv = (over: Partial<ConversationSummary>): ConversationSummary => ({
    id: 'c', title: 't', preview: '', createdAt: 0, updatedAt: 0, ...over,
})

describe('buildRecentConversations', () => {
    it('按 updatedAt desc 排序（新者在前），跨项目混排', () => {
        const result = buildRecentConversations([
            {workspacePath: '/ws/a', conversations: [conv({id: 'a1', updatedAt: 100})]},
            {workspacePath: '/ws/b', conversations: [conv({id: 'b1', updatedAt: 300}), conv({id: 'b2', updatedAt: 200})]},
        ])
        expect(result.map(r => r.conv.id)).toEqual(['b1', 'b2', 'a1'])
        expect(result[0].workspacePath).toBe('/ws/b')
    })

    it('limit 截断（默认 10）', () => {
        const convs = Array.from({length: 15}, (_, i) => conv({id: `c${i}`, updatedAt: i}))
        const result = buildRecentConversations([{workspacePath: '/ws/a', conversations: convs}])
        expect(result).toHaveLength(10)
        expect(result[0].conv.id).toBe('c14')
    })

    it('自定义 limit', () => {
        const convs = [conv({id: 'x', updatedAt: 1}), conv({id: 'y', updatedAt: 2})]
        expect(buildRecentConversations([{workspacePath: '/ws/a', conversations: convs}], 1)).toHaveLength(1)
    })

    it('某项目 conversations 为空 → 跳过，不影响其他项目', () => {
        const result = buildRecentConversations([
            {workspacePath: '/ws/a', conversations: []},
            {workspacePath: '/ws/b', conversations: [conv({id: 'b1', updatedAt: 5})]},
        ])
        expect(result.map(r => r.conv.id)).toEqual(['b1'])
    })

    it('入参全空 → 返回 []', () => {
        expect(buildRecentConversations([])).toEqual([])
        expect(buildRecentConversations([{workspacePath: '/ws/a', conversations: []}])).toEqual([])
    })

    it('同 updatedAt 保持入参稳定次序', () => {
        const result = buildRecentConversations([
            {workspacePath: '/ws/a', conversations: [conv({id: 'a1', updatedAt: 10}), conv({id: 'a2', updatedAt: 10})]},
            {workspacePath: '/ws/b', conversations: [conv({id: 'b1', updatedAt: 10})]},
        ])
        expect(result.map(r => r.conv.id)).toEqual(['a1', 'a2', 'b1'])
    })

    it('子会话（父会话在同项目集合内）不进最近列表；孤儿（父不在集合内）视为根照常入选', () => {
        const result = buildRecentConversations([
            {
                workspacePath: '/ws/a',
                conversations: [
                    conv({id: 'root', updatedAt: 100}),
                    conv({id: 'child', parentConvId: 'root', updatedAt: 300}), // 最新但是子会话 → 排除
                    conv({id: 'orphan', parentConvId: 'gone', updatedAt: 200}), // 父已不在 → 算根
                ],
            },
        ])
        expect(result.map(r => r.conv.id)).toEqual(['orphan', 'root'])
    })

    it('子会话过滤按项目隔离：父在另一项目不算命中', () => {
        const result = buildRecentConversations([
            {workspacePath: '/ws/a', conversations: [conv({id: 'p', updatedAt: 1})]},
            {workspacePath: '/ws/b', conversations: [conv({id: 'c', parentConvId: 'p', updatedAt: 99})]},
        ])
        // /ws/b 的 c 的父不在 /ws/b 集合内 → 孤儿算根，入选
        expect(result.map(r => r.conv.id)).toEqual(['c', 'p'])
    })
})
