// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import {usePhraseStore} from '../../../../src/renderer/stores/phraseStore'
import PhraseDialog from '../../../../src/renderer/components/dialogs/PhraseDialog'

const item = (over: Partial<any> = {}) => ({id: 'p1', content: 'hello', createdAt: 1, updatedAt: 1, lastUsedAt: 1, ...over})

/** 注入 store 数据并让 phrase.list mock 返回同一份数据，避免 mount 时 load() 用 data:[] 覆盖 */
function seed(phrases: any[]) {
    usePhraseStore.setState({phrases: [...phrases], loading: false, error: null})
    ;(window as any).electronAPI.phrase.list = vi.fn().mockResolvedValue({ok: true, data: phrases})
}

describe('PhraseDialog', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        ;(window as any).electronAPI = {phrase: {list: vi.fn().mockResolvedValue({ok: true, data: []})}, onPhraseChanged: vi.fn(() => () => {})}
    })

    it('按 createdAt 降序排序', () => {
        seed([
            item({id: 'a', content: 'AAA', createdAt: 10}),
            item({id: 'b', content: 'BBB', createdAt: 30}),
        ])
        render(<PhraseDialog />)
        const texts = screen.getAllByText(/AAA|BBB/)
        expect(texts[0].textContent).toBe('BBB')
    })

    it('空态显示引导文案', () => {
        seed([])
        render(<PhraseDialog />)
        expect(screen.getByText(/还没有快捷短语/)).toBeTruthy()
    })

    it('点击新增进入编辑态', () => {
        seed([])
        render(<PhraseDialog />)
        fireEvent.click(screen.getByText('新增'))
        expect(screen.getByPlaceholderText('输入短语内容…')).toBeTruthy()
    })

    it('有既有条目时点击新增，编辑项出现在列表首位', () => {
        seed([item({id: 'a', content: 'AAA', createdAt: 30})])
        render(<PhraseDialog />)
        fireEvent.click(screen.getByText('新增'))
        const textarea = screen.getByPlaceholderText('输入短语内容…')
        const phrase = screen.getByText('AAA')
        expect(textarea.compareDocumentPosition(phrase) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
})
