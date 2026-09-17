// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {useEffect, type Ref} from 'react'
import {render, screen, act} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {EditorArea} from '../../../src/renderer/project-manager/components/EditorArea'
import {useEditorTabStore} from '../../../src/renderer/project-manager/stores/editorTabStore'
import {requestLocate, useLocateRequestStore} from '../../../src/renderer/project-manager/stores/locateRequestStore'

/**
 * EditorArea 的**定位接线**（工单 06）。
 *
 * CodeEditor 用假件替掉：本文件只验证接线事实——请求先到能不能挂起到编辑器就绪、
 * 1500ms 计时、重复定位只重置计时、切 tab 不串味。真实的滚动 / 光标 / 装饰派发属于
 * CodeMirror 内部行为，spec「Testing Decisions」明确不在此层断言。
 */
interface Handle {
  locate(line: number, options?: {scroll?: boolean}): boolean
  clearLocate(): void
}

const fake = vi.hoisted(() => ({
  calls: [] as Array<{method: 'locate' | 'clearLocate', line?: number, scroll?: boolean, applied?: boolean}>,
  /** 视图是否就绪：false 时 locate 返回 false（模拟 EditorView 已销毁、新视图尚未创建） */
  viewReady: true,
  /** 组件最后一次收到的 onEditorReady（测试手动触发「视图就绪」） */
  notifyReady: null as (() => void) | null,
  mounts: 0,
}))

vi.mock('../../../src/renderer/project-manager/components/CodeEditor', () => ({
  // 假件模拟真实 CodeEditor 的生命周期：挂载时把句柄交给父级（ref-as-prop）、
  // 视图就绪时回调 onEditorReady，卸载时交还 null 句柄。只记录「被要求做什么」。
  CodeEditor: ({ref, onEditorReady}: {ref?: Ref<Handle>, onEditorReady?: () => void}) => {
    useEffect(() => {
      fake.mounts++
      const handle: Handle = {
        locate(line, options) {
          const applied = fake.viewReady
          fake.calls.push({method: 'locate', line, scroll: options?.scroll, applied})
          return applied
        },
        clearLocate() { fake.calls.push({method: 'clearLocate'}) },
      }
      fake.notifyReady = onEditorReady ?? null
      const r = ref
      if (typeof r === 'function') r(handle)
      else if (r) r.current = handle
      if (fake.viewReady) onEditorReady?.()
      return () => {
        fake.mounts--
        fake.notifyReady = null
        if (typeof r === 'function') r(null)
        else if (r) r.current = null
      }
      // 只模拟一次实例生命周期（真实组件同样只在挂载时注册）
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return <div data-testid="code-editor" />
  },
}))

const locateCalls = () => fake.calls.filter(c => c.method === 'locate')
const clearCalls = () => fake.calls.filter(c => c.method === 'clearLocate')

/** 打开并激活一个 file tab（locateRequestStore 的请求要命中它才会被应用） */
const openFile = (path: string, content = 'x') => {
  useEditorTabStore.getState().openFileTab({path, title: path, content, hash: `h-${path}`})
  return useEditorTabStore.getState().tabs.find(t => t.filePath === path)!.id
}

beforeEach(() => {
  fake.calls.length = 0
  fake.viewReady = true
  fake.notifyReady = null
  fake.mounts = 0
  useLocateRequestStore.getState().reset()
  useEditorTabStore.setState({tabs: [], activeTabId: null})
  vi.useFakeTimers()
})

afterEach(() => { vi.useRealTimers() })

describe('EditorArea 定位接线：请求 → 落到编辑器', () => {
  it('建 tab 与发请求在同一 tick（QuickOpen 的真实序列）也能落到位', () => {
    render(<EditorArea />)   // 挂载时还没有任何 tab
    act(() => {
      useEditorTabStore.getState().openFileTab({path: 'a.ts', title: 'a.ts', content: 'x', hash: 'h'})
      requestLocate('a.ts', 30)
    })
    expect(locateCalls()).toHaveLength(1)
    expect(locateCalls()[0]).toMatchObject({line: 30, scroll: true})
  })

  it('编辑器后挂载：请求先到先挂起，编辑器挂载后就位并落到该行', () => {
    // content 被淘汰的 tab：编辑器分支不渲染（只有「加载中…」），内容回填后才出现 CodeEditor
    const id = openFile('a.ts')
    useEditorTabStore.setState(s => ({
      tabs: s.tabs.map(t => (t.id === id ? {...t, content: undefined} : t)),
    }))
    render(<EditorArea />)
    expect(screen.queryByTestId('code-editor')).toBeNull()

    act(() => { requestLocate('a.ts', 42) })
    expect(locateCalls()).toHaveLength(0)   // 编辑器还没挂载：请求必须挂起，不能丢

    act(() => { useEditorTabStore.getState().reloadTabContent(id, 'line1\nline2', 'h2') })
    expect(screen.getByTestId('code-editor')).toBeInTheDocument()
    expect(locateCalls()).toHaveLength(1)
    expect(locateCalls()[0]).toMatchObject({line: 42, scroll: true})
  })

  it('编辑器已挂载但视图未就绪：请求保持挂起，视图就绪后补上', () => {
    openFile('a.ts')
    render(<EditorArea />)
    expect(locateCalls()).toHaveLength(0)

    fake.viewReady = false   // 视图被销毁、新视图尚未创建
    act(() => { requestLocate('a.ts', 7) })
    expect(locateCalls()).toHaveLength(1)
    expect(locateCalls()[0]).toMatchObject({line: 7, applied: false})   // 未落地

    act(() => { fake.viewReady = true; fake.notifyReady?.() })
    expect(locateCalls()).toHaveLength(2)
    expect(locateCalls()[1]).toMatchObject({line: 7, applied: true})
  })

  it('不属于当前激活文件的请求直接丢弃（不落到当前 tab）', () => {
    openFile('a.ts')
    render(<EditorArea />)
    act(() => { requestLocate('other.ts', 5) })
    expect(locateCalls()).toHaveLength(0)
  })
})

describe('EditorArea 定位接线：1500ms 硬清除与重复定位', () => {
  it('定位后 1500ms 自动清除（1499ms 时仍在，无渐隐）', () => {
    openFile('a.ts')
    render(<EditorArea />)
    act(() => { requestLocate('a.ts', 5) })
    expect(clearCalls()).toHaveLength(0)

    act(() => { vi.advanceTimersByTime(1499) })
    expect(clearCalls()).toHaveLength(0)

    act(() => { vi.advanceTimersByTime(1) })
    expect(clearCalls()).toHaveLength(1)
  })

  it('再次定位到新行：旧计时器作废，从新高亮重新计时', () => {
    openFile('a.ts')
    render(<EditorArea />)
    act(() => { requestLocate('a.ts', 5) })
    act(() => { vi.advanceTimersByTime(1200) })
    act(() => { requestLocate('a.ts', 9) })

    expect(locateCalls().map(c => c.line)).toEqual([5, 9])
    expect(locateCalls()[1]).toMatchObject({scroll: true})

    // 距第一次定位已 1200ms+1200ms > 1500ms：旧计时器若还在就会误清新高亮
    act(() => { vi.advanceTimersByTime(1200) })
    expect(clearCalls()).toHaveLength(0)

    act(() => { vi.advanceTimersByTime(300) })   // 距第二次定位满 1500ms
    expect(clearCalls()).toHaveLength(1)
  })

  it('重复定位到同一行：只重置计时，不重新滚动', () => {
    openFile('a.ts')
    render(<EditorArea />)
    act(() => { requestLocate('a.ts', 5) })
    act(() => { vi.advanceTimersByTime(1400) })
    act(() => { requestLocate('a.ts', 5) })

    expect(locateCalls().map(c => c.scroll)).toEqual([true, false])

    act(() => { vi.advanceTimersByTime(1400) })   // 旧的 1500ms 已过，新计时未满
    expect(clearCalls()).toHaveLength(0)
    act(() => { vi.advanceTimersByTime(100) })
    expect(clearCalls()).toHaveLength(1)
  })
})

describe('EditorArea 定位接线：切 tab 不串味', () => {
  it('切 tab 后为旧 tab 发请求不生效；新 tab 的请求正常生效', () => {
    openFile('a.ts')
    render(<EditorArea />)
    act(() => { requestLocate('a.ts', 5) })
    expect(locateCalls()).toHaveLength(1)

    act(() => { openFile('b.ts') })
    act(() => { requestLocate('a.ts', 99) })   // 激活的是 b.ts → 丢弃
    expect(locateCalls()).toHaveLength(1)

    act(() => { requestLocate('b.ts', 5) })
    expect(locateCalls()).toHaveLength(2)
    expect(locateCalls()[1]).toMatchObject({line: 5, scroll: true})
  })

  it('切 tab 后即使行号相同也要滚动（落点记忆不跨 tab）', () => {
    openFile('a.ts')
    render(<EditorArea />)
    act(() => { requestLocate('a.ts', 12) })
    act(() => { openFile('b.ts') })
    // 回到 a.ts 再定位同一行：视图已按新 tab 重建，必须滚动而不是「只重置计时」
    act(() => { requestLocate('b.ts', 12) })
    expect(locateCalls().map(c => c.scroll)).toEqual([true, true])
  })

  it('挂起中的请求在切 tab 后被丢弃（不落到新 tab 上）', () => {
    openFile('a.ts')
    render(<EditorArea />)
    fake.viewReady = false
    act(() => { requestLocate('a.ts', 5) })
    expect(locateCalls()).toHaveLength(1)

    act(() => { openFile('b.ts') })
    act(() => { fake.viewReady = true; fake.notifyReady?.() })
    expect(locateCalls()).toHaveLength(1)   // 未追加任何一次落地
  })
})

describe('EditorArea 定位接线：编辑器销毁即清除点', () => {
  it('编辑器卸载后旧计时器不再触发（不给已销毁的实例留回调）', () => {
    openFile('a.ts')
    const {unmount} = render(<EditorArea />)
    act(() => { requestLocate('a.ts', 5) })
    expect(locateCalls()).toHaveLength(1)

    unmount()
    act(() => { vi.advanceTimersByTime(5000) })
    expect(clearCalls()).toHaveLength(0)
  })

  it('从 file tab 切走（编辑器卸载）后迟到的请求不再落到旧实例', () => {
    const aId = openFile('a.ts')
    render(<EditorArea />)
    act(() => { requestLocate('a.ts', 5) })
    expect(locateCalls()).toHaveLength(1)

    // 关闭该 tab → 编辑器卸载；再发一个请求（路径仍等于已消失的文件）
    act(() => { useEditorTabStore.getState().closeTab(aId) })
    act(() => { requestLocate('a.ts', 8) })
    expect(locateCalls()).toHaveLength(1)
  })
})
