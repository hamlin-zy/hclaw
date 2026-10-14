import {describe, expect, it} from 'vitest'
import {toToolPayload} from '@/main/agent/mcp/toolPayload'

describe('toToolPayload 跨线程投影', () => {
    it('透传 annotations 两字段', () => {
        const p = toToolPayload({
            name: 'x',
            description: 'd',
            inputSchema: {type: 'object', properties: {}},
            annotations: {readOnlyHint: true, destructiveHint: false},
        })
        expect(p.annotations).toEqual({readOnlyHint: true, destructiveHint: false})
    })

    it('裁掉多余字段（title/execution 等）', () => {
        const p = toToolPayload({
            name: 'x',
            inputSchema: {type: 'object', properties: {}},
            annotations: {readOnlyHint: true, title: 'T'} as any,
        } as any)
        expect(Object.keys(p).sort()).toEqual(['annotations', 'description', 'inputSchema', 'name'])
    })

    it('无 annotations 时不写该字段', () => {
        const p = toToolPayload({name: 'x', inputSchema: {type: 'object', properties: {}}})
        expect('annotations' in p).toBe(false)
    })

    it('annotations 只含无关字段（title）→ 不写该字段（防空壳被判 write）', () => {
        const p = toToolPayload({
            name: 'x',
            inputSchema: {type: 'object', properties: {}},
            annotations: {title: 'T'} as any,
        } as any)
        expect('annotations' in p).toBe(false)
    })

    it('annotations 为空对象 → 不写该字段', () => {
        const p = toToolPayload({
            name: 'x',
            inputSchema: {type: 'object', properties: {}},
            annotations: {},
        })
        expect('annotations' in p).toBe(false)
    })
})
