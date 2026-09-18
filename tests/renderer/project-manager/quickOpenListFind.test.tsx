// @vitest-environment jsdom
/**
 * QuickOpen 列表在 Find in Files 模式下的渲染（工单 05）：文件名 + 行号 + 命中文本高亮、
 * 每文件折叠行、截断标注、触底滚动的接线、翻页加载状态行。
 *
 * 只喂 props 看渲染结果，不测键位手感与 IPC（spec §Testing Decisions）。
 */
import {describe, it, expect, vi} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {QuickOpen, quickOpenEmptyText, type QuickOpenProps} from '../../../src/renderer/project-manager/components/QuickOpen'
import type {QuickOpenItem} from '../../../src/renderer/project-manager/lib/quickOpenResults'

const findItem = (path: string, line: number, extra: Partial<QuickOpenItem> = {}): QuickOpenItem =>
    ({path, matchStart: 0, matchEnd: 4, line, matchText: `const a = 1 line ${line}`, ...extra})

function renderQuickOpen(overrides: Partial<QuickOpenProps> = {}) {
    const props: QuickOpenProps = {
        mode: 'find-in-files',
        query: 'a',
        onQueryChange: vi.fn(),
        results: [],
        activeIndex: 0,
        loading: false,
        truncated: false,
        error: null,
        stalePaths: new Set<string>(),
        onActivate: vi.fn(),
        ...overrides,
    }
    return {...render(<QuickOpen {...props} />), props}
}

const rows = () => screen.queryAllByTestId('pm-quickopen-row')

describe('Find in Files 列表', () => {
    it('行标明文件名与行号，行内命中区间高亮', () => {
        renderQuickOpen({results: [findItem('src/app.ts', 12)]})
        expect(rows()).toHaveLength(1)
        expect(rows()[0].querySelector('.pm-quickopen-row-name')).toHaveTextContent('app.ts')
        expect(rows()[0].querySelector('.pm-quickopen-row-line')).toHaveTextContent(':12')
        expect(rows()[0].querySelector('.pm-quickopen-row-text mark')).toHaveTextContent('cons')
        // 命中区间是行内区间，绝不能拿去高亮路径段
        expect(rows()[0].querySelector('.pm-quickopen-row-dir mark')).toBeNull()
    })

    it('每页命中项全部渲染（页大小由 hook 决定，列表不另设上限）', () => {
        const results = Array.from({length: 20}, (_, i) => findItem(`src/f${i}.ts`, i + 1))
        renderQuickOpen({results})
        expect(rows()).toHaveLength(20)
    })

    it('同一文件命中过多：在末行之后插一行「还有 M 处」', () => {
        const results = [findItem('src/a.ts', 1), findItem('src/a.ts', 2), findItem('src/b.ts', 7)]
        renderQuickOpen({results, findFolds: new Map([['src/a.ts', 5]])})
        const fold = screen.getByTestId('pm-quickopen-fold')
        expect(fold).toHaveTextContent('还有 5 处')
        // 折叠行落在 a.ts 的最后一行之后（b.ts 之前）
        expect(rows()[1].compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(fold.compareDocumentPosition(rows()[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('同一文件命中非连续出现：折叠行仍只出一行，且落在该文件最后一行之后', () => {
        const results = [
            findItem('src/a.ts', 1),
            findItem('src/a.ts', 2),
            findItem('src/b.ts', 7),
            findItem('src/a.ts', 9),
        ]
        renderQuickOpen({results, findFolds: new Map([['src/a.ts', 5]])})
        const folds = screen.queryAllByTestId('pm-quickopen-fold')
        expect(folds).toHaveLength(1)
        // 末次出现是第 4 行（index 3），折叠行必须在其后
        expect(rows()[3].compareDocumentPosition(folds[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('没有折叠时不出折叠行', () => {
        renderQuickOpen({results: [findItem('src/a.ts', 1)], findFolds: new Map()})
        expect(screen.queryByTestId('pm-quickopen-fold')).toBeNull()
    })

    it('触底：列表滚动把容器度量交给 onListScroll', () => {
        const onListScroll = vi.fn()
        renderQuickOpen({results: [findItem('src/a.ts', 1)], onListScroll})
        const list = screen.getByTestId('pm-quickopen-list')
        Object.defineProperty(list, 'scrollHeight', {value: 1300, configurable: true})
        Object.defineProperty(list, 'clientHeight', {value: 400, configurable: true})
        Object.defineProperty(list, 'scrollTop', {value: 900, configurable: true})
        fireEvent.scroll(list)
        expect(onListScroll).toHaveBeenCalledWith({scrollTop: 900, scrollHeight: 1300, clientHeight: 400})
    })

    it('翻页在途：列表底部给出加载状态行', () => {
        renderQuickOpen({results: [findItem('src/a.ts', 1)], loadingMore: true})
        const more = screen.getByTestId('pm-quickopen-loading-more')
        expect(more).toHaveTextContent('加载中')
        expect(more.querySelector('.pm-spin')).not.toBeNull()
    })

    it('缓冲被截断：标注与 File Search 不同的文案', () => {
        renderQuickOpen({results: [findItem('src/a.ts', 1)], truncated: true})
        expect(screen.getByTestId('pm-quickopen-truncated')).toHaveTextContent('检索结果已达上限')
    })

    it('草稿态与无结果：给出各自的引导文案', () => {
        renderQuickOpen({query: ''})
        expect(screen.getByTestId('pm-quickopen-empty')).toHaveTextContent('输入要检索的内容')
        expect(quickOpenEmptyText('find-in-files', 'zzz', 0, null)).toBe('无匹配内容')
        expect(quickOpenEmptyText('find-in-files', 'zzz', 3, null)).toBe(null)
    })
})
