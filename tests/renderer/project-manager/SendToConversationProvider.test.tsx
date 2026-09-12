// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import {describe, expect, it, vi, beforeEach} from 'vitest'
import {fireEvent, render, screen} from '@testing-library/react'
import {SendToConversationProvider, useSendToConversation} from '../../../src/renderer/project-manager/ui/SendToConversationProvider'

function Consumer() {
  const {request} = useSendToConversation()!
  return <button onClick={() => request({kind: 'files', paths: ['src/a.ts']})}>open</button>
}

beforeEach(() => {
  // workspaceStore.workspacePath 是惰性 getter，读取 window.electronAPI.projectManager.workspacePath
  ;(window as any).electronAPI = {
    projectManager: {workspacePath: '/ws'},
    conversationListByWorkspace: vi.fn(async () => []),
  }
})

describe('SendToConversationProvider', () => {
  it('request 打开弹窗并用 buildContext 生成预览', async () => {
    render(<SendToConversationProvider><Consumer /></SendToConversationProvider>)
    expect(screen.queryByTestId('pm-send-dialog')).toBeNull()
    fireEvent.click(screen.getByText('open'))
    expect(screen.getByTestId('pm-send-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('pm-send-dialog-preview')).toHaveTextContent('/ws/src/a.ts')
  })

  it('关闭后弹窗卸载', () => {
    render(<SendToConversationProvider><Consumer /></SendToConversationProvider>)
    fireEvent.click(screen.getByText('open'))
    fireEvent.click(screen.getByRole('button', {name: '取消'}))
    expect(screen.queryByTestId('pm-send-dialog')).toBeNull()
  })

  it('无 Provider 时 useSendToConversation 返回 null（不抛错，兼容独立渲染的组件测试）', () => {
    let api: unknown = 'x'
    function Probe() { api = useSendToConversation(); return null }
    render(<Probe />)
    expect(api).toBeNull()
  })
})
