// 预览面板的纯逻辑（工单 04）：行范围、缓存键与 LRU-10、元信息行、行切片、落地判定、EOF 复用。
//
// 只断言输入 → 输出（spec §Testing Decisions：renderer 纯逻辑落成无状态纯函数后测试），
// 不测浮层手感与 CodeMirror 实例行为。
import {describe, it, expect, beforeEach} from 'vitest'
import type {FileSliceResult} from '../../../src/shared/types/project-manager'
import {
    PREVIEW_CACHE_LIMIT,
    PREVIEW_CONTEXT_LINES,
    PREVIEW_HEAD_LINES,
    PreviewCache,
    acceptPreviewResponse,
    buildPreviewRows,
    clearPreviewCache,
    findCachedFullContent,
    formatFileSize,
    formatMtime,
    previewCache,
    previewCacheKey,
    previewCacheSize,
    mergePreviewSegments,
    previewMetaLine,
    previewRangeFor,
    previewViewFromSlice,
} from '../../../src/renderer/project-manager/lib/quickOpenPreview'
import type {QuickOpenItem} from '../../../src/renderer/project-manager/lib/quickOpenResults'

const item = (path: string, extra: Partial<QuickOpenItem> = {}): QuickOpenItem =>
    ({path, matchStart: null, matchEnd: null, ...extra})

function slice(extra: Partial<FileSliceResult> = {}): FileSliceResult {
    return {path: 'a.ts', startLine: 1, endLine: 2, totalLines: 2, lines: ['x', 'y'], ...extra}
}

describe('预览取数范围（spec §预览）', () => {
    it('File Search / Recent Files：文件头 20 行', () => {
        expect(previewRangeFor('file-search', item('a.ts'))).toEqual({start: 1, end: PREVIEW_HEAD_LINES})
        expect(previewRangeFor('recent-files', item('a.ts'))).toEqual({start: 1, end: PREVIEW_HEAD_LINES})
    })

    it('Find in Files：命中行上下 3 行', () => {
        expect(previewRangeFor('find-in-files', item('a.ts', {line: 50})))
            .toEqual({start: 50 - PREVIEW_CONTEXT_LINES, end: 50 + PREVIEW_CONTEXT_LINES})
    })

    it('Find in Files：行号夹在 1 以上（首行命中不会请求第 0 行）', () => {
        expect(previewRangeFor('find-in-files', item('a.ts', {line: 2}))).toEqual({start: 1, end: 5})
    })
})

describe('预览缓存（LRU-10）', () => {
    it('缓存键含工作区归属与行范围', () => {
        expect(previewCacheKey('/ws1', 'a.ts', 1, 20)).toBe(previewCacheKey('/ws1', 'a.ts', 1, 20))
        expect(previewCacheKey('/ws1', 'a.ts', 1, 20)).not.toBe(previewCacheKey('/ws2', 'a.ts', 1, 20))
        expect(previewCacheKey('/ws1', 'a.ts', 1, 20)).not.toBe(previewCacheKey('/ws1', 'a.ts', 1, 5))
    })

    it('容量 10：第 11 条挤掉最久未用的那条', () => {
        const cache = new PreviewCache(PREVIEW_CACHE_LIMIT)
        for (let i = 1; i <= PREVIEW_CACHE_LIMIT; i++) cache.set(`k${i}`, slice({path: `f${i}.ts`}))
        cache.set('k11', slice({path: 'f11.ts'}))
        expect(cache.size()).toBe(PREVIEW_CACHE_LIMIT)
        expect(cache.has('k1')).toBe(false)   // 最久未用 → 淘汰
        expect(cache.has('k11')).toBe(true)
        expect(cache.entries().map(([k]) => k)).toEqual(
            ['k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10', 'k11'],
        )
    })

    it('get 命中会刷新「最近使用」顺序，从而改变淘汰对象', () => {
        const cache = new PreviewCache(2)
        cache.set('k1', slice())
        cache.set('k2', slice())
        cache.get('k1')          // k1 变为最近使用
        cache.set('k3', slice()) // 淘汰最久未用的 k2
        expect(cache.has('k1')).toBe(true)
        expect(cache.has('k2')).toBe(false)
    })

    it('覆盖同一键不增长容量', () => {
        const cache = new PreviewCache(2)
        cache.set('k1', slice({lines: ['a']}))
        cache.set('k1', slice({lines: ['b']}))
        expect(cache.size()).toBe(1)
        expect(cache.get('k1')?.lines).toEqual(['b'])
    })
})

describe('元信息行与行切片', () => {
    it('元信息行 = 完整相对路径 · 大小 · 修改时间', () => {
        const mtime = new Date(2026, 8, 16, 20, 45).getTime()
        const line = previewMetaLine(item('src/deep/a.ts'), slice({size: 2048, mtime}))
        expect(line).toBe('src/deep/a.ts · 2.0 KB · 2026-09-16 20:45')
    })

    it('取数失败（无 size/mtime）时至少保留完整相对路径', () => {
        expect(previewMetaLine(item('src/a.ts'), slice({lines: []}))).toBe('src/a.ts')
        expect(previewMetaLine(item('src/a.ts'), null)).toBe('src/a.ts')
    })

    it('大小文案：B / KB / MB', () => {
        expect(formatFileSize(999)).toBe('999 B')
        expect(formatFileSize(2048)).toBe('2.0 KB')
        expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB')
    })

    it('修改时间文案：非法值回落空串', () => {
        expect(formatMtime(Number.NaN)).toBe('')
        expect(formatMtime(0)).toBe('')
    })

    it('行切片：行号从主进程返回的 startLine 推导（1-based）', () => {
        const rows = buildPreviewRows(slice({startLine: 48, endLine: 50, lines: ['a', 'b', 'c']}), item('a.ts'))
        expect(rows.map(r => r.lineNumber)).toEqual([48, 49, 50])
        expect(rows.map(r => r.text)).toEqual(['a', 'b', 'c'])
        expect(rows.every(r => r.hitStart === null)).toBe(true)   // 非 find 模式不高亮
    })

    it('Find in Files：只有命中行带行内区间（其余行不高亮）', () => {
        const target = item('a.ts', {line: 49, matchStart: 1, matchEnd: 3})
        const rows = buildPreviewRows(slice({startLine: 48, endLine: 50, lines: ['a', 'b', 'c']}), target)
        expect(rows[1]).toMatchObject({lineNumber: 49, hitStart: 1, hitEnd: 3})
        expect(rows[0].hitStart).toBe(null)
        expect(rows[2].hitStart).toBe(null)
    })
})

describe('着色片段 × 命中区间求交（mergePreviewSegments）', () => {
    const tok = (text: string, cls: string) => ({text, cls})

    it('无着色时整行一段（不额外切碎）', () => {
        expect(mergePreviewSegments('const a = 1', null, null, null))
            .toEqual([{text: 'const a = 1', cls: '', hit: false}])
    })

    it('有命中区间、无着色：按区间切成三段', () => {
        expect(mergePreviewSegments('const a = 1', null, 6, 7)).toEqual([
            {text: 'const ', cls: '', hit: false},
            {text: 'a', cls: '', hit: true},
            {text: ' = 1', cls: '', hit: false},
        ])
    })

    it('着色与命中区间求交：命中跨越 token 边界时逐段判定，且拼接无损', () => {
        const tokens = [tok('const', 'pm-tok-keyword'), tok(' a ', ''), tok('= 1', 'pm-tok-punct')]
        const segments = mergePreviewSegments('const a = 1', tokens, 4, 9)
        expect(segments.map(s => s.text).join('')).toBe('const a = 1')
        expect(segments.map(s => `${s.cls}|${s.hit}|${s.text}`)).toEqual([
            'pm-tok-keyword|false|cons',
            'pm-tok-keyword|true|t',
            '|true| a ',
            'pm-tok-punct|true|=',
            'pm-tok-punct|false| 1',
        ])
    })

    it('相邻同 (类名, 命中) 的片段就地合并', () => {
        const tokens = [tok('ab', 'pm-tok-ident'), tok('cd', 'pm-tok-ident')]
        expect(mergePreviewSegments('abcd', tokens, 1, 3)).toEqual([
            {text: 'a', cls: 'pm-tok-ident', hit: false},
            {text: 'bc', cls: 'pm-tok-ident', hit: true},
            {text: 'd', cls: 'pm-tok-ident', hit: false},
        ])
    })

    it('着色片段与行文本对不上（不可信）：整行退回无着色，只按命中区间切', () => {
        const tokens = [tok('const', 'pm-tok-keyword')]   // 拼回来 ≠ 'const a = 1'
        expect(mergePreviewSegments('const a = 1', tokens, null, null))
            .toEqual([{text: 'const a = 1', cls: '', hit: false}])
    })

    it('命中区间越界 / 退化（end ≤ start）时不产生命中片段', () => {
        expect(mergePreviewSegments('abc', null, 5, 9).every(s => !s.hit)).toBe(true)
        expect(mergePreviewSegments('abc', null, 2, 2).every(s => !s.hit)).toBe(true)
    })

    it('命中区间覆盖整行时只有一段命中', () => {
        expect(mergePreviewSegments('abc', null, 0, 3)).toEqual([{text: 'abc', cls: '', hit: true}])
    })
})

describe('响应落地与视图', () => {
    it('token 一致才接受，陈旧响应一律丢弃', () => {
        expect(acceptPreviewResponse(3, 3)).toBe(true)
        expect(acceptPreviewResponse(2, 3)).toBe(false)
    })

    it('取数失败：走 error 分支且保留元信息行（不空白）', () => {
        const view = previewViewFromSlice(
            slice({lines: [], error: '二进制文件，无法预览', size: 12}),
            item('bin/x'),
        )
        expect(view.status).toBe('error')
        expect(view.error).toBe('二进制文件，无法预览')
        expect(view.rows).toEqual([])
        expect(view.meta).toBe('bin/x · 12 B')
    })

    it('取数成功：ready + 行', () => {
        expect(previewViewFromSlice(slice(), item('a.ts')).status).toBe('ready')
    })
})

describe('EOF 短路复用（预览带回全文时不再全量读）', () => {
    beforeEach(() => { clearPreviewCache() })

    it('缓存里的全文条目可按 (工作区, 路径) 直接取出', () => {
        const full = slice({path: 'a.ts', fullContent: 'const a = 1\n', hash: 'h1', size: 12, mtime: 1})
        previewCache.set(previewCacheKey('/ws1', 'a.ts', 1, 20), full)
        expect(findCachedFullContent('/ws1', 'a.ts')).toBe(full)
    })

    it('不同工作区 / 无全文的条目不算命中', () => {
        previewCache.set(previewCacheKey('/ws1', 'a.ts', 1, 20), slice({path: 'a.ts'}))
        expect(findCachedFullContent('/ws1', 'a.ts')).toBe(null)   // 无 fullContent
        previewCache.set(previewCacheKey('/ws2', 'b.ts', 1, 20), slice({path: 'b.ts', fullContent: 'x', hash: 'h'}))
        expect(findCachedFullContent('/ws1', 'b.ts')).toBe(null)   // 别的仓库
    })

    it('清空后不再命中（浮层关闭 / 切工作区时调用）', () => {
        previewCache.set(previewCacheKey('/ws1', 'a.ts', 1, 20), slice({path: 'a.ts', fullContent: 'x', hash: 'h'}))
        clearPreviewCache()
        expect(previewCacheSize()).toBe(0)
        expect(findCachedFullContent('/ws1', 'a.ts')).toBe(null)
    })
})
