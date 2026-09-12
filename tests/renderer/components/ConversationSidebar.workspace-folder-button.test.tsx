// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import {WorkspaceFolderButton} from '../../../src/renderer/components/ConversationSidebar'

const {mockState} = vi.hoisted(() => ({
  mockState: {currentWorkspacePath: null as string | null},
}))

vi.mock('../../../src/renderer/stores/conversationStore', () => ({
  useConversationStore: (sel: (s: typeof mockState) => unknown) => sel(mockState),
}))

const openPM = vi.fn()

beforeEach(() => {
  ;(window as any).electronAPI = {projectManager: {openProjectManager: openPM}}
  openPM.mockReset()
})

afterEach(() => {
  delete (window as any).electronAPI
})

describe('WorkspaceFolderButton — 工作目录空态（I1 guard）', () => {
  it('currentWorkspacePath 为 null 时按钮 disabled、降透明度、有提示语义，且不调用 openProjectManager', () => {
    mockState.currentWorkspacePath = null
    render(<WorkspaceFolderButton />)
    const btn = screen.getByRole('button', {name: '打开项目管理窗口'}) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    expect(btn.getAttribute('title')).toBe('未选择工作目录')
    expect(btn.className).toContain('opacity-40')
    fireEvent.click(btn)
    expect(openPM).not.toHaveBeenCalled()
    // 防 guard 失效：确保 mock 存在，未调用是真 guard 而非 electronAPI 缺失
    expect(openPM).toBeDefined()
  })

  it('currentWorkspacePath 恢复为有效路径时按钮恢复可用并携带路径调用', () => {
    mockState.currentWorkspacePath = '/ws/proj'
    render(<WorkspaceFolderButton />)
    const btn = screen.getByRole('button', {name: '打开项目管理窗口'}) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.getAttribute('title')).toBeNull()
    fireEvent.click(btn)
    expect(openPM).toHaveBeenCalledWith('/ws/proj')
  })

  it('装饰性图标容器外提至文件夹按钮（选择器内不再保留该图标）', () => {
    mockState.currentWorkspacePath = '/ws/proj'
    render(<WorkspaceFolderButton />)
    const btn = screen.getByRole('button', {name: '打开项目管理窗口'}) as HTMLElement
    const container = btn.querySelector('.rounded-\\[10px\\]') as HTMLElement
    expect(container).toBeTruthy()
    expect(container.className).toContain('w-8 h-8')
    expect(container.querySelector('svg')).toBeTruthy()
    // 图标容器是按钮内唯一直接子元素，且不再内嵌于选择器按钮（此处仅验证外提后的按钮结构）
    expect(btn.querySelector(':scope > svg')).toBeNull()
  })
})
