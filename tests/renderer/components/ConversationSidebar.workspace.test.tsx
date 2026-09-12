// @vitest-environment jsdom
import {describe, it, expect, vi} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import {WorkspaceFolderButton} from '../../../src/renderer/components/ConversationSidebar'

vi.mock('../../../src/renderer/stores/conversationStore', () => ({
  useConversationStore: (sel: (s: {currentWorkspacePath: string}) => string) =>
    sel({currentWorkspacePath: '/ws/proj'}),
}))

describe('WorkspaceFolderButton', () => {
  it('点击打开项目管理窗口', () => {
    const openPM = vi.fn()
    ;(window as any).electronAPI = {projectManager: {openProjectManager: openPM}}
    render(<WorkspaceFolderButton />)
    fireEvent.click(screen.getByRole('button', {name: '打开项目管理窗口'}))
    expect(openPM).toHaveBeenCalledWith('/ws/proj')
  })
})
