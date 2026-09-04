// @vitest-environment jsdom
/**
 * PhrasePicker 组件测试
 *
 * 覆盖用例：
 * 1. lastUsedAt 降序排序（最近使用在前）
 * 2. 搜索过滤 content（大小写不敏感）
 * 3. Enter 触发 onPick（当前高亮项）
 * 4. 无短语空态文案
 *
 * mock 约定：使用真实 zustand store（setState 注入 phrases）；
 * 组件 open 时会 void load() → window.electronAPI.phrase.list()，
 * 因此 seed() 同时 mock list 返回注入的 phrases，避免 load 覆盖测试数据。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {useState} from 'react'
import {render, screen, fireEvent, cleanup} from '@testing-library/react'
import {usePhraseStore} from '../../../src/renderer/stores/phraseStore'
import PhrasePicker from '../../../src/renderer/components/PhrasePicker'
import type {PhraseItem} from '../../../src/shared/types/phrase'

const item = (over: Partial<PhraseItem> = {}): PhraseItem =>
    ({id: 'p1', content: 'hello', createdAt: 1, updatedAt: 1, lastUsedAt: 1, ...over})

/** 注入 phrases 并同步 mock electronAPI.phrase.list（防止 load() 用空数据覆盖） */
const seed = (phrases: PhraseItem[]) => {
    usePhraseStore.setState({phrases, loading: false, error: null})
    ;(window as any).electronAPI.phrase.list = vi.fn().mockResolvedValue({ok: true, data: phrases})
}

const noop = () => {}

describe('PhrasePicker', () => {
    beforeEach(() => {
        // jsdom 未实现 scrollIntoView
        Element.prototype.scrollIntoView = vi.fn()
        usePhraseStore.setState({phrases: [], loading: false, error: null})
        ;(window as any).electronAPI = {phrase: {list: vi.fn().mockResolvedValue({ok: true, data: []})}}
        vi.restoreAllMocks()
    })

    afterEach(() => {
        cleanup()
    })

    it('按 lastUsedAt 降序排序（最近使用在前）', () => {
        seed([
            item({id: 'a', content: 'AAA', lastUsedAt: 10}),
            item({id: 'b', content: 'BBB', lastUsedAt: 30}),
            item({id: 'c', content: 'CCC', lastUsedAt: 20}),
        ])
        render(<PhrasePicker open anchorRef={{current: null}} onClose={noop} onPick={noop} />)
        const texts = screen.getAllByText(/AAA|BBB|CCC/)
        expect(texts[0].textContent).toBe('BBB')
        expect(texts[2].textContent).toBe('AAA')
    })

    it('搜索过滤 content', () => {
        seed([item({id: 'a', content: 'apple'}), item({id: 'b', content: 'banana'})])
        render(<PhrasePicker open anchorRef={{current: null}} onClose={noop} onPick={noop} />)
        fireEvent.change(screen.getByPlaceholderText('搜索快捷短语…'), {target: {value: 'app'}})
        expect(screen.getByText('apple')).toBeTruthy()
        expect(screen.queryByText('banana')).toBeNull()
    })

    it('Enter 触发 onPick（当前高亮项）', () => {
        const onPick = vi.fn()
        seed([item({id: 'a', content: 'apple'}), item({id: 'b', content: 'banana'})])
        render(<PhrasePicker open anchorRef={{current: null}} onClose={noop} onPick={onPick} />)
        // createPortal 渲染到 document.body，不在 container 内
        const panel = document.body.querySelector('[data-name="phrase-picker-panel"]')!
        fireEvent.keyDown(panel, {key: 'Enter'})
        expect(onPick).toHaveBeenCalledWith(expect.objectContaining({content: 'apple'}))
    })

    it('无短语时显示空态文案', () => {
        seed([])
        render(<PhrasePicker open anchorRef={{current: null}} onClose={noop} onPick={noop} />)
        expect(screen.getByText(/暂无快捷短语/)).toBeTruthy()
    })

    it('↑↓ 循环导航（首项 ArrowUp 循环到末项，末项 ArrowDown 循环回首项）', () => {
        const onPick = vi.fn()
        seed([item({id: 'a', content: 'AAA'}), item({id: 'b', content: 'BBB'}), item({id: 'c', content: 'CCC'})])
        render(<PhrasePicker open anchorRef={{current: null}} onClose={noop} onPick={onPick} />)
        const panel = document.body.querySelector('[data-name="phrase-picker-panel"]')!
        // 首项 sel=0，ArrowUp → 循环到末项 CCC
        fireEvent.keyDown(panel, {key: 'ArrowUp'})
        fireEvent.keyDown(panel, {key: 'Enter'})
        expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({content: 'CCC'}))
        // 末项 sel=2，ArrowDown → 循环回首项 AAA
        fireEvent.keyDown(panel, {key: 'ArrowDown'})
        fireEvent.keyDown(panel, {key: 'Enter'})
        expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({content: 'AAA'}))
    })

    it('Esc 触发 onClose', () => {
        const onClose = vi.fn()
        seed([item({id: 'a', content: 'AAA'})])
        render(<PhrasePicker open anchorRef={{current: null}} onClose={onClose} onPick={noop} />)
        const panel = document.body.querySelector('[data-name="phrase-picker-panel"]')!
        fireEvent.keyDown(panel, {key: 'Escape'})
        expect(onClose).toHaveBeenCalled()
    })

    it('搜索无结果显示未找到文案', () => {
        seed([item({id: 'a', content: 'apple'})])
        render(<PhrasePicker open anchorRef={{current: null}} onClose={noop} onPick={noop} />)
        fireEvent.change(screen.getByPlaceholderText('搜索快捷短语…'), {target: {value: 'zzz'}})
        expect(screen.getByText(/未找到匹配/)).toBeTruthy()
    })

    it('Esc 关闭后焦点回到锚定 textarea', () => {
        seed([item({id: 'a', content: 'AAA'})])
        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        const anchorRef = {current: ta}
        function Wrapper() {
            const [open, setOpen] = useState(true)
            return <PhrasePicker open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} onPick={noop} />
        }
        render(<Wrapper />)
        const panel = document.body.querySelector('[data-name="phrase-picker-panel"]')!
        fireEvent.keyDown(panel, {key: 'Escape'})
        expect(document.activeElement).toBe(ta)
        ta.remove()
    })

    it('picker 内 Enter/Esc 不冒泡到父级 onKeyDown', () => {
        const parentKeyDown = vi.fn()
        seed([item({id: 'a', content: 'AAA'})])
        render(
            <div onKeyDown={parentKeyDown}>
                <PhrasePicker open anchorRef={{current: null}} onClose={noop} onPick={noop} />
            </div>
        )
        const panel = document.body.querySelector('[data-name="phrase-picker-panel"]')!
        fireEvent.keyDown(panel, {key: 'Enter'})
        fireEvent.keyDown(panel, {key: 'Escape'})
        expect(parentKeyDown).not.toHaveBeenCalled()
    })
})
