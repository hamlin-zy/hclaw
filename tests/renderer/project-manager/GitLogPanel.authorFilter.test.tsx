// @vitest-environment jsdom
import '@testing-library/jest-dom'
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import {GitLogPanel} from '../../../src/renderer/project-manager/components/GitLogPanel'
import {useGitLogStore} from '../../../src/renderer/project-manager/stores/gitLogStore'
import {useWorkspaceStore} from '../../../src/renderer/project-manager/stores/workspaceStore'
import type {GitAuthor} from '../../../src/shared/types/project-manager'

const AUTHORS: GitAuthor[] = [
  {name: 'Alice', email: 'alice@test.com', commits: 7},
  {name: 'Bob', email: 'bob@test.com', commits: 3},
  // 同名不同 email：候选必须可区分
  {name: 'Bob', email: 'bob@other.com', commits: 1},
]

/** 保持与既有 gitLogPanel.test.tsx 一致的 mock 风格，但不写 `any` */
type MockFn = ReturnType<typeof vi.fn>
let gitAuthorsMock: MockFn

beforeEach(() => {
  vi.restoreAllMocks()
  useGitLogStore.setState({
    entries: [], selectedHash: null, selectedBranch: null, loading: false, hasMore: false, lastOptions: null,
  })
  useWorkspaceStore.setState({workspacePath: '/ws'})
  gitAuthorsMock = vi.fn(async () => AUTHORS)
  Object.defineProperty(window, 'electronAPI', {
    value: {
      projectManager: {
        gitBranches: vi.fn(async () => []),
        gitLog: vi.fn(async () => []),
        gitAuthors: gitAuthorsMock,
      },
    },
    writable: true,
    configurable: true,
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

/** 打开折叠过滤栏 */
const openAdvanced = () => {
  fireEvent.click(screen.getByText('筛选'))
}

const authorInput = () => screen.getByPlaceholderText('作者，逗号分隔')

/** 覆盖 store 的 applyFilters 以断言组参 */
type ApplyFiltersMock = ReturnType<typeof vi.fn<(ws: string, opts: unknown) => Promise<void>>>
const setApplyFiltersMock = (mock: ApplyFiltersMock) =>
  useGitLogStore.setState({applyFilters: mock})

describe('GitLogPanel 过滤栏中文化', () => {
  it('主工具栏与折叠栏渲染中文标签', () => {
    render(<GitLogPanel />)
    // 主工具栏
    expect(screen.getByText('提交')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('文本或哈希')).toBeInTheDocument()
    expect(screen.getByRole('button', {name: '查找'})).toBeInTheDocument()
    // 折叠栏
    openAdvanced()
    expect(screen.getByText('作者')).toBeInTheDocument()
    expect(screen.getByText('路径')).toBeInTheDocument()
    expect(screen.getByText('起始日期')).toBeInTheDocument()
    expect(screen.getByText('截止日期')).toBeInTheDocument()
  })

  it('筛选开关的中文标题替代旧的 User / Paths / Since / Until', () => {
    render(<GitLogPanel />)
    expect(screen.getByText('筛选')).toHaveAttribute('title', '作者 / 路径 / 日期')
    expect(screen.queryByText('Filter')).not.toBeInTheDocument()
    expect(screen.queryByText('Paths')).not.toBeInTheDocument()
  })
})

describe('GitLogPanel 作者下拉过滤', () => {
  it('懒加载：仅在展开过滤栏时请求 gitAuthors，且同一渲染内只请求一次', async () => {
    render(<GitLogPanel />)
    expect(gitAuthorsMock).not.toHaveBeenCalled()
    openAdvanced()
    await waitFor(() => expect(gitAuthorsMock).toHaveBeenCalledTimes(1))
    expect(gitAuthorsMock).toHaveBeenCalledWith('/ws')
  })

  it('聚焦作者输入框后展示 gitAuthors 候选（含 email 消歧与提交数）', async () => {
    render(<GitLogPanel />)
    openAdvanced()
    await waitFor(() => expect(gitAuthorsMock).toHaveBeenCalledTimes(1))
    fireEvent.focus(authorInput())
    expect(await screen.findByText('Alice')).toBeInTheDocument()
    expect(screen.getByText(/alice@test\.com/)).toBeInTheDocument()
    // 同名不同 email 两条候选都出现在面板中（可区分）
    expect(screen.getByText(/bob@test\.com/)).toBeInTheDocument()
    expect(screen.getByText(/bob@other\.com/)).toBeInTheDocument()
  })

  it('选择作者后 applyFilters 收到 filterUser 含预期值', async () => {
    const applyFiltersMock: ApplyFiltersMock = vi.fn<(ws: string, opts: unknown) => Promise<void>>()
    setApplyFiltersMock(applyFiltersMock)
    render(<GitLogPanel />)
    openAdvanced()
    await waitFor(() => expect(gitAuthorsMock).toHaveBeenCalledTimes(1))
    fireEvent.focus(authorInput())
    fireEvent.click(await screen.findByText('Alice'))
    fireEvent.click(screen.getByRole('button', {name: '查找'}))
    expect(applyFiltersMock).toHaveBeenCalledWith('/ws', expect.objectContaining({filterUser: ['Alice']}))
  })

  it('同名不同 email 选择后写入 email 以消歧', async () => {
    const applyFiltersMock: ApplyFiltersMock = vi.fn<(ws: string, opts: unknown) => Promise<void>>()
    setApplyFiltersMock(applyFiltersMock)
    render(<GitLogPanel />)
    openAdvanced()
    await waitFor(() => expect(gitAuthorsMock).toHaveBeenCalledTimes(1))
    fireEvent.focus(authorInput())
    fireEvent.click(await screen.findByText(/bob@other\.com/))
    fireEvent.click(screen.getByRole('button', {name: '查找'}))
    expect(applyFiltersMock).toHaveBeenCalledWith('/ws', expect.objectContaining({filterUser: ['bob@other.com']}))
  })

  it('手输仍可用：敲任意字符串后触发过滤，filterUser 含该字符串', async () => {
    const applyFiltersMock: ApplyFiltersMock = vi.fn<(ws: string, opts: unknown) => Promise<void>>()
    setApplyFiltersMock(applyFiltersMock)
    render(<GitLogPanel />)
    openAdvanced()
    await waitFor(() => expect(gitAuthorsMock).toHaveBeenCalledTimes(1))
    fireEvent.change(authorInput(), {target: {value: 'carol@x.com'}})
    fireEvent.click(screen.getByRole('button', {name: '查找'}))
    expect(applyFiltersMock).toHaveBeenCalledWith('/ws', expect.objectContaining({filterUser: ['carol@x.com']}))
  })

  it('gitAuthors reject 时优雅降级：不崩溃、手输框仍可用，且与「暂无作者」文案可区分', async () => {
    gitAuthorsMock.mockRejectedValue(new Error('not a git repo'))
    const applyFiltersMock: ApplyFiltersMock = vi.fn<(ws: string, opts: unknown) => Promise<void>>()
    setApplyFiltersMock(applyFiltersMock)
    render(<GitLogPanel />)
    openAdvanced()
    await waitFor(() => expect(gitAuthorsMock).toHaveBeenCalledTimes(1))
    fireEvent.focus(authorInput())
    // 读取失败 → 专用文案（非「仓库暂无作者」），提示可直接手输
    expect(await screen.findByText('作者列表读取失败，可直接手动输入')).toBeInTheDocument()
    expect(screen.queryByText('仓库暂无作者')).not.toBeInTheDocument()
    fireEvent.change(authorInput(), {target: {value: 'dave'}})
    fireEvent.click(screen.getByRole('button', {name: '查找'}))
    expect(applyFiltersMock).toHaveBeenCalledWith('/ws', expect.objectContaining({filterUser: ['dave']}))
  })

  it('键盘可达：ArrowDown 高亮 + Enter 选中追加 + Esc 关闭', async () => {
    render(<GitLogPanel />)
    openAdvanced()
    await waitFor(() => expect(gitAuthorsMock).toHaveBeenCalledTimes(1))
    const input = authorInput()
    fireEvent.focus(input)
    await screen.findByText('Alice')
    // 面板已展开 → ArrowDown 从 -1 落到 0（Alice），Enter 选中并追加（末尾保留 ", " 便于继续输入）
    fireEvent.keyDown(input, {key: 'ArrowDown'})
    fireEvent.keyDown(input, {key: 'Enter'})
    expect(authorInput()).toHaveValue('Alice, ')
    fireEvent.keyDown(input, {key: 'Escape'})
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('gitAuthors 返回空数组时手输框仍可用', async () => {    gitAuthorsMock.mockResolvedValue([])
    const applyFiltersMock: ApplyFiltersMock = vi.fn<(ws: string, opts: unknown) => Promise<void>>()
    setApplyFiltersMock(applyFiltersMock)
    render(<GitLogPanel />)
    openAdvanced()
    await waitFor(() => expect(gitAuthorsMock).toHaveBeenCalledTimes(1))
    fireEvent.focus(authorInput())
    expect(await screen.findByText('仓库暂无作者')).toBeInTheDocument()
    fireEvent.change(authorInput(), {target: {value: 'erin'}})
    fireEvent.click(screen.getByRole('button', {name: '查找'}))
    expect(applyFiltersMock).toHaveBeenCalledWith('/ws', expect.objectContaining({filterUser: ['erin']}))
  })
})
