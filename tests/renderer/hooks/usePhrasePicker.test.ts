import {describe, it, expect} from 'vitest'
import {insertAtCursor} from '../../../src/renderer/hooks/usePhrasePicker'

describe('insertAtCursor', () => {
    it('在光标处插入（无选区）', () => {
        expect(insertAtCursor('ab', 1, 1, 'X')).toEqual({value: 'aXb', cursor: 2})
    })
    it('替换选区', () => {
        expect(insertAtCursor('abcd', 1, 3, 'X')).toEqual({value: 'aXd', cursor: 2})
    })
    it('多行 content 按字符串索引插入', () => {
        expect(insertAtCursor('ab', 1, 1, 'X\nY')).toEqual({value: 'aX\nYb', cursor: 4})
    })
})
