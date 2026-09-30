// @vitest-environment jsdom
/**
 * ThinkBlock 显示模式折叠契约
 *
 * 契约：显示模式 = 思考块的折叠默认态。
 *   - 切到简洁/极简模式 → 已挂载的思考块一律折叠（含流式思考中、含用户手动展开过的）
 *   - 切回详细模式 → 一律展开
 * 防漂移红线（不得因本改动引入）：
 *   - `defaultExpanded` 变化（旧格式路径 status 由 thinking → complete 导致）不得触发重置，
 *     即“思考中→完成”不自动折叠；
 *   - 模式未变化时，任意重渲染不得改写用户在同一模式内的手动展开状态。
 *
 * 判别力（修复前 defaultExpanded 仅作挂载初值，实测结果）：
 *   - 用例「切简洁折叠 / 再切回详细展开」失败（切 compact 后 aria-expanded 仍为 true）；
 *   - 用例「旧格式：思考中→完成后切紧凑」失败（同为切 compact 不折叠）；
 *   - 其余用例修复前后均通过，仅作防漂移守卫，不承担判别力。
 */
import {act, fireEvent, render} from '@testing-library/react'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {ThinkBlock as ThinkBlockType} from '@shared/types'

vi.mock('@/renderer/stores/themeStore', () => ({
    useThemeStore: (selector: (s: {theme: string}) => unknown) => selector({theme: 'light'}),
}))

vi.mock('@/renderer/stores/settingsStore', () => ({
    useSettingsStore: () => ({settings: {linkOpening: {mode: 'ask'}, ui: {theme: 'light'}}}),
}))

vi.mock('@/renderer/components/message-list/MarkdownRenderer', () => ({
    default: ({children}: {children: string}) => <div>{children}</div>,
}))

import ThinkBlock from '@/renderer/components/ThinkBlock'
import {useAgentStore} from '@/renderer/stores/agentStore'

type Mode = 'detailed' | 'compact' | 'ultra-compact'

function makeThinkBlock(status: 'thinking' | 'complete' = 'complete'): ThinkBlockType {
    return {id: 'think-1', content: '思考内容', status, timestamp: 0}
}

function isExpanded(container: HTMLElement): boolean {
    const btn = container.querySelector('[data-name="collapsible-section-button"]')
    if (!btn) throw new Error('未找到折叠标题按钮')
    return btn.getAttribute('aria-expanded') === 'true'
}

/** 走真实 store 链路切换模式（含订阅穿透 memo 的真实路径） */
async function switchMode(mode: Mode) {
    await act(async () => {
        await useAgentStore.getState().setMessageDisplayMode(mode)
    })
}

describe('ThinkBlock 随显示模式切换折叠', () => {
    beforeEach(() => {
        useAgentStore.setState({messageDisplayMode: 'detailed'})
    })

    it('详细模式挂载即展开；切简洁折叠；再切回详细重新展开', async () => {
        const {container} = render(<ThinkBlock thinkBlock={makeThinkBlock()}/>)
        expect(isExpanded(container)).toBe(true)

        await switchMode('compact')
        expect(isExpanded(container)).toBe(false)

        await switchMode('detailed')
        expect(isExpanded(container)).toBe(true)
    })

    it('简洁模式下挂载即折叠；极简模式同样折叠', async () => {
        await switchMode('compact')
        const {container} = render(<ThinkBlock thinkBlock={makeThinkBlock()}/>)
        expect(isExpanded(container)).toBe(false)

        await switchMode('ultra-compact')
        expect(isExpanded(container)).toBe(false)
    })

    it('极简模式下用户手动展开的块，切回详细后仍为展开（重置而非保留）', async () => {
        await switchMode('compact')
        const {container} = render(<ThinkBlock thinkBlock={makeThinkBlock()}/>)
        const btn = container.querySelector('[data-name="collapsible-section-button"]') as HTMLElement

        fireEvent.click(btn)
        expect(isExpanded(container)).toBe(true)

        await switchMode('detailed')
        expect(isExpanded(container)).toBe(true)
    })

    it('紧凑族内切换（compact → ultra-compact，isCompact 不变）同样重置为折叠', async () => {
        await switchMode('compact')
        const {container} = render(<ThinkBlock thinkBlock={makeThinkBlock()}/>)
        const btn = container.querySelector('[data-name="collapsible-section-button"]') as HTMLElement

        fireEvent.click(btn)
        expect(isExpanded(container)).toBe(true)

        await switchMode('ultra-compact')
        expect(isExpanded(container)).toBe(false)
    })

    it('同一模式内用户手动折叠后，内容增量引发的重渲染不得改写其状态', async () => {
        const {container, rerender} = render(<ThinkBlock thinkBlock={makeThinkBlock()}/>)
        const btn = container.querySelector('[data-name="collapsible-section-button"]') as HTMLElement

        fireEvent.click(btn)
        expect(isExpanded(container)).toBe(false)

        // 同类重渲染：思考内容增量（模式未变）
        rerender(<ThinkBlock thinkBlock={{...makeThinkBlock(), content: '思考内容（增量）'}}/>)
        expect(isExpanded(container)).toBe(false)
    })

    it('思考中→完成不自动折叠；切简洁模式才折叠', async () => {
        const {container, rerender} = render(<ThinkBlock thinkBlock={makeThinkBlock('thinking')}/>)
        expect(isExpanded(container)).toBe(true)

        // status: thinking → complete —— 不得触发折叠
        rerender(<ThinkBlock thinkBlock={makeThinkBlock('complete')}/>)
        expect(isExpanded(container)).toBe(true)

        await switchMode('compact')
        expect(isExpanded(container)).toBe(false)
    })

    it('简洁模式下新挂载的“思考中”块即折叠（模式为唯一权威）', async () => {
        await switchMode('compact')
        const {container} = render(<ThinkBlock thinkBlock={makeThinkBlock('thinking')}/>)
        expect(isExpanded(container)).toBe(false)
        expect(container.textContent).toContain('思考过程')
    })
})
