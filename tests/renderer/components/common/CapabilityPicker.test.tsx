// @vitest-environment jsdom
/**
 * CapabilityPicker 组件测试
 *
 * 覆盖：
 * 1. 键盘导航：搜索过滤后 ↑/↓ 循环移动高亮、Enter 选中当前高亮项、Escape 清空搜索；
 * 2. 取数收敛：全部能力来自 CapabilityHub 一次 `capability:query` 往返
 *    （不再各自拉三个渲染层 store + 插件命令 IPC），且启用态由 Hub 判定
 *    （查询条件传 `enabled: true`，本地不重新解释）；
 * 3. 就绪是确定性信号：await 取数返回即渲染，无固定时长等待；
 * 4. 订阅 capability:changed：能力集合变更后列表自动反映到最新。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, cleanup} from '@testing-library/react'

interface Entry {
    id: string
    name: string
    description: string
    type: 'skill' | 'agent' | 'command'
    source: 'builtin' | 'user' | 'plugin'
    pluginName?: string
    pluginEnabled?: boolean
    enabled: boolean
    searchText: string
}

const entry = (over: Partial<Entry> & Pick<Entry, 'id' | 'name' | 'type'>): Entry => ({
    description: '',
    source: 'builtin',
    enabled: true,
    searchText: over.name.toLowerCase(),
    ...over,
})

/** 与旧实现等价的初始能力集合（用户命令 / 技能 / Agent） */
const initialEntries: Entry[] = [
    entry({id: 'cmd:deploy', name: 'deploy', type: 'command', source: 'user', description: '部署命令'}),
    entry({id: 'tdd', name: 'tdd', type: 'skill', description: '测试驱动开发'}),
    entry({id: 'research', name: 'research', type: 'skill', description: '调研'}),
    entry({id: 'Implementer', name: 'Implementer', type: 'agent', description: '实现代理'}),
    entry({id: 'Explore', name: 'Explore', type: 'agent', description: '探索代理'}),
]

const h = vi.hoisted(() => ({
    query: vi.fn(),
    unsubscribe: vi.fn(),
    onChange: null as null | (() => void),
}))

// useCapabilityRefresh → MessageBubble 的模块级能力名缓存失效：单测里无需真实实现
vi.mock('@/renderer/components/message-list/MessageBubble', () => ({
    invalidateKnownCapabilityNames: vi.fn(),
}))

import CapabilityPicker from '@/renderer/components/common/CapabilityPicker'

function stubElectronApi() {
    vi.stubGlobal('electronAPI', {
        capability: {
            query: h.query,
            onCapabilityChanged: (cb: () => void) => {
                h.onChange = cb
                return h.unsubscribe
            },
        },
    })
}

beforeEach(() => {
    h.query.mockReset()
    h.unsubscribe.mockReset()
    h.onChange = null
    h.query.mockImplementation(async () => initialEntries)
    stubElectronApi()
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

describe('CapabilityPicker 取数路径（CapabilityHub 单一来源）', () => {
    it('整个渲染期只有一次 capability:query 跨进程往返', async () => {
        const onSelect = vi.fn()
        render(<CapabilityPicker selected="" onSelect={onSelect}/>)

        await waitFor(() => expect(screen.getByText('Implementer')).toBeTruthy())
        // 等待任何可能的额外往返（若有）落地
        await new Promise(r => setTimeout(r, 0))
        expect(h.query).toHaveBeenCalledTimes(1)
    })

    it('取数即就绪：查询 promise 一 resolve 列表就可用（无固定时长等待）', async () => {
        // 取数被延迟到手动 resolve：若组件靠 setTimeout 赌就绪，此时必然仍是「加载中」
        let resolveQuery: (v: unknown) => void = () => {}
        h.query.mockReset()
        h.query.mockImplementation(() => new Promise(res => { resolveQuery = res }))
        const onSelect = vi.fn()
        render(<CapabilityPicker selected="" onSelect={onSelect}/>)

        expect(screen.getByText('加载中...')).toBeTruthy()
        expect(screen.queryByText('Implementer')).toBeNull()

        // 立即 resolve（不足任何「等待时长」）→ 就绪
        resolveQuery(initialEntries)
        await waitFor(() => expect(screen.getByText('Implementer')).toBeTruthy())
        expect(screen.queryByText('加载中...')).toBeNull()
    })

    it('启用态由 Hub 判定：查询条件传 { enabled: true }，本地不重新解释', async () => {
        render(<CapabilityPicker selected="" onSelect={vi.fn()}/>)

        await waitFor(() => expect(h.query).toHaveBeenCalled())
        expect(h.query).toHaveBeenCalledWith({enabled: true})
        // 不请求正文：列表出口默认裁剪 content
        expect(h.query.mock.calls[0][1]).toBeUndefined()
    })

    it('能力变更后订阅 capability:changed 自动重取并反映到最新', async () => {
        const onSelect = vi.fn()
        render(<CapabilityPicker selected="" onSelect={onSelect}/>)
        await waitFor(() => expect(screen.getByText('Implementer')).toBeTruthy())
        expect(h.onChange).toBeTypeOf('function')

        h.query.mockImplementation(async () => [
            ...initialEntries,
            entry({id: 'newbie', name: 'zzz-newbie', type: 'skill', description: '新技能'}),
        ])
        h.onChange!()

        await waitFor(() => expect(screen.getByText('zzz-newbie')).toBeTruthy())
        expect(h.query).toHaveBeenCalledTimes(2)
    })

    it('去重：同名能力保留优先级更高者（用户命令 优先于 插件命令）', async () => {
        h.query.mockImplementation(async () => [
            entry({id: 'cmd:deploy', name: 'deploy', type: 'command', source: 'user', description: '用户命令'}),
            entry({id: 'cmd:p:deploy', name: 'deploy', type: 'command', source: 'plugin', pluginName: 'p', pluginEnabled: true, description: '插件命令'}),
        ])
        render(<CapabilityPicker selected="" onSelect={vi.fn()}/>)

        await waitFor(() => expect(screen.getByText('deploy')).toBeTruthy())
        expect(screen.getAllByText('deploy')).toHaveLength(1)
        expect(screen.getByText('命令')).toBeTruthy()
        expect(screen.queryByText('插件')).toBeNull()
    })

    it('找不到 capability API 时降级为空列表（不崩溃、不留加载态）', async () => {
        vi.stubGlobal('electronAPI', {})
        render(<CapabilityPicker selected="" onSelect={vi.fn()}/>)

        await waitFor(() => expect(screen.getByText('暂无可用能力')).toBeTruthy())
    })
})
