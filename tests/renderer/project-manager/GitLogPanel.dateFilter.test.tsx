// @vitest-environment jsdom
/**
 * GitLogPanel 过滤栏日期字段：自研 DatePicker 替换原生 <input type="date">
 *
 * 覆盖：
 * - 两处字段由 DatePicker 渲染，可访问名「起始日期」「截止日期」
 * - 过滤栏内不再有原生 input[type=date]
 * - 打开弹层选日期 → 写入 since/until 并随「查找」提交为 filterDateRange
 * - 清空（弹层「清除」）语义与原实现一致：两个都空 → 不带 filterDateRange；
 *   只清一端 → 该端降级为默认界（0 / now），另一端保留（原逻辑是 (since || until) 判断）
 * - 弹层 portal 到 body，不受过滤栏容器裁剪
 * - 输入框压到过滤栏的 18px 尺度（类契约）
 *
 * mock 风格沿用 GitLogPanel.authorFilter.test.tsx。
 */
import '@testing-library/jest-dom'
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, act} from '@testing-library/react'
import {GitLogPanel} from '../../../src/renderer/project-manager/components/GitLogPanel'
import {useGitLogStore} from '../../../src/renderer/project-manager/stores/gitLogStore'
import {useWorkspaceStore} from '../../../src/renderer/project-manager/stores/workspaceStore'

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * 当前月内的固定日：一定落在 DatePicker 的 42 格（6×7，含相邻月）网格里，
 * 打开弹层后无需翻月导航即可确定性点击，避免依赖「今天」是哪一天。
 */
const month = (() => {
  const n = new Date()
  const y = n.getFullYear()
  const m = n.getMonth() + 1
  return {
    day: (d: number) => ({
      label: `${y}年${pad2(m)}月${pad2(d)}日`,
      value: `${y}-${pad2(m)}-${pad2(d)}`,
    }),
  }
})()

type MockFn = ReturnType<typeof vi.fn>
type ApplyFiltersMock = ReturnType<typeof vi.fn<(ws: string, opts: unknown) => Promise<void>>>
let gitAuthorsMock: MockFn

beforeEach(() => {
  vi.restoreAllMocks()
  useGitLogStore.setState({
    entries: [], selectedHash: null, selectedBranch: null, loading: false, hasMore: false, lastOptions: null,
  })
  useWorkspaceStore.setState({workspacePath: '/ws'})
  gitAuthorsMock = vi.fn(async () => [])
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

/** 展开折叠过滤栏，并等懒加载的 gitAuthors/gitBranches 回填落定（避免 act 警告） */
const openAdvanced = async () => {
  fireEvent.click(screen.getByText('筛选'))
  await act(async () => {
    await new Promise(r => setTimeout(r, 0))
  })
}
const advancedBar = () => screen.getByTestId('pm-commits-advanced')
/** DatePicker 的文本输入（aria-label 即字段名） */
const dateBox = (name: string) => screen.getByRole('textbox', {name})
/** DatePicker 的日历触发按钮 */
const dateTrigger = (name: string) => screen.getByRole('button', {name: `${name}，打开日历`})
const pickDay = (d: number) => fireEvent.click(screen.getByRole('button', {name: month.day(d).label}))

const setApplyFiltersMock = (): ApplyFiltersMock => {
  const mock = vi.fn<(ws: string, opts: unknown) => Promise<void>>(async () => {})
  useGitLogStore.setState({applyFilters: mock as never})
  return mock
}
const optionsOf = (mock: ApplyFiltersMock) => mock.mock.calls[0][1] as {filterDateRange?: [number, number]}
const submit = () => fireEvent.click(screen.getByRole('button', {name: '查找'}))

describe('GitLogPanel 过滤栏日期字段（DatePicker）', () => {
  it('两处日期字段由 DatePicker 渲染，可访问名为「起始日期」「截止日期」', async () => {
    render(<GitLogPanel />)
    await openAdvanced()
    expect(dateBox('起始日期')).toHaveClass('dp-input')
    expect(dateBox('截止日期')).toHaveClass('dp-input')
    // 每处 = 输入框 + 日历触发按钮；两处共 2 个 DatePicker 根节点
    expect(dateTrigger('起始日期')).toBeInTheDocument()
    expect(dateTrigger('截止日期')).toBeInTheDocument()
    expect(advancedBar().querySelectorAll('[data-name="datepicker"]')).toHaveLength(2)
  })

  it('过滤栏内不再存在原生 input[type="date"]', async () => {
    render(<GitLogPanel />)
    await openAdvanced()
    expect(advancedBar().querySelectorAll('input[type="date"]')).toHaveLength(0)
    expect(document.querySelectorAll('input[type="date"]')).toHaveLength(0)
  })

  it('起始日期：打开弹层选一天 → since 生效并随「查找」提交为 filterDateRange', async () => {
    const mock = setApplyFiltersMock()
    render(<GitLogPanel />)
    await openAdvanced()
    fireEvent.click(dateTrigger('起始日期'))
    pickDay(15)
    expect(dateBox('起始日期')).toHaveValue(month.day(15).value)

    submit()
    expect(mock).toHaveBeenCalledTimes(1)
    const range = optionsOf(mock).filterDateRange
    expect(range?.[0]).toBe(new Date(`${month.day(15).value}T00:00:00`).getTime())
    // 截止为空 → 沿用原实现的默认上界 Date.now()
    expect(range?.[1]).toBeGreaterThan(0)
    expect(range?.[1]).toBeLessThanOrEqual(Date.now())
  })

  it('截止日期：打开弹层选一天 → until 生效并随「查找」提交', async () => {
    const mock = setApplyFiltersMock()
    render(<GitLogPanel />)
    await openAdvanced()
    fireEvent.click(dateTrigger('截止日期'))
    pickDay(20)
    expect(dateBox('截止日期')).toHaveValue(month.day(20).value)

    submit()
    const range = optionsOf(mock).filterDateRange
    expect(range?.[1]).toBe(new Date(`${month.day(20).value}T00:00:00`).getTime())
    // 起始为空 → 沿用原实现的默认下界 0
    expect(range?.[0]).toBe(0)
  })

  it('弹层 portal 到 body：不被过滤栏容器裁剪', async () => {
    render(<GitLogPanel />)
    await openAdvanced()
    fireEvent.click(dateTrigger('起始日期'))
    const panel = document.querySelector('[data-name="datepicker-panel"]')
    expect(panel).not.toBeNull()
    expect(advancedBar().contains(panel)).toBe(false)
    expect(panel!.parentElement).toBe(document.body)
  })

  it('清空：两个字段都清除后 filterDateRange 不再提交（与原原生 input 语义一致）', async () => {
    const mock = setApplyFiltersMock()
    render(<GitLogPanel />)
    await openAdvanced()
    fireEvent.click(dateTrigger('起始日期'))
    pickDay(15)
    expect(dateBox('起始日期')).toHaveValue(month.day(15).value)

    // 重新打开弹层用「清除」清空（与原 input 的 × 等价：onChange('')）
    fireEvent.click(dateTrigger('起始日期'))
    fireEvent.click(screen.getByRole('button', {name: '清除'}))
    expect(dateBox('起始日期')).toHaveValue('')

    submit()
    expect(optionsOf(mock).filterDateRange).toBeUndefined()
  })

  it('清空：只清一端时该端降级为默认界，另一端保留（原 (since || until) 语义）', async () => {
    const mock = setApplyFiltersMock()
    render(<GitLogPanel />)
    await openAdvanced()
    fireEvent.click(dateTrigger('起始日期'))
    pickDay(15)
    fireEvent.click(dateTrigger('截止日期'))
    pickDay(20)

    fireEvent.click(dateTrigger('起始日期'))
    fireEvent.click(screen.getByRole('button', {name: '清除'}))

    submit()
    expect(optionsOf(mock).filterDateRange).toEqual([
      0,
      new Date(`${month.day(20).value}T00:00:00`).getTime(),
    ])
  })

  it('输入框压到过滤栏尺度：类契约（18px 高 / 11px 字号）', async () => {
    render(<GitLogPanel />)
    await openAdvanced()
    const cls = dateBox('起始日期').className
    expect(cls).toContain('!h-[18px]')
    expect(cls).toContain('!text-[11px]')
  })
})
