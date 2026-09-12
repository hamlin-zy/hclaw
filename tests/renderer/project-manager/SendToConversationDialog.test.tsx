// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import {describe, expect, it, vi, beforeEach} from 'vitest'
import {fireEvent, render, screen, waitFor} from '@testing-library/react'
import {SendToConversationDialog} from '../../../src/renderer/project-manager/ui/SendToConversationDialog'

const WS = '/ws'

function setup(over: Record<string, unknown> = {}) {
  const props = {open: true, context: '/ws/src/a.ts:12', workspacePath: WS, onClose: vi.fn(), ...over}
  render(<SendToConversationDialog {...props} />)
  return props
}

beforeEach(() => {
  ;(window as any).electronAPI = {
    conversationListByWorkspace: vi.fn(async () => []),
    projectManager: {sendToConversation: vi.fn(async () => ({ok: true}))},
  }
})

describe('SendToConversationDialog', () => {
  it('预览为只读 pre 且显示 context', () => {
    setup()
    const pre = screen.getByTestId('pm-send-dialog-preview')
    expect(pre.tagName).toBe('PRE')
    expect(pre).toHaveTextContent('/ws/src/a.ts:12')
    expect(pre).not.toHaveAttribute('contenteditable')
  })

  it('指令为空时发送按钮禁用', () => {
    setup()
    expect(screen.getByRole('button', {name: '发送'})).toBeDisabled()
  })

  it('无候选会话时「指定会话」单选禁用', async () => {
    setup()
    await waitFor(() => expect(window.electronAPI!.conversationListByWorkspace).toHaveBeenCalled())
    expect(screen.getByLabelText('发送到指定会话处理')).toBeDisabled()
  })

  it('选「指定会话」展开选择器', async () => {
    ;(window as any).electronAPI.conversationListByWorkspace = vi.fn(async () => [
      {id: 'c1', title: '会话一', workspacePath: WS, createdAt: 0, updatedAt: 1, preview: '', status: 'active'},
    ])
    setup()
    fireEvent.click(await screen.findByLabelText('发送到指定会话处理'))
    expect(await screen.findByTestId('pm-session-picker')).toBeInTheDocument()
  })

  it('新会话：发送调用 sendToConversation 并关闭', async () => {
    const props = setup()
    fireEvent.change(screen.getByTestId('pm-send-dialog-instruction'), {target: {value: '帮我改'}})
    fireEvent.click(screen.getByRole('button', {name: '发送'}))
    await waitFor(() => expect(window.electronAPI!.projectManager!.sendToConversation).toHaveBeenCalled())
    const arg = vi.mocked(window.electronAPI!.projectManager!.sendToConversation!).mock.calls[0][0] as any
    expect(arg.workspacePath).toBe(WS)
    expect(arg.content).toBe('/ws/src/a.ts:12\n帮我改')
    expect(arg.title).toBe('帮我改')
    expect(arg.target).toEqual({kind: 'new'})
    expect(props.onClose).toHaveBeenCalled()
  })

  it('{ok:false} 内联报错且不关闭', async () => {
    ;(window as any).electronAPI.projectManager.sendToConversation = vi.fn(async () => ({ok: false, error: '主窗口未响应'}))
    const props = setup()
    fireEvent.change(screen.getByTestId('pm-send-dialog-instruction'), {target: {value: 'x'}})
    fireEvent.click(screen.getByRole('button', {name: '发送'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('主窗口未响应')
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('{ok:true, started:false} 提示未启动且不关闭', async () => {
    ;(window as any).electronAPI.projectManager.sendToConversation = vi.fn(async () => ({ok: true, started: false}))
    const props = setup()
    fireEvent.change(screen.getByTestId('pm-send-dialog-instruction'), {target: {value: 'x'}})
    fireEvent.click(screen.getByRole('button', {name: '发送'}))
    expect(await screen.findByRole('status')).toHaveTextContent('消息已插入会话，但 agent 未启动')
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('warning 显示时发送按钮 disabled', async () => {
    ;(window as any).electronAPI.projectManager.sendToConversation = vi.fn(async () => ({ok: true, started: false}))
    setup()
    fireEvent.change(screen.getByTestId('pm-send-dialog-instruction'), {target: {value: 'x'}})
    fireEvent.click(screen.getByRole('button', {name: '发送'}))
    await screen.findByRole('status')
    expect(screen.getByRole('button', {name: '发送'})).toBeDisabled()
  })

  it('重新 open 时 warning 被清零', async () => {
    ;(window as any).electronAPI.projectManager.sendToConversation = vi.fn(async () => ({ok: true, started: false}))
    const props = {open: true, context: '/ws/src/a.ts:12', workspacePath: WS, onClose: vi.fn()}
    const {rerender} = render(<SendToConversationDialog {...props} />)
    fireEvent.change(screen.getByTestId('pm-send-dialog-instruction'), {target: {value: 'x'}})
    fireEvent.click(screen.getByRole('button', {name: '发送'}))
    await screen.findByRole('status')
    rerender(<SendToConversationDialog {...props} open={false} />)
    rerender(<SendToConversationDialog {...props} open={true} />)
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })

  it('invoke reject 报错', async () => {
    ;(window as any).electronAPI.projectManager.sendToConversation = vi.fn(async () => { throw new Error('boom') })
    setup()
    fireEvent.change(screen.getByTestId('pm-send-dialog-instruction'), {target: {value: 'x'}})
    fireEvent.click(screen.getByRole('button', {name: '发送'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
  })
})
