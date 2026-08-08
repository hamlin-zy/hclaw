import {describe, it, expect} from 'vitest'
import {resolveToolName, parseToolSpec, TOOL_NAME_ALIASES} from '../../../../src/main/agent/tools/toolNameResolver'

describe('resolveToolName', () => {
    it('精确匹配 HClaw 原生工具名', () => {
        expect(resolveToolName('file_read', ['file_read', 'file_write'])).toBe('file_read')
        expect(resolveToolName('glob', ['glob', 'grep'])).toBe('glob')
    })

    it('别名表：read → file_read', () => {
        expect(resolveToolName('read', ['file_read', 'file_write'])).toBe('file_read')
    })

    it('别名表：write → file_write', () => {
        expect(resolveToolName('write', ['file_read', 'file_write'])).toBe('file_write')
    })

    it('别名表：edit → file_edit', () => {
        expect(resolveToolName('edit', ['file_read', 'file_edit'])).toBe('file_edit')
    })

    it('别名表：NotebookEdit → notebook_edit（大小写不敏感）', () => {
        expect(resolveToolName('NotebookEdit', ['notebook_edit'])).toBe('notebook_edit')
    })

    it('忽略大小写模糊匹配', () => {
        expect(resolveToolName('READ', ['file_read'])).toBe('file_read')
    })

    it('别名目标不存在时返回 undefined', () => {
        expect(resolveToolName('write', ['file_read'])).toBeUndefined()
    })

    it('未知名（TaskWrite）返回 undefined', () => {
        expect(resolveToolName('TaskWrite', ['file_write'])).toBeUndefined()
    })

    it('不存在的工具名返回 undefined', () => {
        expect(resolveToolName('nonexistent', ['file_read'])).toBeUndefined()
    })
})

describe('parseToolSpec', () => {
    it('解析 rule', () => {
        expect(parseToolSpec('bash:always')).toEqual({toolName: 'bash', rule: 'always'})
    })

    it('无 rule', () => {
        expect(parseToolSpec('file_read')).toEqual({toolName: 'file_read', rule: undefined})
    })

    it('多个冒号仅取第一个', () => {
        expect(parseToolSpec('a:b:c')).toEqual({toolName: 'a', rule: 'b'})
    })
})

describe('TOOL_NAME_ALIASES', () => {
    it('包含 notebookedit 映射（回归：修复前缺失）', () => {
        expect(TOOL_NAME_ALIASES['notebookedit']).toBe('notebook_edit')
    })
})
