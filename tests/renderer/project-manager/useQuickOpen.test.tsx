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
import {readRecentFiles, recordRecentFile} from '../../../src/renderer/project-manager/lib/recentFiles'
import {useEditorTabStore} from '../../../src/renderer/project-manager/stores/editorTabStore'

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

// ── 数据源 / 打开流程 / 陈旧响应（工单 02 + 03）──────────────────────────────
//
// 断言只针对外部可观察行为：可见结果、loading / truncated 标志、打开的 tab、
// localStorage 里的 Recent Files、以及「有没有对主进程发请求」。不测内部状态与实现细节。
describe('useQuickOpen 数据源与打开流程', () => {
  const WS = '/ws'
  /** 主进程能力 mock；默认返回一份可用的 FileContentResult */
  function mockPM(overrides: Record<string, unknown> = {}) {
    const pm = {
      readFile: vi.fn(async () => ({
        path: 'src/a.ts', size: 12, content: 'const a = 1', isBinary: false, isImage: false,
        decodeError: false, mimeType: '', truncated: false, mtime: 0, hash: 'h1',
      })),
      searchFiles: vi.fn(async () => [] as Array<{path: string; matchStart: number; matchEnd: number}>),
      ...overrides,
    }
    ;(window as any).electronAPI = {projectManager: pm}
    return pm
  }

  let hooks: Array<{unmount: () => void}> = []

  function mount(ws: string | null = WS) {
    const hook = renderHook(() => useQuickOpen(ws))
    hooks.push(hook)
    return hook
  }

  /** 推进防抖计时器并把落地的 promise 链跑完（readFile / searchFiles 都是 microtask） */
  async function flushTimers(ms = 200) {
    act(() => { vi.advanceTimersByTime(ms) })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    useEditorTabStore.getState().closeAll()
    Object.defineProperty(window.navigator, 'platform', {value: '', configurable: true})
  })

  afterEach(() => {
    for (const h of hooks) h.unmount()
    hooks = []
    vi.useRealTimers()
  })

  const hits = (...paths: string[]) =>
    paths.map(p => ({path: p, matchStart: 0, matchEnd: 1}))

  it('Recent Files：打开浮层立即出结果（读 MRU，无防抖、不查文件是否存在）', async () => {
    recordRecentFile(WS, 'src/old.ts', 100)
    recordRecentFile(WS, 'src/new.ts', 200)
    const pm = mockPM()
    const hook = mount()

    pressKey({ctrlKey: true, key: 'e'})

    expect(hook.result.current.mode).toBe('recent-files')
    expect(hook.result.current.results.map(r => r.path)).toEqual(['src/new.ts', 'src/old.ts'])
    expect(hook.result.current.loading).toBe(false)
    // 打开浮层不做存在性校验：不产生任何 fs / IPC 调用（spec §Recent Files）
    expect(pm.readFile).not.toHaveBeenCalled()
    expect(pm.searchFiles).not.toHaveBeenCalled()
  })

  it('File Search：空查询不发请求；输入后经 120ms 防抖只发一次', async () => {
    const pm = mockPM({searchFiles: vi.fn(async () => hits('src/app.ts'))})
    const hook = mount()

    pressKey({ctrlKey: true, shiftKey: true, key: 'N'})
    expect(hook.result.current.mode).toBe('file-search')
    act(() => { vi.advanceTimersByTime(500) })
    expect(pm.searchFiles).not.toHaveBeenCalled()   // 空查询不发请求

    act(() => { hook.result.current.setQuery('ap') })
    act(() => { hook.result.current.setQuery('app') })
    expect(hook.result.current.loading).toBe(true)  // 防抖等待期就有「搜索中」态
    await flushTimers(120)

    expect(pm.searchFiles).toHaveBeenCalledTimes(1)
    expect(pm.searchFiles).toHaveBeenCalledWith(WS, 'app', 50)
    expect(hook.result.current.results.map(r => r.path)).toEqual(['src/app.ts'])
    expect(hook.result.current.loading).toBe(false)
  })

  it('File Search：结果达到单次上限时标注已截断', async () => {
    const many = Array.from({length: 50}, (_, i) => ({path: `f${i}.ts`, matchStart: 0, matchEnd: 1}))
    mockPM({searchFiles: vi.fn(async () => many)})
    const hook = mount()

    pressKey({ctrlKey: true, shiftKey: true, key: 'N'})
    act(() => { hook.result.current.setQuery('f') })
    await flushTimers(120)

    expect(hook.result.current.results).toHaveLength(50)
    expect(hook.result.current.truncated).toBe(true)
  })

  it('File Search：主进程检索失败时给出错误文案且不留半截结果', async () => {
    mockPM({searchFiles: vi.fn(async () => { throw new Error('rg crashed') })})
    const hook = mount()

    pressKey({ctrlKey: true, shiftKey: true, key: 'N'})
    act(() => { hook.result.current.setQuery('a') })
    await flushTimers(120)

    expect(hook.result.current.error).toBe('检索失败')
    expect(hook.result.current.results).toEqual([])
    expect(hook.result.current.loading).toBe(false)
  })

  it('陈旧响应被丢弃：迟到返回的旧查询结果不覆盖新结果', async () => {
    const resolvers: Array<(v: any) => void> = []
    const searchFiles = vi.fn(() => new Promise<any>(res => { resolvers.push(res) }))
    mockPM({searchFiles})
    const hook = mount()

    pressKey({ctrlKey: true, shiftKey: true, key: 'N'})
    act(() => { hook.result.current.setQuery('a') })
    await flushTimers(120)                      // 第一次请求在途
    act(() => { hook.result.current.setQuery('ab') })
    await flushTimers(120)                      // 第二次请求在途

    act(() => { resolvers[1]!(hits('new.ts')) })
    await act(async () => { await Promise.resolve() })
    expect(hook.result.current.results.map(r => r.path)).toEqual(['new.ts'])

    act(() => { resolvers[0]!(hits('stale.ts')) })   // 旧请求迟到返回
    await act(async () => { await Promise.resolve() })
    expect(hook.result.current.results.map(r => r.path)).toEqual(['new.ts'])
  })

  it('回车打开选中项：主编辑区打开并激活、记入 Recent Files、浮层关闭', async () => {
    const pm = mockPM({searchFiles: vi.fn(async () => hits('src/a.ts'))})
    const hook = mount()

    pressKey({ctrlKey: true, shiftKey: true, key: 'N'})
    act(() => { hook.result.current.setQuery('a') })
    await flushTimers(120)

    const evt = pressKey({key: 'Enter'})
    expect(evt.defaultPrevented).toBe(true)
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    expect(pm.readFile).toHaveBeenCalledWith(WS, 'src/a.ts')
    const tabs = useEditorTabStore.getState().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0].type).toBe('file')
    expect(useEditorTabStore.getState().activeTabId).toBe(tabs[0].id)   // 打开并激活
    expect(readRecentFiles(WS).map(e => e.path)).toEqual(['src/a.ts'])
    expect(hook.result.current.mode).toBe(null)
    expect(hook.result.current.results).toEqual([])                     // 关闭即释放列表
  })

  it('回车只打开选中项，不触发搜索', async () => {
    const pm = mockPM({searchFiles: vi.fn(async () => hits('src/a.ts'))})
    const hook = mount()

    pressKey({ctrlKey: true, shiftKey: true, key: 'N'})
    act(() => { hook.result.current.setQuery('a') })
    await flushTimers(120)
    expect(pm.searchFiles).toHaveBeenCalledTimes(1)

    pressKey({key: 'Enter'})
    act(() => { vi.advanceTimersByTime(500) })
    await act(async () => { await Promise.resolve() })   // 让打开流程的 promise 链落地，不留 act 警告
    expect(pm.searchFiles).toHaveBeenCalledTimes(1)
  })

  it('上下键移动选中项，回车打开的是当前选中项', async () => {
    const pm = mockPM({searchFiles: vi.fn(async () => hits('a.ts', 'b.ts'))})
    const hook = mount()

    pressKey({ctrlKey: true, shiftKey: true, key: 'N'})
    act(() => { hook.result.current.setQuery('a') })
    await flushTimers(120)
    expect(hook.result.current.activeIndex).toBe(0)

    pressKey({key: 'ArrowDown'})
    expect(hook.result.current.activeIndex).toBe(1)
    pressKey({key: 'ArrowDown'})   // 到底不回绕
    expect(hook.result.current.activeIndex).toBe(1)
    pressKey({key: 'ArrowUp'})
    expect(hook.result.current.activeIndex).toBe(0)

    pressKey({key: 'Enter'})
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(pm.readFile).toHaveBeenCalledWith(WS, 'a.ts')
  })

  it('打开已删除 / 改名的文件：就地标灰并从记录剔除，不产生未捕获错误', async () => {
    recordRecentFile(WS, 'gone.ts', 1)
    mockPM({readFile: vi.fn(async () => { throw new Error('ENOENT') })})
    const hook = mount()

    pressKey({ctrlKey: true, key: 'e'})
    expect(hook.result.current.results.map(r => r.path)).toEqual(['gone.ts'])

    pressKey({key: 'Enter'})
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    expect(hook.result.current.stalePaths.has('gone.ts')).toBe(true)
    expect(readRecentFiles(WS)).toEqual([])                 // 已从记录剔除
    expect(hook.result.current.mode).toBe('recent-files')   // 浮层留着，用户可继续选
    expect(useEditorTabStore.getState().tabs).toEqual([])   // 不写入任何 tab
  })

  it('中文输入法：composition 期间不搜索，compositionend 后立即搜一次（不经防抖）', async () => {
    const pm = mockPM({searchFiles: vi.fn(async () => hits('中文.ts'))})
    const hook = mount()

    pressKey({ctrlKey: true, shiftKey: true, key: 'N'})
    act(() => { hook.result.current.onCompositionStart() })
    act(() => { hook.result.current.setQuery('zhong') })
    act(() => { hook.result.current.setQuery('中文') })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(pm.searchFiles).not.toHaveBeenCalled()

    act(() => { hook.result.current.onCompositionEnd() })
    act(() => { vi.advanceTimersByTime(10) })
    await act(async () => { await Promise.resolve() })
    expect(pm.searchFiles).toHaveBeenCalledTimes(1)
    expect(pm.searchFiles).toHaveBeenCalledWith(WS, '中文', 50)
  })

  it('composition 期间的上下键与回车不归列表（交给输入法）', () => {
    mockPM()
    const hook = mount()
    pressKey({ctrlKey: true, shiftKey: true, key: 'N'})

    const down = new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true, cancelable: true})
    Object.defineProperty(down, 'isComposing', {value: true})
    act(() => { document.dispatchEvent(down) })
    expect(down.defaultPrevented).toBe(false)
    expect(hook.result.current.mode).toBe('file-search')
  })

  it('Recent Files：「清空记录」后列表为空且记录被抹掉', async () => {
    recordRecentFile(WS, 'a.ts', 1)
    mockPM()
    const hook = mount()

    pressKey({ctrlKey: true, key: 'e'})
    expect(hook.result.current.results).toHaveLength(1)

    act(() => { hook.result.current.clearRecent() })
    expect(hook.result.current.results).toEqual([])
    expect(readRecentFiles(WS)).toEqual([])
  })

  it('切换工作区：Recent Files 与结果整体失效，不跨工作区串味', () => {
    recordRecentFile(WS, 'ws1.ts', 1)
    recordRecentFile('/ws2', 'ws2.ts', 2)
    mockPM()
    const hook = renderHook((props: {ws: string}) => useQuickOpen(props.ws), {initialProps: {ws: WS}})
    hooks.push(hook)

    pressKey({ctrlKey: true, key: 'e'})
    expect(hook.result.current.results.map(r => r.path)).toEqual(['ws1.ts'])

    act(() => { hook.rerender({ws: '/ws2'}) })
    expect(hook.result.current.results).toEqual([])   // 旧仓库列表立刻失效（浮层此时已关闭）
  })

  it('关闭浮层：列表、加载态、标灰集合一并释放', async () => {
    const pm = mockPM({searchFiles: vi.fn(async () => hits('a.ts'))})
    const hook = mount()

    pressKey({ctrlKey: true, shiftKey: true, key: 'N'})
    act(() => { hook.result.current.setQuery('a') })
    await flushTimers(120)
    expect(hook.result.current.results).toHaveLength(1)

    pressKey({key: 'Escape'})
    expect(hook.result.current.mode).toBe(null)
    expect(hook.result.current.results).toEqual([])
    expect(hook.result.current.loading).toBe(false)
    expect(hook.result.current.error).toBe(null)
    expect(hook.result.current.stalePaths.size).toBe(0)

    // 关闭后在途响应即使迟到也不再落地
    expect(pm.searchFiles).toHaveBeenCalledTimes(1)
  })
})
