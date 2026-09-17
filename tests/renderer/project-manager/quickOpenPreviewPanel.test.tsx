// @vitest-environment jsdom
/**
 * 预览面板的取数与落地行为（工单 04）。
 *
 * 保护：120ms 防抖、按行范围取数（走 pm.readLines，不碰全量读）、元信息行（完整相对路径 · 大小 ·
 * 修改时间）、文件头 20 行 / 命中行 ±3 行、命中区间高亮、失败单行文案、
 * 陈旧响应丢弃且不污染缓存、缓存命中不再取数、切工作区清空、卸载（浮层关闭）释放、EOF 短路留在缓存。
 *
 * 不测浮层手感与 CodeMirror 实例行为（spec §Testing Decisions）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, act, waitFor} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type {FileSliceResult} from '../../../src/shared/types/project-manager'
import {QuickOpenPreview} from '../../../src/renderer/project-manager/components/QuickOpenPreview'
import type {QuickOpenItem} from '../../../src/renderer/project-manager/lib/quickOpenResults'
import {
    clearPreviewCache,
    findCachedFullContent,
    previewCache,
    previewCacheKey,
    previewCacheSize,
} from '../../../src/renderer/project-manager/lib/quickOpenPreview'

const WS = '/ws'
const MTIME = new Date(2026, 8, 16, 20, 45).getTime()

const item = (path: string, extra: Partial<QuickOpenItem> = {}): QuickOpenItem =>
    ({path, matchStart: null, matchEnd: null, ...extra})

function sliceFor(path: string, extra: Partial<FileSliceResult> = {}): FileSliceResult {
    return {
        path,
        startLine: 1,
        endLine: 2,
        totalLines: 2,
        lines: ['const a = 1', 'const b = 2'],
        size: 2048,
        mtime: MTIME,
        ...extra,
    }
}

/** 暴露在 window 上的 preload 桥；测试里按需替换 */
const pmWindow = window as unknown as {electronAPI?: unknown}

function mockPM(readLines: unknown) {
    pmWindow.electronAPI = {projectManager: {readLines}}
}

/** 推进防抖计时器并把落地的 promise 链跑完 */
async function flush(ms = 120) {
    act(() => { vi.advanceTimersByTime(ms) })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
}

const previewLines = () => screen.getByTestId('pm-quickopen-preview-lines')

beforeEach(() => {
    vi.useFakeTimers()
    clearPreviewCache()
    delete pmWindow.electronAPI
})

afterEach(() => {
    vi.useRealTimers()
})

describe('预览取数', () => {
    it('File Search：120ms 防抖后按「文件头 20 行」取数，并给出一行元信息', async () => {
        const readLines = vi.fn(async () => sliceFor('src/a.ts'))
        mockPM(readLines)
        render(<QuickOpenPreview mode="file-search" item={item('src/a.ts')} workspacePath={WS} />)

        act(() => { vi.advanceTimersByTime(119) })
        expect(readLines).not.toHaveBeenCalled()   // 划过去的项不产生读取
        await flush(1)

        expect(readLines).toHaveBeenCalledWith(WS, 'src/a.ts', 1, 20)
        expect(screen.getByTestId('pm-quickopen-preview-meta'))
            .toHaveTextContent('src/a.ts · 2.0 KB · 2026-09-16 20:45')
        expect(previewLines().querySelectorAll('.pm-quickopen-preview-line')).toHaveLength(2)
        expect(previewLines().textContent).toContain('const a = 1')
        expect(previewLines().querySelector('.pm-quickopen-preview-lineno')).toHaveTextContent('1')
    })

    it('Find in Files：请求命中行上下 3 行，且只有命中行带行内高亮', async () => {
        const lines = Array.from({length: 7}, (_, i) => `line ${47 + i}`)
        const readLines = vi.fn(async () => sliceFor('src/a.ts', {startLine: 47, endLine: 53, totalLines: 100, lines}))
        mockPM(readLines)
        const {container} = render(
            <QuickOpenPreview
                mode="find-in-files"
                item={item('src/a.ts', {line: 50, matchStart: 5, matchEnd: 7, matchText: 'line 50'})}
                workspacePath={WS}
            />,
        )
        await flush()

        expect(readLines).toHaveBeenCalledWith(WS, 'src/a.ts', 47, 53)
        const hit = container.querySelector('.pm-quickopen-preview-line.is-hit')!
        expect(hit).toHaveAttribute('data-line', '50')
        expect(hit.querySelector('mark')).toHaveTextContent('50')
        expect(container.querySelectorAll('.pm-quickopen-preview-line.is-hit')).toHaveLength(1)
    })

    it('调用方每帧新建 item 字面量：不因对象身份重跑 effect，防抖不被无限重置', async () => {
        const readLines = vi.fn(async () => sliceFor('src/a.ts'))
        mockPM(readLines)
        // 每一帧都是**新对象**（调用方内联字面量的场景）。修复前 effect 依赖 item 本体：
        // 每次重渲染都重跑 effect → 重置 120ms 防抖计时器 → 取数永远不发生（实测会无界循环到 OOM）。
        const fresh = () => ({path: 'src/a.ts', matchStart: null, matchEnd: null})
        const {rerender} = render(<QuickOpenPreview mode="file-search" item={fresh()} workspacePath={WS} />)
        for (let i = 0; i < 4; i++) {
            act(() => { vi.advanceTimersByTime(50) })
            rerender(<QuickOpenPreview mode="file-search" item={fresh()} workspacePath={WS} />)
        }
        act(() => { vi.advanceTimersByTime(60) })   // 累计 260ms：t=0 起的计时器该在 120ms 就触发
        await act(async () => { await Promise.resolve() })

        expect(readLines).toHaveBeenCalledTimes(1)
        expect(previewLines()).toHaveTextContent('const a = 1')
    })

    it('缓存命中：同一选中项再次出现时直接出内容，不再取数', async () => {
        const readLines = vi.fn(async () => sliceFor('src/a.ts'))
        mockPM(readLines)
        const {rerender} = render(<QuickOpenPreview mode="file-search" item={item('src/a.ts')} workspacePath={WS} />)
        await flush()
        expect(readLines).toHaveBeenCalledTimes(1)

        rerender(<QuickOpenPreview mode="file-search" item={null} workspacePath={WS} />)
        rerender(<QuickOpenPreview mode="file-search" item={item('src/a.ts')} workspacePath={WS} />)
        expect(previewLines()).toHaveTextContent('const a = 1')
        expect(readLines).toHaveBeenCalledTimes(1)
    })
})

describe('预览失败', () => {
    it('主进程给出单行原因文案：不空白、不显示行、不提供重试', async () => {
        mockPM(vi.fn(async () => sliceFor('bin/a.bin', {lines: [], error: '二进制文件，无法预览', size: 12})))
        render(<QuickOpenPreview mode="file-search" item={item('bin/a.bin')} workspacePath={WS} />)
        await flush()

        expect(screen.getByTestId('pm-quickopen-preview-error')).toHaveTextContent('二进制文件，无法预览')
        expect(screen.queryByTestId('pm-quickopen-preview-lines')).toBeNull()
        expect(screen.getByTestId('pm-quickopen-preview-meta')).toHaveTextContent('bin/a.bin · 12 B')
        expect(screen.queryByRole('button')).toBeNull()
    })

    it('IPC 抛错：回落单行文案', async () => {
        mockPM(vi.fn(async () => { throw new Error('EACCES') }))
        render(<QuickOpenPreview mode="file-search" item={item('src/a.ts')} workspacePath={WS} />)
        await flush()
        expect(screen.getByTestId('pm-quickopen-preview-error')).toHaveTextContent('预览读取失败')
    })

    it('无工作区时不取数（只给路径，不留空白）', () => {
        const readLines = vi.fn()
        mockPM(readLines)
        render(<QuickOpenPreview mode="file-search" item={item('src/a.ts')} workspacePath={null} />)
        act(() => { vi.advanceTimersByTime(500) })
        expect(readLines).not.toHaveBeenCalled()
        expect(screen.getByTestId('pm-quickopen-preview-meta')).toHaveTextContent('src/a.ts')
    })
})

describe('陈旧响应与缓存边界', () => {
    it('陈旧响应不覆盖新选中项，也不写入缓存', async () => {
        const resolvers: Array<(v: FileSliceResult) => void> = []
        const readLines = vi.fn(() => new Promise<FileSliceResult>(res => { resolvers.push(res) }))
        mockPM(readLines)
        const {rerender} = render(<QuickOpenPreview mode="file-search" item={item('old.ts')} workspacePath={WS} />)
        await flush()   // 第一次请求在途
        rerender(<QuickOpenPreview mode="file-search" item={item('new.ts')} workspacePath={WS} />)
        await flush()   // 第二次请求在途

        act(() => { resolvers[1]!(sliceFor('new.ts', {lines: ['NEW']})) })
        await act(async () => { await Promise.resolve() })
        expect(previewLines()).toHaveTextContent('NEW')

        act(() => { resolvers[0]!(sliceFor('old.ts', {lines: ['OLD']})) })   // 旧请求迟到返回
        await act(async () => { await Promise.resolve() })
        expect(previewLines()).toHaveTextContent('NEW')
        expect(previewCache.has(previewCacheKey(WS, 'old.ts', 1, 20))).toBe(false)
        expect(findCachedFullContent(WS, 'old.ts')).toBe(null)
    })

    it('切换工作区即清空缓存（不跨工作区串味）', async () => {
        mockPM(vi.fn(async () => sliceFor('a.ts')))
        const {rerender} = render(<QuickOpenPreview mode="file-search" item={item('a.ts')} workspacePath="/ws1" />)
        await flush()
        expect(previewCacheSize()).toBe(1)

        rerender(<QuickOpenPreview mode="file-search" item={item('a.ts')} workspacePath="/ws2" />)
        expect(previewCacheSize()).toBe(0)
    })

    it('浮层关闭（卸载）后缓存与内容一并释放', async () => {
        mockPM(vi.fn(async () => sliceFor('a.ts')))
        const {unmount} = render(<QuickOpenPreview mode="file-search" item={item('a.ts')} workspacePath={WS} />)
        await flush()
        expect(previewCacheSize()).toBe(1)

        unmount()
        expect(previewCacheSize()).toBe(0)
    })

    it('EOF 短路：全文与哈希留在缓存里供打开时复用', async () => {
        const full = sliceFor('a.ts', {fullContent: 'const a = 1\n', hash: 'h1', size: 12})
        const readLines = vi.fn(async () => full)
        mockPM(readLines)
        render(<QuickOpenPreview mode="file-search" item={item('a.ts')} workspacePath={WS} />)
        await flush()

        expect(readLines).toHaveBeenCalledTimes(1)
        expect(findCachedFullContent(WS, 'a.ts')).toBe(full)
    })
})

describe('预览语法着色', () => {
    it('着色类名与编辑器/diff 同源（.pm-tok-*，同一批 --code-* 令牌）', async () => {
        vi.useRealTimers()   // 着色是动态 import + Promise，不等假计时器
        mockPM(vi.fn(async () => sliceFor('src/a.ts', {lines: ['const a = 1', '// 注释'], endLine: 2})))
        const {container} = render(<QuickOpenPreview mode="file-search" item={item('src/a.ts')} workspacePath={WS} />)

        await waitFor(() => { expect(container.querySelector('.pm-tok-keyword')).not.toBeNull() })
        expect(container.querySelector('.pm-tok-keyword')).toHaveTextContent('const')
        expect(container.querySelector('.pm-tok-comment')).toHaveTextContent('// 注释')
        // 着色是逐行切片：文本一字不少（lineText 的不变量）
        expect(previewLines()).toHaveTextContent('const a = 1')
    })

    it('不可着色的扩展名（.md）退回单色，且不丢字', async () => {
        vi.useRealTimers()
        mockPM(vi.fn(async () => sliceFor('README.md', {lines: ['# 标题'], endLine: 1})))
        const {container} = render(<QuickOpenPreview mode="file-search" item={item('README.md')} workspacePath={WS} />)
        await waitFor(() => { expect(previewLines()).toHaveTextContent('# 标题') })
        expect(container.querySelector('[class^="pm-tok-"]')).toBeNull()
    })
})

describe('预览空态', () => {
    it('无选中项时提示用上下键选择', () => {
        render(<QuickOpenPreview mode="file-search" item={null} workspacePath={WS} />)
        expect(screen.getByText('上下键选择条目以查看预览')).toBeInTheDocument()
    })
})
