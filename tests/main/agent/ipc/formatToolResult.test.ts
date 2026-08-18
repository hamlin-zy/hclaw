/**
 * formatToolResult — tool_result 格式化算法的单元测试
 *
 * 该函数是 tool_result 内容的唯一格式权威（loop 内存态 / 落库存储 / 历史重建
 * 三端共用）。这里的每个 case 必须与三端行为一致，任何修改都会影响缓存一致性。
 */
import {describe, expect, it} from 'vitest'
import {formatToolResult} from '@shared/utils/toolResult'

describe('formatToolResult — 成功分支', () => {
    it('字符串输出原样返回', () => {
        expect(formatToolResult({success: true, output: 'hello'})).toBe('hello')
    })

    it('对象输出 JSON.stringify(…, null, 2)', () => {
        expect(formatToolResult({success: true, output: {a: 1, b: [1, 2]}}))
            .toBe(JSON.stringify({a: 1, b: [1, 2]}, null, 2))
    })

    it('数组输出 JSON.stringify(…, null, 2)', () => {
        expect(formatToolResult({success: true, output: ['a', 'b']}))
            .toBe(JSON.stringify(['a', 'b'], null, 2))
    })

    it('数字输出 JSON.stringify 序列化', () => {
        expect(formatToolResult({success: true, output: 42})).toBe('42')
    })

    it('空字符串输出返回空字符串（不产生 "null" / 空 JSON）', () => {
        expect(formatToolResult({success: true, output: ''})).toBe('')
    })

    it('null 输出返回空字符串（不产生 "null" 字面量）', () => {
        expect(formatToolResult({success: true, output: null})).toBe('')
    })

    it('undefined 输出返回空字符串', () => {
        expect(formatToolResult({success: true, output: undefined})).toBe('')
    })
})

describe('formatToolResult — 失败分支', () => {
    it('有错误无输出：[ERROR] 前缀', () => {
        expect(formatToolResult({success: false, output: null, error: 'boom'}))
            .toBe('[ERROR] boom')
    })

    it('有错误有字符串输出：错误换行后追加输出', () => {
        expect(formatToolResult({success: false, output: 'partial', error: 'boom'}))
            .toBe('[ERROR] boom\npartial')
    })

    it('有错误有对象输出：错误换行后追加格式化 JSON', () => {
        expect(formatToolResult({success: false, output: {x: 1}, error: 'boom'}))
            .toBe('[ERROR] boom\n' + JSON.stringify({x: 1}, null, 2))
    })

    it('失败且无错误信息且无输出：空字符串', () => {
        expect(formatToolResult({success: false, output: '', error: undefined})).toBe('')
    })

    it('失败但空字符串输出不追加空 JSON（"" 视为无输出）', () => {
        expect(formatToolResult({success: false, output: '', error: 'boom'})).toBe('[ERROR] boom')
    })
})

describe('formatToolResult — success 判定边界', () => {
    it('success 严格 true 才算成功（undefined 走失败分支但无 error 时输出原样）', () => {
        // !undefined = true → 失败分支；error 为空 → errorPart=''，只有 output
        expect(formatToolResult({success: undefined as unknown as boolean, output: 'x'})).toBe('x')
    })

    it('success 为 false 时即使有输出也走失败分支', () => {
        expect(formatToolResult({success: false, output: 'data', error: 'err'}))
            .toBe('[ERROR] err\ndata')
    })
})
