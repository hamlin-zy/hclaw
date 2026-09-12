// @vitest-environment jsdom
import {describe, it, expect, vi} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import ConfirmDialog, {confirm, confirmWithInput} from '../../../../src/renderer/components/ConfirmDialog'

describe('confirmWithInput（spec §4.3）', () => {
  it('multiline: true → 渲染 rows=3 的 textarea 且自动聚焦', async () => {
    render(<ConfirmDialog />)
    void confirmWithInput({title: '提交', message: 'm', multiline: true})
    const input = await screen.findByRole('textbox')
    expect(input.tagName).toBe('TEXTAREA')
    expect(input).toHaveAttribute('rows', '3')
    expect(document.activeElement).toBe(input)
  })

  it('缺省 → 渲染单行 input（不是 textarea）', async () => {
    render(<ConfirmDialog />)
    void confirmWithInput({title: 't', message: 'm'})
    const input = await screen.findByRole('textbox')
    expect(input.tagName).toBe('INPUT')
  })

  it('Ctrl+Enter 提交并 resolve trim 后的值', async () => {
    render(<ConfirmDialog />)
    const p = confirmWithInput({title: '提交', message: 'm', multiline: true})
    const input = await screen.findByRole('textbox')
    fireEvent.change(input, {target: {value: '  feat: x  '}})
    fireEvent.keyDown(input, {key: 'Enter', ctrlKey: true})
    await expect(p).resolves.toBe('feat: x')
  })

  it('Cmd+Enter（macOS）提交；多行态下单独 Enter 不提交', async () => {
    render(<ConfirmDialog />)
    const p = confirmWithInput({title: 't', message: 'm', multiline: true})
    const input = await screen.findByRole('textbox')
    fireEvent.change(input, {target: {value: 'a'}})
    fireEvent.keyDown(input, {key: 'Enter'})
    expect(screen.getByRole('textbox')).toBeInTheDocument()   // 仍开着 = 未提交
    fireEvent.keyDown(input, {key: 'Enter', metaKey: true})
    await expect(p).resolves.toBe('a')
  })

  it('单行态下 Enter 直接提交', async () => {
    render(<ConfirmDialog />)
    const p = confirmWithInput({title: 't', message: 'm'})
    const input = await screen.findByRole('textbox')
    fireEvent.change(input, {target: {value: 'ok'}})
    fireEvent.keyDown(input, {key: 'Enter'})
    await expect(p).resolves.toBe('ok')
  })

  it('trim 后为空 → 确认按钮 disabled', async () => {
    render(<ConfirmDialog />)
    void confirmWithInput({title: 't', message: 'm', multiline: true, confirmText: '提交'})
    const input = await screen.findByRole('textbox')
    fireEvent.change(input, {target: {value: '   '}})
    expect(screen.getByRole('button', {name: '提交'})).toBeDisabled()
  })

  it('三种取消路径均 resolve null（取消按钮 / ESC / 点遮罩）', async () => {
    const view = render(<ConfirmDialog />)

    const p1 = confirmWithInput({title: 't', message: 'm'})
    fireEvent.click(await screen.findByRole('button', {name: '取消'}))
    await expect(p1).resolves.toBeNull()

    const p2 = confirmWithInput({title: 't', message: 'm'})
    fireEvent.keyDown(document, {key: 'Escape'})
    await expect(p2).resolves.toBeNull()

    const p3 = confirmWithInput({title: 't', message: 'm'})
    fireEvent.click(await screen.findByTestId('confirm-dialog-mask'))
    await expect(p3).resolves.toBeNull()
    view.unmount()
  })

  it('initialValue 预填', async () => {
    render(<ConfirmDialog />)
    void confirmWithInput({title: 't', message: 'm', initialValue: 'wip'})
    expect((await screen.findByRole('textbox') as HTMLInputElement).value).toBe('wip')
  })
})

describe('confirm() 行为不回归（spec §4.3 向后兼容）', () => {
  it('确认返回 true / 取消返回 false，且不渲染输入控件', async () => {
    render(<ConfirmDialog />)
    const p = confirm({title: '删除', message: '确定删除？'})
    expect(await screen.findByText('确定删除？')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', {name: '确认'}))
    await expect(p).resolves.toBe(true)

    const p2 = confirm({title: 'x', message: 'y'})
    fireEvent.click(await screen.findByRole('button', {name: '取消'}))
    await expect(p2).resolves.toBe(false)
  })

  it('onConfirm 存在时等待其完成再 resolve true', async () => {
    render(<ConfirmDialog />)
    const onConfirm = vi.fn(async () => {})
    const p = confirm({title: 'x', message: 'y', onConfirm})
    fireEvent.click(await screen.findByRole('button', {name: '确认'}))
    await expect(p).resolves.toBe(true)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('ESC 取消 confirm()：resolve false 且触发 onCancel（spec §4.3 向后兼容）', async () => {
    render(<ConfirmDialog />)
    const onCancel = vi.fn()
    const p = confirm({title: 't', message: 'm', onCancel})
    fireEvent.keyDown(document, {key: 'Escape'})
    await expect(p).resolves.toBe(false)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
