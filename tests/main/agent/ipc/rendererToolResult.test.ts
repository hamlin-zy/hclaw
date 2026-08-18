/**
 * 渲染进程落库路径一致性测试
 *
 * 背景：渲染进程块级增量（recordToolResultBlock）是**主要落库路径**，
 * 其 normalizeToolResult（helpers/misc.ts）是与主进程独立的实现。
 * 若两处 output 处理或 toolResult 算法不一致，DB 中会混入不同格式，
 * 破坏重建一致性。本测试保证渲染进程路径与主进程路径输出一致。
 */
import {describe, expect, it} from 'vitest'
import {normalizeToolResult as rendererNormalize} from '@/renderer/stores/agentStore/helpers/misc'
import {normalizeToolResult as mainNormalize} from '@/main/agent/manager.accumulator'
import {formatToolResult} from '@shared/utils/toolResult'

describe('渲染进程 normalizeToolResult — 与主进程行为一致', () => {
    const cases: Array<{name: string; raw: unknown}> = [
        {name: '成功字符串', raw: {success: true, output: 'hello'}},
        {name: '成功对象', raw: {success: true, output: {a: 1, b: [1, 2]}}},
        {name: '成功数组', raw: {success: true, output: ['x', 'y']}},
        {name: '成功数字', raw: {success: true, output: 42}},
        {name: '成功空字符串', raw: {success: true, output: ''}},
        {name: '失败+错误', raw: {success: false, output: null, error: 'boom'}},
        {name: '失败+错误+输出', raw: {success: false, output: 'partial', error: 'boom'}},
        {name: '失败+对象输出', raw: {success: false, output: {x: 1}, error: 'err'}},
        {name: 'null 输入', raw: null},
        {name: 'undefined 输入', raw: undefined},
    ]

    for (const c of cases) {
        it(`${c.name}：toolResult 与主进程一致`, () => {
            const r = rendererNormalize(c.raw)
            const m = mainNormalize(c.raw)
            expect(r.toolResult).toBe(m.toolResult)
        })
    }

    it('toolResult 字段存在且非空字符串（除 null 输入）', () => {
        const r = rendererNormalize({success: true, output: 'hi'})
        expect(typeof r.toolResult).toBe('string')
        expect(r.toolResult).toBe('hi')
    })

    it('输出对象不丢失格式（不产生 [object Object]）', () => {
        const r = rendererNormalize({success: true, output: {files: ['a']}})
        expect(r.output).toContain('"files"')
        expect(r.output).not.toContain('[object Object]')
    })

    it('toolResult 字段与 formatToolResult 直接调用一致（三端同源）', () => {
        const raw = {success: false, output: 'out', error: 'err'}
        const r = rendererNormalize(raw)
        expect(r.toolResult).toBe(formatToolResult({success: false, output: 'out', error: 'err'}))
    })
})
