/**
 * displaySegments 纯函数边界回归测试（Task 0.5 / C11 前置）
 *
 * 目标模块：src/renderer/components/message-list/utils/displaySegments.ts
 *
 * 覆盖范围：仅补既有 compactPopup.live.test.tsx 内 `describe('displaySegments 纯函数')`
 * 3 个 it 未覆盖的边界（ultraCompact 分段数/内容差异、空 toolCalls、锚点未命中、
 * 单元素组、组合组与工具组交错顺序稳定性）。既有 it 已覆盖的用例不在此重复。
 *
 * fixture 构造方式与 compactPopup.live.test.tsx 保持一致。
 */
import {describe, it, expect} from 'vitest'
import {
    buildDisplaySegments,
    resolveGroupByAnchor,
    resolveToolCallsByAnchor,
} from '../../../../src/renderer/components/message-list/utils/displaySegments'

// ── 测试数据构造（对齐 compactPopup.live.test.tsx 的风格）────
const tc = (id: string) => ({id, name: 'bash', arguments: {command: `echo ${id}`}, status: 'success' as const})
const thinkBlock = (id: string) => ({id, content: `think-${id}`, status: 'complete' as const, timestamp: 1})
const toolBlock = (id: string) => ({id: `cb-${id}`, type: 'tool_use' as const, toolCall: tc(id)})
const thinkCb = (id: string) => ({id, type: 'think' as const, thinkBlock: thinkBlock(id)})
const textCb = (id: string, text: string) => ({id, type: 'text' as const, text})
const msg = (id: string, blocks: any[]) => ({id, role: 'assistant', content: '', contentBlocks: blocks} as any)

describe('displaySegments 边界（C11 前置）', () => {
    it('buildDisplaySegments：ultraCompact=false/true 的分段数与内容差异（非 .some 的精确断言）', () => {
        const m = msg('m1', [textCb('t1', 'hello'), toolBlock('tc1'), toolBlock('tc2')])

        const base = buildDisplaySegments(m, false)
        expect(base.map((s) => s.type)).toEqual(['text', 'tool', 'tool'])
        expect(base.length).toBe(3)

        const compact = buildDisplaySegments(m, true)
        expect(compact.map((s) => s.type)).toEqual(['text', 'combined-group'])
        expect(compact.length).toBe(2)
    })

    it('buildDisplaySegments：空 toolCalls 数组 → 只产出文本段（旧路径）', () => {
        const m = {id: 'm2', role: 'assistant', content: 'plain text', toolCalls: []} as any

        const base = buildDisplaySegments(m, false)
        expect(base).toEqual([{type: 'text', content: 'plain text'}])
        expect(base.some((s) => s.type === 'tool' || s.type === 'tool-group')).toBe(false)

        const compact = buildDisplaySegments(m, true)
        expect(compact).toEqual([{type: 'text', content: 'plain text'}])
        expect(compact.length).toBe(1)
    })

    it('resolveToolCallsByAnchor：blockId-only / 空 segments / 幽灵 toolCallId → 均返回 null', () => {
        const segments = buildDisplaySegments(msg('m1', [thinkCb('b1'), toolBlock('tc1')]), true)
        // 前置：确实存在可命中的 combined-group（否则本用例失去意义）
        expect(resolveToolCallsByAnchor(segments, {toolCallId: 'tc1'})?.map((c) => c.id)).toEqual(['tc1'])

        // blockId-only 锚点：resolveToolCallsByAnchor 只认 toolCallId，故即便 b1 存在也应返回 null
        expect(resolveToolCallsByAnchor(segments, {blockId: 'b1'})).toBeNull()
        // 空 segments
        expect(resolveToolCallsByAnchor([], {toolCallId: 'tc1'})).toBeNull()
        // 幽灵 toolCallId
        expect(resolveToolCallsByAnchor(segments, {toolCallId: 'ghost'})).toBeNull()
    })

    it('resolveGroupByAnchor：单元素工具组 / 单元素思考组', () => {
        const singleTool = buildDisplaySegments(msg('m1', [toolBlock('tc1')]), true)
        expect(singleTool.map((s) => s.type)).toEqual(['combined-group'])
        const gTool = resolveGroupByAnchor(singleTool, {toolCallId: 'tc1'})
        expect(gTool?.items.length).toBe(1)
        expect(gTool?.items[0].type).toBe('tools')
        expect(gTool?.thinkCount).toBe(0)
        expect(gTool?.toolCalls.map((c) => c.id)).toEqual(['tc1'])

        const singleThink = buildDisplaySegments(msg('m1', [thinkCb('b1')]), true)
        expect(singleThink.map((s) => s.type)).toEqual(['combined-group'])
        const gThink = resolveGroupByAnchor(singleThink, {blockId: 'b1'})
        expect(gThink?.items.length).toBe(1)
        expect(gThink?.items[0].type).toBe('think')
        expect(gThink?.thinkCount).toBe(1)
        expect(gThink?.toolCalls.length).toBe(0)
    })

    it('buildDisplaySegments：组合组与工具组交错时顺序稳定', () => {
        const m = msg('m1', [
            thinkCb('b1'),
            toolBlock('tc1'),
            textCb('t1', 'body'),
            toolBlock('tc2'),
            toolBlock('tc3'),
        ])

        const segs = buildDisplaySegments(m, true)
        expect(segs.map((s) => s.type)).toEqual(['combined-group', 'text', 'combined-group'])

        const c0 = segs[0]
        expect(c0.type).toBe('combined-group')
        if (c0.type === 'combined-group') {
            expect(c0.thinkCount).toBe(1)
            expect(c0.items.map((it) => it.type)).toEqual(['think', 'tools'])
            const toolsItem = c0.items[1]
            expect(toolsItem.type === 'tools' ? toolsItem.toolCalls.map((c) => c.id) : []).toEqual(['tc1'])
            expect(c0.toolCalls.map((c) => c.id)).toEqual(['tc1'])
        }

        const c2 = segs[2]
        expect(c2.type).toBe('combined-group')
        if (c2.type === 'combined-group') {
            expect(c2.thinkCount).toBe(0)
            expect(c2.toolCalls.map((c) => c.id)).toEqual(['tc2', 'tc3'])
        }

        // 交错后锚点仍能定位到正确的组，且顺序保持
        expect(resolveToolCallsByAnchor(segs, {toolCallId: 'tc1'})?.map((c) => c.id)).toEqual(['tc1'])
        expect(resolveToolCallsByAnchor(segs, {toolCallId: 'tc3'})?.map((c) => c.id)).toEqual(['tc2', 'tc3'])
    })
})
