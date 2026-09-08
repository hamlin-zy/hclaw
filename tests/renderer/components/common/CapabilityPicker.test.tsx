// @vitest-environment jsdom
/**
 * CapabilityPicker 组件测试
 *
 * 覆盖键盘导航：搜索过滤后 ↑/↓ 循环移动高亮、Enter 选中当前高亮项、Escape 清空搜索。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, cleanup} from '@testing-library/react'

const h = vi.hoisted(() => ({
    agents: [
        {name: 'Implementer', description: '实现代理'},
        {name: 'Explore', description: '探索代理'},
    ],
    skills: [
        {name: 'tdd', description: '测试驱动开发'},
        {name: 'research', description: '调研'},
    ],
    commands: [{name: 'deploy', description: '部署命令'}],
}))

vi.mock('@/renderer/stores/userCommandStore', () => ({
    useUserCommandStore: {getState: () => ({loadCommands: vi.fn(), commands: h.commands})},
}))
vi.mock('@/renderer/stores/agentTemplateStore', () => ({
    useAgentTemplateStore: {getState: () => ({syncFromDisk: vi.fn(), templates: h.agents})},
}))
vi.mock('@/renderer/stores/skillStore', () => ({
    useSkillStore: {getState: () => ({loadSkills: vi.fn(), skills: h.skills})},
}))

import CapabilityPicker from '@/renderer/components/common/CapabilityPicker'

beforeEach(() => {
    vi.stubGlobal('electronAPI', {plugin: {getCommands: vi.fn(async () => ({}))}})
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

const type = (text: string) => fireEvent.change(screen.getByPlaceholderText('搜索可用能力...'), {target: {value: text}})

/** 取当前高亮项索引（精确匹配高亮类，排除 hover: 样式） */
const highlightedIndex = () => {
    const opts = screen.getAllByRole('button').filter(b => b.getAttribute('data-name')?.startsWith('capability-picker-option-'))
    return opts.findIndex(o => o.className.includes('bg-[var(--surface-muted)]') && !o.className.includes('hover:'))
}

describe('CapabilityPicker 键盘导航', () => {
    it('加载完成后展示全部能力，无高亮输入时默认高亮首项', async () => {
        const onSelect = vi.fn()
        render(<CapabilityPicker selected="" onSelect={onSelect}/>)

        await waitFor(() => expect(screen.getByText('Implementer')).toBeTruthy())
        // 无搜索：与 Ctrl+K 一致，全局按名称字母序交叉显示（deploy < Explore < Implementer < research < tdd）
        const options = screen.getAllByRole('button').filter(b => b.getAttribute('data-name')?.startsWith('capability-picker-option-'))
        const NAMES = ['deploy', 'Explore', 'Implementer', 'research', 'tdd']
        // 选项文本含描述，按已知名称集合在文本中的出现位置还原名称顺序
        const nameOf = (text: string) => NAMES.find(n => text.includes(n))!
        expect(options.map(o => nameOf(o.textContent ?? ''))).toEqual(NAMES)
        // 首项带高亮样式
        expect(options[0].className).toContain('bg-[var(--surface-muted)]')
    })

    it('↑/↓ 循环移动高亮，Enter 选中当前高亮项', async () => {
        const onSelect = vi.fn()
        render(<CapabilityPicker selected="" onSelect={onSelect}/>)

        await waitFor(() => expect(screen.getByText('Implementer')).toBeTruthy())
        const input = screen.getByPlaceholderText('搜索可用能力...') as HTMLInputElement

        // ↓ 一次 → 高亮第 2 项（名称序：index 0=deploy, 1=Explore）
        fireEvent.keyDown(input, {key: 'ArrowDown'})
        expect(highlightedIndex()).toBe(1)

        // Enter 选中高亮项
        fireEvent.keyDown(input, {key: 'Enter'})
        expect(onSelect).toHaveBeenCalledWith('Explore', 'agent')
        // 选中后清空搜索
        expect(input.value).toBe('')
    })

    it('↓ 循环：末项再 ↓ 回到首项；↑ 循环：首项回末项', async () => {
        const onSelect = vi.fn()
        render(<CapabilityPicker selected="" onSelect={onSelect}/>)

        await waitFor(() => expect(screen.getByText('deploy')).toBeTruthy())
        const input = screen.getByPlaceholderText('搜索可用能力...') as HTMLInputElement

        const highlighted = () => highlightedIndex()

        // 从首项 ↓ 5 次（共 5 项）应回到首项
        for (let i = 0; i < 5; i++) fireEvent.keyDown(input, {key: 'ArrowDown'})
        expect(highlighted()).toBe(0)
        // ↑ 一次 → 末项（索引 4）
        fireEvent.keyDown(input, {key: 'ArrowUp'})
        expect(highlighted()).toBe(4)
    })

    it('搜索过滤后 Enter 选中匹配结果；Escape 清空搜索恢复全列表', async () => {
        const onSelect = vi.fn()
        render(<CapabilityPicker selected="" onSelect={onSelect}/>)

        await waitFor(() => expect(screen.getByText('Implementer')).toBeTruthy())
        const input = screen.getByPlaceholderText('搜索可用能力...') as HTMLInputElement

        type('tdd')
        await waitFor(() => expect(screen.getByText('tdd')).toBeTruthy())
        fireEvent.keyDown(input, {key: 'Enter'})
        expect(onSelect).toHaveBeenCalledWith('tdd', 'skill')

        type('tdd')
        fireEvent.keyDown(input, {key: 'Escape'})
        expect(input.value).toBe('')
        await waitFor(() => expect(screen.getByText('Implementer')).toBeTruthy())
    })

    it('搜索无结果时键盘导航无效（不崩溃、不选中）', async () => {
        const onSelect = vi.fn()
        render(<CapabilityPicker selected="" onSelect={onSelect}/>)

        await waitFor(() => expect(screen.getByText('Implementer')).toBeTruthy())
        const input = screen.getByPlaceholderText('搜索可用能力...') as HTMLInputElement

        type('不存在的关键词xyz')
        await waitFor(() => expect(screen.queryByText('Implementer')).toBeNull())
        // 空结果：↑/↓/Enter 均为 no-op，不崩溃
        fireEvent.keyDown(input, {key: 'ArrowDown'})
        fireEvent.keyDown(input, {key: 'ArrowUp'})
        fireEvent.keyDown(input, {key: 'Enter'})
        expect(onSelect).not.toHaveBeenCalled()
    })

    it('搜索结果变化时高亮重置为首项', async () => {
        const onSelect = vi.fn()
        render(<CapabilityPicker selected="" onSelect={onSelect}/>)

        await waitFor(() => expect(screen.getByText('Implementer')).toBeTruthy())
        const input = screen.getByPlaceholderText('搜索可用能力...') as HTMLInputElement

        fireEvent.keyDown(input, {key: 'ArrowDown'})
        expect(highlightedIndex()).toBe(1)

        // 输入新搜索词 → 高亮回到 0
        type('res')
        await waitFor(() => {
            const opts = screen.getAllByRole('button').filter(b => b.getAttribute('data-name')?.startsWith('capability-picker-option-'))
            expect(opts[0].className).toContain('bg-[var(--surface-muted)]')
        })
    })
})
