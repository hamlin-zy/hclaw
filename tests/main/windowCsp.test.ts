import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * 独立窗口 HTML CSP 静态契约。
 *
 * 根因：settings-config 独立窗口（dialogWindow.html）中本地背景图不渲染——
 * 背景图路径为 hclaw-media://local/...（自定义协议）或 file://，
 * 但 dialogWindow.html 的 CSP img-src 仅 'self' data: blob:，未放行
 * file: 与 hclaw-media:，CSS backgroundImage: url(...) 引用被 CSP 拦截，
 * 当前背景预览与历史缩略图全部空白。
 * 修复：所有窗口 HTML 的 img-src / media-src 统一放行 file: 与 hclaw-media:
 *（与主窗口 index.html 对齐）。
 */

const RENDERER_DIR = path.resolve(process.cwd(), 'src/renderer')

/** 读取 HTML 并提取 Content-Security-Policy meta 的 content 值 */
function readCsp(file: string): string {
    const src = fs.readFileSync(path.join(RENDERER_DIR, file), 'utf-8')
    const m = src.match(/Content-Security-Policy"\s*content="([^"]+)"/)
    expect(m, `${file} 应包含 Content-Security-Policy meta`).not.toBeNull()
    return m![1]
}

/** 从 CSP content 中提取指定指令的取值（如 img-src → "self data: blob:"） */
function getDirective(csp: string, name: string): string | null {
    // 指令间以 ';' 分隔且通常跟一个空格，需容忍分隔符后的空白（(?:^|;)\s*）
    const m = csp.match(new RegExp(`(?:^|;)\\s*${name}\\s+([^;]*)`))
    return m ? m[1] : null
}

/** 全部窗口 HTML 入口（主窗口 + 独立窗口），glob 等价：扫描 src/renderer/*.html */
const WINDOW_HTMLS = fs.readdirSync(RENDERER_DIR).filter(f => f.endsWith('.html'))

describe('窗口 HTML — CSP 本地资源放行', () => {
    it('应至少包含主窗口与独立窗口入口 html（dialogWindow / usage / llm-logs）', () => {
        expect(WINDOW_HTMLS).toContain('index.html')
        expect(WINDOW_HTMLS).toContain('dialogWindow.html')
        expect(WINDOW_HTMLS).toContain('usage.html')
        expect(WINDOW_HTMLS).toContain('llm-logs.html')
    })

    it.each(WINDOW_HTMLS)('%s 的 img-src 含 file: 与 hclaw-media:', (file) => {
        const imgSrc = getDirective(readCsp(file), 'img-src')
        expect(imgSrc, `${file} 应声明 img-src`).not.toBeNull()
        expect(imgSrc).toContain('file:')
        expect(imgSrc).toContain('hclaw-media:')
    })

    it.each(WINDOW_HTMLS)('%s 的 media-src 含 file: 与 hclaw-media:', (file) => {
        const mediaSrc = getDirective(readCsp(file), 'media-src')
        expect(mediaSrc, `${file} 应声明 media-src`).not.toBeNull()
        expect(mediaSrc).toContain('file:')
        expect(mediaSrc).toContain('hclaw-media:')
    })
})
