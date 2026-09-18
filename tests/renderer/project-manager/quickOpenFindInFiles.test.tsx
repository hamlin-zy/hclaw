// @vitest-environment jsdom
/**
 * Find in Files 模式的接线（工单 05）：防抖即搜、空查询不搜、新查询终止旧会话、关浮层终止、
 * 分页游标与触底互斥（armed / re-arm）、每文件折叠、截断标注、中文输入法 composition、
 * 回车只打开选中项并请求定位。
 *
 * 断言只针对外部可观察行为：渲染出来的列表、loading / truncated 标志、发给主进程的 IPC 调用、
 * 打开的 tab、同进程的定位请求 store。不测浮层手感与 rg 真实行为（spec §Testing Decisions）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {renderHook, act} from '@testing-library/react'
import type {FindInFilesMatch} from '../../../src/shared/types/project-manager'
import {useQuickOpen} from '../../../src/renderer/project-manager/hooks/useQuickOpen'
import {useEditorTabStore} from '../../../src/renderer/project-manager/stores/editorTabStore'
import {useLocateRequestStore} from '../../../src/renderer/project-manager/stores/locateRequestStore'
import {
    clearPreviewCache,
    previewCache,
    previewCacheKey,
} from '../../../src/renderer/project-manager/lib/quickOpenPreview'

const WS = '/ws'

const findMatch = (path: string, line: number, extra: Partial<FindInFilesMatch> = {}): FindInFilesMatch =>
    ({path, line, text: `line ${line}`, matchStart: 0, matchEnd: 4, ...extra})

/** 暴露在 window 上的 preload 桥；测试里按需替换 */
const pmWindow = window as unknown as {electronAPI?: unknown}

function mockPM(overrides: Record<string, unknown> = {}) {
    const pm = {
        readFile: vi.fn(async () => ({
            path: 'src/a.ts', size: 12, content: 'const a = 1', isBinary: false, isImage: false,
            decodeError: false, mimeType: '', truncated: false, mtime: 0, hash: 'h1',
        })),
        findInFilesStart: vi.fn(async () => ({sessionId: 's1'})),
        findInFilesPage: vi.fn(async () => ({matches: [] as FindInFilesMatch[], truncated: false, done: true})),
        findInFilesStop: vi.fn(async () => {}),
        ...overrides,
    }
    pmWindow.electronAPI = {projectManager: pm}
    return pm
}

/** 拦截快捷键：hook 的监听器挂在 document 的 capture 阶段 */
function pressKey(init: KeyboardEventInit) {
    const evt = new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init})
    act(() => { document.dispatchEvent(evt) })
    return evt
}

const openFind = () => pressKey({ctrlKey: true, shiftKey: true, key: 'F'})

let hooks: Array<{unmount: () => void}> = []
function mount(ws: string | null = WS) {
    const hook = renderHook(() => useQuickOpen(ws))
    hooks.push(hook)
    return hook
}

/** 推进防抖计时器并把落地的 promise 链跑完 */
async function flush(ms = 200) {
    act(() => { vi.advanceTimersByTime(ms) })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    hooks = []
    useEditorTabStore.getState().closeAll()
    useLocateRequestStore.getState().reset()
    clearPreviewCache()
    Object.defineProperty(window.navigator, 'platform', {value: '', configurable: true})
})

afterEach(() => {
    for (const h of hooks) h.unmount()
    hooks = []
    vi.useRealTimers()
})

describe('Find in Files：检索生命周期', () => {
    it('输入后 120ms 防抖即搜，空查询不搜', async () => {
        const pm = mockPM({findInFilesPage: vi.fn(async () => ({matches: [findMatch('a.ts', 1)], truncated: false, done: true}))})
        const hook = mount()

        openFind()
        act(() => { vi.advanceTimersByTime(500) })
        expect(pm.findInFilesStart).not.toHaveBeenCalled()   // 空查询不发请求

        act(() => { hook.result.current.setQuery('fo') })
        act(() => { hook.result.current.setQuery('foo') })
        expect(hook.result.current.loading).toBe(true)       // 防抖等待期就有「搜索中」态
        await flush(120)

        expect(pm.findInFilesStart).toHaveBeenCalledTimes(1)
        expect(pm.findInFilesStart).toHaveBeenCalledWith(WS, 'foo')
        expect(pm.findInFilesPage).toHaveBeenCalledWith('s1', 0, 20)
        expect(hook.result.current.results.map(r => `${r.path}:${r.line}`)).toEqual(['a.ts:1'])
        expect(hook.result.current.loading).toBe(false)
    })

    it('新查询立即终止上一次会话（不等防抖结束）', async () => {
        const pm = mockPM({findInFilesPage: vi.fn(async () => ({matches: [findMatch('a.ts', 1)], truncated: false, done: true}))})
        const hook = mount()

        openFind()
        act(() => { hook.result.current.setQuery('a') })
        await flush(120)
        expect(pm.findInFilesStart).toHaveBeenCalledTimes(1)

        act(() => { hook.result.current.setQuery('ab') })   // 尚未过防抖
        expect(pm.findInFilesStop).toHaveBeenCalledWith('s1')

        await flush(120)
        expect(pm.findInFilesStart).toHaveBeenCalledTimes(2)
    })

    it('关闭浮层立即终止检索并释放缓冲；esc 后键位回到放行态', async () => {
        const pm = mockPM({findInFilesPage: vi.fn(async () => ({matches: [findMatch('a.ts', 1)], truncated: false, done: false}))})
        const hook = mount()

        openFind()
        act(() => { hook.result.current.setQuery('a') })
        await flush(120)
        expect(hook.result.current.results).toHaveLength(1)

        pressKey({key: 'Escape'})
        expect(pm.findInFilesStop).toHaveBeenCalledWith('s1')
        expect(hook.result.current.mode).toBe(null)
        expect(hook.result.current.results).toEqual([])
        expect(hook.result.current.findFolds.size).toBe(0)
    })

    it('中文输入法：composition 期间不搜，compositionend 后立即搜一次', async () => {
        const pm = mockPM({findInFilesPage: vi.fn(async () => ({matches: [findMatch('中文.ts', 1)], truncated: false, done: true}))})
        const hook = mount()

        openFind()
        act(() => { hook.result.current.onCompositionStart() })
        act(() => { hook.result.current.setQuery('zhong') })
        act(() => { hook.result.current.setQuery('中文') })
        act(() => { vi.advanceTimersByTime(1000) })
        expect(pm.findInFilesStart).not.toHaveBeenCalled()

        act(() => { hook.result.current.onCompositionEnd() })
        await flush(10)
        expect(pm.findInFilesStart).toHaveBeenCalledTimes(1)
        expect(pm.findInFilesStart).toHaveBeenCalledWith(WS, '中文')
    })

    it('空查询把已有结果清空（不留上一次的关键词残留）', async () => {
        mockPM({findInFilesPage: vi.fn(async () => ({matches: [findMatch('a.ts', 1)], truncated: false, done: true}))})
        const hook = mount()

        openFind()
        act(() => { hook.result.current.setQuery('a') })
        await flush(120)
        expect(hook.result.current.results).toHaveLength(1)

        act(() => { hook.result.current.setQuery('   ') })
        expect(hook.result.current.results).toEqual([])
        expect(hook.result.current.loading).toBe(false)
    })

    /**
     * 回归护栏（打包版「ctrl+shift+f 搜不到任何东西」事故）：
     * 检索进程起不来时主进程会带回 error——必须显示原因，而不是伪装成「无匹配」。
     */
    it('检索不可用（page.error）时显示原因并退出 loading，不当成无匹配', async () => {
        mockPM({
            findInFilesPage: vi.fn(async () => ({
                matches: [], truncated: false, done: true,
                error: '未找到可用的 ripgrep，无法检索文件内容',
            })),
        })
        const hook = mount()

        openFind()
        act(() => { hook.result.current.setQuery('QuickOpen') })
        await flush(120)

        expect(hook.result.current.loading).toBe(false)
        expect(hook.result.current.results).toEqual([])
        expect(hook.result.current.error).toContain('ripgrep')
    })
})

describe('Find in Files：分页与折叠', () => {
    /** 每页 20 个命中项、永不完结（用于验证游标推进与互斥） */
    const endlessPage = () => vi.fn(async (_sid: string, offset: number) => ({
        matches: Array.from({length: 20}, (_, i) => findMatch(`f${offset + i}.ts`, 1)),
        truncated: false,
        done: false,
    }))

    it('每页 20 个命中项；触底加载下一页，游标接着上一次的数', async () => {
        const pm = mockPM({findInFilesPage: endlessPage()})
        const hook = mount()

        openFind()
        act(() => { hook.result.current.setQuery('a') })
        await flush(120)
        expect(pm.findInFilesPage).toHaveBeenCalledWith('s1', 0, 20)
        expect(hook.result.current.results).toHaveLength(20)
        expect(hook.result.current.hasMore).toBe(true)

        act(() => { hook.result.current.onListScroll({scrollTop: 900, scrollHeight: 1300, clientHeight: 400}) })
        await flush(0)
        expect(pm.findInFilesPage).toHaveBeenLastCalledWith('s1', 20, 20)
        expect(hook.result.current.results).toHaveLength(40)
    })

    it('触底互斥：仍贴底时不会重复取同一页；滚开再回底才取下一页', async () => {
        const pm = mockPM({findInFilesPage: endlessPage()})
        const hook = mount()

        openFind()
        act(() => { hook.result.current.setQuery('a') })
        await flush(120)

        const near = {scrollTop: 900, scrollHeight: 1300, clientHeight: 400}
        act(() => { hook.result.current.onListScroll(near) })
        await flush(0)
        expect(pm.findInFilesPage).toHaveBeenCalledTimes(2)   // 首页 + 第 2 页

        // 追加新页后 Chromium 的滚动锚定会再派发一次 scroll：仍贴底 → 被互斥挡住
        act(() => { hook.result.current.onListScroll(near) })
        await flush(0)
        expect(pm.findInFilesPage).toHaveBeenCalledTimes(2)

        // 用户滚开（重新武装）再回到底部 → 正常取下一页
        act(() => { hook.result.current.onListScroll({scrollTop: 0, scrollHeight: 1300, clientHeight: 400}) })
        act(() => { hook.result.current.onListScroll(near) })
        await flush(0)
        expect(pm.findInFilesPage).toHaveBeenCalledTimes(3)
        expect(pm.findInFilesPage).toHaveBeenLastCalledWith('s1', 40, 20)
        expect(hook.result.current.results).toHaveLength(60)
    })

    it('会话已结束时不再翻页', async () => {
        const pm = mockPM({findInFilesPage: vi.fn(async () => ({matches: [findMatch('a.ts', 1)], truncated: false, done: true}))})
        const hook = mount()

        openFind()
        act(() => { hook.result.current.setQuery('a') })
        await flush(120)
        expect(hook.result.current.hasMore).toBe(false)

        act(() => { hook.result.current.onListScroll({scrollTop: 900, scrollHeight: 1300, clientHeight: 400}) })
        await flush(0)
        expect(pm.findInFilesPage).toHaveBeenCalledTimes(1)
    })

    it('同一文件命中超过 10 个：展开 10 个，其余折叠为「还有 M 处」', async () => {
        const matches = Array.from({length: 12}, (_, i) => findMatch('src/a.ts', i + 1))
        mockPM({findInFilesPage: vi.fn(async () => ({matches, truncated: false, done: true}))})
        const hook = mount()

        openFind()
        act(() => { hook.result.current.setQuery('a') })
        await flush(120)

        expect(hook.result.current.results).toHaveLength(10)
        expect(hook.result.current.results.every(r => r.path === 'src/a.ts')).toBe(true)
        expect(hook.result.current.findFolds.get('src/a.ts')).toBe(2)
    })

    it('缓冲达到上限（truncated）时标注已截断，且不再翻页', async () => {
        const pm = mockPM({findInFilesPage: vi.fn(async () => ({
            matches: [findMatch('a.ts', 1)], truncated: true, done: true,
        }))})
        const hook = mount()

        openFind()
        act(() => { hook.result.current.setQuery('a') })
        await flush(120)

        expect(hook.result.current.truncated).toBe(true)
        expect(hook.result.current.hasMore).toBe(false)
        act(() => { hook.result.current.onListScroll({scrollTop: 900, scrollHeight: 1300, clientHeight: 400}) })
        await flush(0)
        expect(pm.findInFilesPage).toHaveBeenCalledTimes(1)
    })
})

describe('Find in Files：打开与定位', () => {
    const twoMatches = () => vi.fn(async () => ({
        matches: [findMatch('src/a.ts', 12), findMatch('src/b.ts', 3)],
        truncated: false,
        done: true,
    }))

    it('回车只打开选中项、不触发搜索', async () => {
        const pm = mockPM({findInFilesPage: twoMatches()})
        const hook = mount()

        openFind()
        act(() => { hook.result.current.setQuery('a') })
        await flush(120)
        expect(pm.findInFilesStart).toHaveBeenCalledTimes(1)

        pressKey({key: 'Enter'})
        await act(async () => { await Promise.resolve() })
        await act(async () => { await Promise.resolve() })

        expect(pm.findInFilesStart).toHaveBeenCalledTimes(1)
        expect(pm.readFile).toHaveBeenCalledWith(WS, 'src/a.ts')
    })

    it('回车打开文件并在主编辑区激活，同时请求定位到命中行', async () => {
        mockPM({findInFilesPage: twoMatches()})
        const hook = mount()

        openFind()
        act(() => { hook.result.current.setQuery('a') })
        await flush(120)

        pressKey({key: 'ArrowDown'})   // 选中第二项：src/b.ts 第 3 行
        pressKey({key: 'Enter'})
        await act(async () => { await Promise.resolve() })
        await act(async () => { await Promise.resolve() })

        const tabs = useEditorTabStore.getState().tabs
        expect(tabs).toHaveLength(1)
        expect(tabs[0].type).toBe('file')
        expect(useEditorTabStore.getState().activeTabId).toBe(tabs[0].id)
        expect(useLocateRequestStore.getState()).toMatchObject({path: 'src/b.ts', line: 3, seq: 1})
        expect(hook.result.current.mode).toBe(null)
        expect(hook.result.current.results).toEqual([])
    })

    it('关闭浮层会终止检索会话（打开文件后不留后台 rg）', async () => {
        const pm = mockPM({findInFilesPage: twoMatches()})
        const hook = mount()

        openFind()
        act(() => { hook.result.current.setQuery('a') })
        await flush(120)

        pressKey({key: 'Enter'})
        await act(async () => { await Promise.resolve() })
        await act(async () => { await Promise.resolve() })

        expect(pm.findInFilesStop).toHaveBeenCalledWith('s1')
    })

    it('EOF 短路复用：预览已带回全文时不再发全量读', async () => {
        const pm = mockPM({findInFilesPage: twoMatches()})
        const hook = mount()

        openFind()
        act(() => { hook.result.current.setQuery('a') })
        await flush(120)

        // 预览取数带回全文（EOF 短路）→ 缓存在进程级单例里
        previewCache.set(previewCacheKey(WS, 'src/a.ts', 9, 15), {
            path: 'src/a.ts', startLine: 9, endLine: 15, totalLines: 15,
            lines: [], size: 12, mtime: 1, fullContent: 'const a = 1\n', hash: 'h1',
        })

        pressKey({key: 'Enter'})
        await act(async () => { await Promise.resolve() })
        await act(async () => { await Promise.resolve() })

        expect(pm.readFile).not.toHaveBeenCalled()
        expect(useEditorTabStore.getState().tabs[0].content).toBe('const a = 1\n')
        expect(useEditorTabStore.getState().tabs[0].fileHash).toBe('h1')
    })
})
