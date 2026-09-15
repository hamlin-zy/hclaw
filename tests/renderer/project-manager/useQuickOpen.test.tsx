// @vitest-environment jsdom
/**
 * useQuickOpen —— capture 阶段抢占与浮层键位语义的接线测试。
 *
 * 保护：快捷键在 capture 阶段被截走（编辑器收不到）、三种模式呼出、Esc 关闭、
 * 上下键归列表、未打开时一律放行、卸载后监听器不再生效。
 * 不测浮层 DOM 与键位手感（spec §Testing Decisions 明确不测）。
 *
 * 键位断言按 Win/Linux 表进行：jsdom 的 navigator.platform 恒为 ''，detectIsMac() 恒 false，
 * 因此结果跨平台确定。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {renderHook, act} from '@testing-library/react'
import {useQuickOpen} from '../../../src/renderer/project-manager/hooks/useQuickOpen'

/** 已挂载 hook 实例，afterEach 统一卸载（防止 keydown 监听器跨测试累积） */
let mounted: Array<{unmount: () => void}> = []

function mountHook() {
  const hook = renderHook(() => useQuickOpen())
  mounted.push(hook)
  return hook
}

/** 派发 keydown（默认落在 document 上，即 hook 监听器的宿主） */
function pressKey(init: KeyboardEventInit) {
  const evt = new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init})
  act(() => { document.dispatchEvent(evt) })
  return evt
}

describe('useQuickOpen', () => {
  beforeEach(() => {
    mounted = []
    Object.defineProperty(window.navigator, 'platform', {value: '', configurable: true})
  })

  afterEach(() => {
    for (const h of mounted) h.unmount()
    mounted = []
  })

  it('初始不打开浮层', () => {
    expect(mountHook().result.current.mode).toBe(null)
  })

  it('三种键位各自呼出对应模式', () => {
    const hook = mountHook()
    expect(pressKey({ctrlKey: true, shiftKey: true, key: 'N'}).defaultPrevented).toBe(true)
    expect(hook.result.current.mode).toBe('file-search')
    pressKey({ctrlKey: true, key: 'e'})
    expect(hook.result.current.mode).toBe('recent-files')
    pressKey({ctrlKey: true, shiftKey: true, key: 'F'})
    expect(hook.result.current.mode).toBe('find-in-files')
  })

  it('capture 阶段抢占：编辑器自己的 keydown 监听器收不到事件', () => {
    mountHook()
    // 模拟编辑器：挂在 document 的子节点上，事件从它出发冒泡（capture 先经 document）
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    document.body.appendChild(editor)
    const editorHandler = vi.fn()
    editor.addEventListener('keydown', editorHandler)
    const evt = new KeyboardEvent('keydown', {ctrlKey: true, shiftKey: true, key: 'N', bubbles: true, cancelable: true})
    act(() => { editor.dispatchEvent(evt) })
    expect(evt.defaultPrevented).toBe(true)
    expect(editorHandler).not.toHaveBeenCalled()
    editor.remove()
  })

  it('呼出浮层不改动编辑器既有的选区与滚动位置', () => {
    mountHook()
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    editor.textContent = 'hello world'
    document.body.appendChild(editor)
    editor.scrollTop = 42
    const range = document.createRange()
    range.setStart(editor.firstChild as Text, 0)
    range.setEnd(editor.firstChild as Text, 5)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    act(() => {
      editor.dispatchEvent(new KeyboardEvent('keydown', {ctrlKey: true, shiftKey: true, key: 'N', bubbles: true, cancelable: true}))
    })

    expect(selection.rangeCount).toBe(1)
    expect(selection.toString()).toBe('hello')
    expect(editor.scrollTop).toBe(42)
    editor.remove()
  })

  it('浮层未打开时 Esc 与上下键严格放行', () => {
    mountHook()
    expect(pressKey({key: 'Escape'}).defaultPrevented).toBe(false)
    expect(pressKey({key: 'ArrowDown'}).defaultPrevented).toBe(false)
    expect(pressKey({key: 'ArrowUp'}).defaultPrevented).toBe(false)
  })

  it('浮层已打开时上下键被浮层消费、不关闭浮层；Esc 关闭', () => {
    const hook = mountHook()
    pressKey({ctrlKey: true, key: 'e'})
    expect(hook.result.current.mode).toBe('recent-files')
    expect(pressKey({key: 'ArrowDown'}).defaultPrevented).toBe(true)
    expect(pressKey({key: 'ArrowUp'}).defaultPrevented).toBe(true)
    expect(hook.result.current.mode).toBe('recent-files')
    expect(pressKey({key: 'Escape'}).defaultPrevented).toBe(true)
    expect(hook.result.current.mode).toBe(null)
    // 关闭后上下键重新放行
    expect(pressKey({key: 'ArrowDown'}).defaultPrevented).toBe(false)
  })

  it('重复呼出重置查询', () => {
    const hook = mountHook()
    pressKey({ctrlKey: true, key: 'e'})
    act(() => { hook.result.current.setQuery('abc') })
    expect(hook.result.current.query).toBe('abc')
    pressKey({ctrlKey: true, shiftKey: true, key: 'F'})
    expect(hook.result.current.query).toBe('')
    expect(hook.result.current.mode).toBe('find-in-files')
  })

  it('卸载后不再拦截快捷键', () => {
    const hook = renderHook(() => useQuickOpen())
    hook.unmount()
    expect(pressKey({ctrlKey: true, shiftKey: true, key: 'N'}).defaultPrevented).toBe(false)
  })
})
