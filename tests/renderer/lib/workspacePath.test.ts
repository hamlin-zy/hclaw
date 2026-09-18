/**
 * workspacePathKey 单元测试
 *
 * 工作区路径归一化键：仅用于渲染侧比较 / 去重，绝不可回传给主进程
 * （workspaceRepository.getByPath 是 `WHERE path = ?` 精确串匹配）。
 *
 * 覆盖口径：分隔符统一、去尾分隔符、根保留、UNC 不塌缩、
 * 大小写折叠仅在 Windows（darwin 亦不折叠）、平台取不到时不折叠。
 */
import {describe, expect, it, afterEach, vi} from 'vitest'
import {workspacePathKey} from '@/renderer/lib/workspacePath'

/** 切换平台来源：window.electronAPI.platform（undefined → 模拟取不到，退回 navigator 口径） */
function stubPlatform(platform: string | undefined) {
    ;(globalThis as unknown as {window: unknown}).window =
        platform === undefined ? {} : {electronAPI: {platform}}
}

/** 切换 navigator.platform 兜底口径（node 下 navigator 是只读 getter，须经 stubGlobal） */
function stubNavigatorPlatform(platform: string) {
    vi.stubGlobal('navigator', {platform})
}

afterEach(() => {
    delete (globalThis as unknown as {window?: unknown}).window
    vi.unstubAllGlobals()
})

describe('workspacePathKey — 平台无关', () => {
    it('空串返回空串（currentWorkspacePath 可能为 null，调用方传 ""）', () => {
        expect(workspacePathKey('')).toBe('')
    })

    it('根路径保留："/" 不塌成空串', () => {
        expect(workspacePathKey('/')).toBe('/')
    })
})

describe('workspacePathKey — win32', () => {
    it('统一分隔符 + 去尾分隔符 + 大小写折叠：E:\\Foo\\ 与 e:/foo 等价', () => {
        const k = workspacePathKey('E:\\Foo\\')
        expect(k).toBe('e:/foo')
        expect(k).toBe(workspacePathKey('e:/foo'))
        expect(k).toBe(workspacePathKey('e:/foo/'))
        expect(k).toBe(workspacePathKey('E:\\Foo'))
        expect(k).toBe(workspacePathKey('E:/Foo/'))
    })

    it('去尾分隔符：/a/b/ 与 /a/b 等价', () => {
        expect(workspacePathKey('/a/b/')).toBe(workspacePathKey('/a/b'))
    })

    it('盘根保留：C:\\ → C:/（不能削成 "C:"）', () => {
        expect(workspacePathKey('C:\\')).toBe('c:/')
        expect(workspacePathKey('C:/')).toBe('c:/')
    })

    it('不折叠重复分隔符：UNC \\\\srv\\share → //srv/share', () => {
        expect(workspacePathKey('\\\\srv\\share')).toBe('//srv/share')
        expect(workspacePathKey('\\\\srv\\share')).not.toBe(workspacePathKey('/srv/share'))
    })
})

describe('workspacePathKey — POSIX', () => {
    it('大小写不折叠（/a/B 与 /a/b 是两个真实存在的不同目录）', () => {
        stubPlatform('linux')
        expect(workspacePathKey('/a/B')).not.toBe(workspacePathKey('/a/b'))
        expect(workspacePathKey('/a/B')).toBe('/a/B')
    })

    it('尾分隔符等价 + 根保留', () => {
        stubPlatform('linux')
        expect(workspacePathKey('/a/b/')).toBe('/a/b')
        expect(workspacePathKey('/a/b///')).toBe('/a/b')
        expect(workspacePathKey('/')).toBe('/')
    })

    it('反斜杠统一为 "/"（两平台都做）', () => {
        stubPlatform('linux')
        expect(workspacePathKey('\\a\\b')).toBe('/a/b')
    })

    it('darwin 也不折叠（macOS 默认不敏感但存在大小写敏感卷，误合并会显示错工作区）', () => {
        stubPlatform('darwin')
        expect(workspacePathKey('/Users/Foo/Bar')).toBe('/Users/Foo/Bar')
        expect(workspacePathKey('/Users/Foo/Bar')).not.toBe(workspacePathKey('/users/foo/bar'))
    })
})

describe('workspacePathKey — 平台来源', () => {
    it('window.electronAPI 取不到平台时不折叠（POSIX 语义，失败方向更安全）', () => {
        stubPlatform(undefined)
        stubNavigatorPlatform('')
        expect(workspacePathKey('E:\\Foo\\')).toBe('E:/Foo')
        expect(workspacePathKey('E:\\Foo\\')).not.toBe(workspacePathKey('e:/foo'))
    })

    it('回退 navigator.platform 判定 Windows', () => {
        stubPlatform(undefined)
        stubNavigatorPlatform('Win32')
        expect(workspacePathKey('E:\\Foo\\')).toBe('e:/foo')
    })

    it('回退 navigator.platform 判定 Windows：非 Win 取值不折叠', () => {
        stubPlatform(undefined)
        stubNavigatorPlatform('Linux x86_64')
        expect(workspacePathKey('E:\\Foo\\')).toBe('E:/Foo')
    })
})
