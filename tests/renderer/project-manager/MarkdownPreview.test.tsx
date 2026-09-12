// @vitest-environment jsdom
import {describe, it, expect, vi, afterEach} from 'vitest'
import {render, cleanup, fireEvent, screen, act} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {MarkdownPreview} from '../../../src/renderer/project-manager/components/MarkdownPreview'
import {resolveMarkdownImageSrc, toAbsoluteFilePath} from '../../../src/renderer/project-manager/utils/mdImageSrc'

/** 装一份最小 electronAPI：只需 openBuiltin / openSystem 两个链接打开通道 */
function installElectronAPI(overrides: Record<string, unknown> = {}) {
  const openBuiltin = vi.fn(async () => ({success: true}))
  const openSystem = vi.fn(async () => ({success: true}))
  ;(window as any).electronAPI = {...overrides, openBuiltin, openSystem}
  return {openBuiltin, openSystem}
}

/** 点击 md 预览里的链接，返回该 click 事件（用于断言 preventDefault 是否生效） */
function clickLink(container: HTMLElement): MouseEvent {
  const link = container.querySelector('a.pm-md-link')
  expect(link, '预览里应渲染出 a.pm-md-link').not.toBeNull()
  const ev = new MouseEvent('click', {bubbles: true, cancelable: true})
  act(() => {
    link!.dispatchEvent(ev)
  })
  return ev
}

afterEach(() => {
  cleanup()
  document.documentElement.className = ''
  delete (window as any).electronAPI
})

describe('MarkdownPreview（只读 md 预览）', () => {
  it('GFM 表格渲染为 <table>', () => {
    const md = ['| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    const {container} = render(<MarkdownPreview content={md} />)
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelectorAll('th')).toHaveLength(2)
    expect(container.querySelectorAll('td')).toHaveLength(2)
  })

  it('标题与行内代码各自落到对应元素/类', () => {
    const {container} = render(<MarkdownPreview content={'# 标题\n\n`code`'} />)
    expect(container.querySelector('h1')?.textContent).toBe('标题')
    expect(container.querySelector('.pm-md-inline-code')?.textContent).toBe('code')
  })

  it('不启用 rehype-raw：原始 HTML 不会变成可执行/DOM 元素', () => {
    const {container} = render(<MarkdownPreview content={'<script>window.__pwned = 1</script>\n\n<img src=x onerror="window.__pwned=1">'} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })

  it('深色主题类存在时（dark/yuanshandai）不崩溃，仍正常渲染', () => {
    document.documentElement.classList.add('dark')
    const {container} = render(<MarkdownPreview content={'# Hi'} />)
    expect(container.querySelector('h1')?.textContent).toBe('Hi')
  })
})

describe('MarkdownPreview 链接点击行为', () => {
  it('链接仍保留 href 与 .pm-md-link 可点击视觉（不降级为 span）', () => {
    const {container} = render(<MarkdownPreview content={'[示例](https://example.com/a)'} />)
    const link = container.querySelector('a.pm-md-link')
    expect(link).not.toBeNull()
    expect(link).toHaveAttribute('href', 'https://example.com/a')
    // 不再走 Electron 默认窗口路径
    expect(link).not.toHaveAttribute('target', '_blank')
  })

  it('点击链接不触发默认跳转，并弹出「内置/系统浏览器」菜单', () => {
    installElectronAPI()
    const {container} = render(<MarkdownPreview content={'[示例](https://example.com/a)'} />)

    const ev = clickLink(container)

    expect(ev.defaultPrevented, '必须 e.preventDefault()，否则会走 Electron 默认窗口打开').toBe(true)
    expect(screen.getByText('内置浏览器打开')).toBeInTheDocument()
    expect(screen.getByText('系统浏览器打开')).toBeInTheDocument()
  })

  it('点击「内置浏览器打开」调用 openBuiltin(url) 并关闭菜单', () => {
    const {openBuiltin, openSystem} = installElectronAPI()
    const {container} = render(<MarkdownPreview content={'[示例](https://example.com/a)'} />)

    clickLink(container)
    fireEvent.click(screen.getByText('内置浏览器打开'))

    expect(openBuiltin).toHaveBeenCalledTimes(1)
    expect(openBuiltin).toHaveBeenCalledWith('https://example.com/a')
    expect(openSystem).not.toHaveBeenCalled()
    expect(screen.queryByText('内置浏览器打开')).toBeNull()
    expect(screen.queryByText('系统浏览器打开')).toBeNull()
  })

  it('点击「系统浏览器打开」调用 openSystem(url) 并关闭菜单', () => {
    const {openBuiltin, openSystem} = installElectronAPI()
    const {container} = render(<MarkdownPreview content={'[示例](https://example.com/b)'} />)

    clickLink(container)
    fireEvent.click(screen.getByText('系统浏览器打开'))

    expect(openSystem).toHaveBeenCalledTimes(1)
    expect(openSystem).toHaveBeenCalledWith('https://example.com/b')
    expect(openBuiltin).not.toHaveBeenCalled()
    expect(screen.queryByText('系统浏览器打开')).toBeNull()
  })

  it('electronAPI 缺失时不崩溃（菜单仍可弹出，打开动作静默失败）', () => {
    delete (window as any).electronAPI
    const {container} = render(<MarkdownPreview content={'[示例](https://example.com/a)'} />)

    clickLink(container)
    expect(screen.getByText('内置浏览器打开')).toBeInTheDocument()
    expect(() => fireEvent.click(screen.getByText('内置浏览器打开'))).not.toThrow()
    expect(screen.queryByText('内置浏览器打开')).toBeNull()
  })
})

describe('resolveMarkdownImageSrc（相对路径 → hclaw-media://）', () => {
  const BASE = 'E:\\ws\\docs\\README.md'

  it('相对路径按 md 文件所在目录解析', () => {
    expect(resolveMarkdownImageSrc('images/a.png', BASE)).toBe('hclaw-media:///E:/ws/docs/images/a.png')
  })

  it('.. 逐级回退目录', () => {
    expect(resolveMarkdownImageSrc('../a.png', BASE)).toBe('hclaw-media:///E:/ws/a.png')
  })

  it('.. 越过根时钳制，不回退到盘符之外', () => {
    const out = resolveMarkdownImageSrc('../../../../a.png', BASE)
    expect(out).toBe('hclaw-media:///E:/a.png')
    expect(out).not.toContain('..')
  })

  it('无 basePath 时保持现状（相对路径原样返回）', () => {
    expect(resolveMarkdownImageSrc('images/a.png')).toBe('images/a.png')
  })

  it('远程 URL 原样返回', () => {
    expect(resolveMarkdownImageSrc('https://img.shields.io/x.svg')).toBe('https://img.shields.io/x.svg')
  })

  it('data: URI 原样返回', () => {
    expect(resolveMarkdownImageSrc('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA')
  })

  it('POSIX 绝对路径转 hclaw-media://', () => {
    expect(resolveMarkdownImageSrc('/home/u/a.png')).toBe('hclaw-media:///home/u/a.png')
  })

  it('本地相对路径的 query 被丢弃', () => {
    expect(resolveMarkdownImageSrc('sub/a.png?raw=1', BASE)).toBe('hclaw-media:///E:/ws/docs/sub/a.png')
  })

  it('空值返回空串', () => {
    expect(resolveMarkdownImageSrc('', BASE)).toBe('')
  })

  // 回归：`//host/path` 曾被 toMediaUrl 的 startsWith('/') 分支当成 POSIX 绝对路径，
  // 拼成 `hclaw-media:////cdn...` 而彻底失效。协议相对 URL 必须原样交给浏览器。
  it('协议相对 URL（//host/path）原样返回，不被转成 hclaw-media://', () => {
    expect(resolveMarkdownImageSrc('//cdn.example.com/a.png', BASE)).toBe('//cdn.example.com/a.png')
  })

  it('file:// 转 hclaw-media://（复用 toMediaUrl 既有行为）', () => {
    expect(resolveMarkdownImageSrc('file:///E:/ws/a.png', BASE)).toBe('hclaw-media:///E:/ws/a.png')
  })

  it('UNC 路径不崩溃（\\server\\share\\a.png）', () => {
    expect(() => resolveMarkdownImageSrc('\\\\server\\share\\a.png', BASE)).not.toThrow()
  })
})

describe('toAbsoluteFilePath（相对 filePath → 绝对路径）', () => {
  it('工作区相对路径拼上工作区根', () => {
    expect(toAbsoluteFilePath('docs/README.md', 'E:\\ws')).toBe('E:\\ws/docs/README.md')
  })

  it('工作区根带尾分隔符不产生双斜杠', () => {
    expect(toAbsoluteFilePath('README.md', 'E:\\ws\\')).toBe('E:\\ws/README.md')
  })

  it('已是绝对路径（Windows / POSIX）原样返回', () => {
    expect(toAbsoluteFilePath('E:/ws/a.md', 'E:/other')).toBe('E:/ws/a.md')
    expect(toAbsoluteFilePath('/ws/a.md', '/other')).toBe('/ws/a.md')
  })

  it('空 filePath 或无工作区根 → 空串（调用方据此退化为不传 basePath）', () => {
    expect(toAbsoluteFilePath('', 'E:/ws')).toBe('')
    expect(toAbsoluteFilePath('README.md', '')).toBe('')
  })

  it('拼出的绝对路径能正确解析相对图片（端到端串起来）', () => {
    const base = toAbsoluteFilePath('docs/README.md', 'E:\\ws')
    expect(resolveMarkdownImageSrc('images/a.png', base)).toBe('hclaw-media:///E:/ws/docs/images/a.png')
  })
})

describe('MarkdownPreview 图片解析', () => {
  it('相对路径图片基于 basePath 解析为 hclaw-media://', () => {
    const {container} = render(
      <MarkdownPreview content={'![x](images/a.png)'} basePath={'E:\\ws\\docs\\README.md'} />,
    )
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img).toHaveAttribute('src', 'hclaw-media:///E:/ws/docs/images/a.png')
    expect(img).toHaveAttribute('alt', 'x')
  })

  it('https 图片不被改写', () => {
    const {container} = render(
      <MarkdownPreview content={'![x](https://img.shields.io/x.svg)'} basePath={'E:\\ws\\docs\\README.md'} />,
    )
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://img.shields.io/x.svg')
  })
})
