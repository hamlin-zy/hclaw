// @vitest-environment jsdom
import {describe, it, expect, vi} from 'vitest'
import {render, screen} from '@testing-library/react'
import {WorkspaceSelector} from '../../../src/renderer/components/ConversationSidebar'

vi.mock('../../../src/renderer/stores/conversationStore', () => ({
  useConversationStore: (sel: (s: {currentWorkspacePath: string; gitBranch: string; viewScope: unknown}) => unknown) =>
    sel({currentWorkspacePath: '/ws/proj', gitBranch: 'main', viewScope: {type: 'project', path: '/ws/proj'}}),
}))

vi.mock('../../../src/renderer/stores/projectGroupStore', () => ({
  useProjectGroupStore: (sel: (s: {groups: unknown[]}) => unknown) => sel({groups: []}),
}))

// D15：PM 入口唯一化到段头文件夹图标，顶部原有的文件夹按钮整个移除。
// 原文件（WorkspaceFolderButton 的点击/禁用用例）随组件删除一并作废，此处按新契约断言「顶部不再有此入口」。
describe('WorkspaceSelector 顶部入口（D15：PM 入口已迁至段头）', () => {
  it('顶部不再渲染文件夹按钮', () => {
    const {container} = render(<WorkspaceSelector/>)
    expect(container.querySelector('[data-name="conversation-sidebar-workspace-folder-button"]')).toBeNull()
  })

  it('抽屉触发按钮仍是唯一顶部入口，无障碍名称不变', () => {
    render(<WorkspaceSelector/>)
    expect(screen.getByRole('button', {name: '切换项目 / 项目组'})).toBeTruthy()
    expect(
      document.querySelectorAll('[data-name="conversation-sidebar-workspace-select-button"]'),
    ).toHaveLength(1)
  })
})
