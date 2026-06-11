/**
 * Markdown 渲染器组件
 * 封装 ReactMarkdown 的配置和渲染逻辑
 */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import {Prism as SyntaxHighlighter} from 'react-syntax-highlighter'
import {oneDark, oneLight} from 'react-syntax-highlighter/dist/esm/styles/prism'
import {Component, memo, useEffect, useMemo, useState} from 'react'
import {createPortal} from 'react-dom'
import rehypeRaw from 'rehype-raw'
import MediaPlayer, {extractFileName} from './MediaPlayer'
import {inferMediaTypeFromUrl} from '@shared/types'
import ImagePreviewModal from '../common/ImagePreviewModal'
import {useSettingsStore} from '../../stores/settingsStore'
import LinkContextMenu from '../common/LinkContextMenu'
// toMediaUrl 逻辑复刻（避免在渲染进程引入模块依赖）
// 将本地文件路径转换为 hclaw-media:// URL
// URL 格式: hclaw-media://local/E:/path/to/file.mp3
// 使用 dummy hostname "local" 避免 Windows 盘符 E: 被 Chromium 误解析为 hostname
function localPathToMediaUrl(src: string): string {
    if (!src) return ''
    // 百分号解码（micromark 的 sanitizeUri 会将反斜杠编码为 %5C）
    let normalized = src
    if (src.includes('%')) {
        try { normalized = decodeURIComponent(src) } catch { /* 保持原始 */ }
    }
    // 反斜杠统一为正斜杠
    normalized = normalized.replace(/\\/g, '/')
    // file:// → 递归处理
    if (normalized.startsWith('file://')) {
        return localPathToMediaUrl(normalized.slice(7))
    }
    // 已是网络协议 URL，直接返回
    if (/^[a-zA-Z][a-zA-Z0-9+\-]*:\/\//.test(normalized)) {
        return normalized
    }
    // Windows 绝对路径: C:/path/to/file → hclaw-media://local/C:/path/to/file
    if (/^[a-zA-Z]:\//.test(normalized)) {
        return 'hclaw-media://local/' + normalized
    }
    // Unix 绝对路径: /home/user/file → hclaw-media://local/home/user/file
    if (normalized.startsWith('/')) {
        return 'hclaw-media://local' + normalized
    }
    // 相对路径（回退）
    return src
}

// 缓存 remark 插件数组，避免每次渲染创建新数组
const remarkPlugins = [remarkGfm, remarkBreaks]
const rehypePlugins = [rehypeRaw]

// ★ 稳定的 urlTransform 函数引用，避免 useMemo 每次创建新闭包
const stableUrlTransform = (url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://') ||
        url.startsWith('file://') || url.startsWith('hclaw-media://') ||
        url.startsWith('data:') || url.startsWith('blob:')) {
        return url
    }
    if (url.startsWith('//') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) {
        return url
    }
    // Windows 绝对路径如 C:/path
    if (/^[a-zA-Z]:[/\\]/.test(url)) {
        return url
    }
    return url
}

// ─── 代码块复制按钮 ─────────────────────────────────────

const CopyButton = memo(function CopyButton({code}: { code: string }) {
    const [copied, setCopied] = useState(false)

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch {
            // 复制失败，静默处理
        }
    }

    return (
        <button
            onClick={handleCopy}
            className="absolute top-2 right-2 px-2 py-1 text-xs rounded transition-colors
                bg-[var(--surface-muted)] hover:bg-[var(--surface-elevated)]
                text-[var(--text-muted)] hover:text-[var(--text-primary)]
                border border-[var(--border)]"
            title="复制代码"
        >
            {copied ? '已复制' : '复制'}
        </button>
    )
})

// ─── 本地图片路径检测 & 转换 ─────────────────────────────

/**
 * 判断 src 是否为本地文件路径（需要 IPC 转换才能加载）
 */
function isLocalFilePath(src: string): boolean {
    if (!src) return false
    // 浏览器可直接加载的网络协议
    if (src.startsWith('http://') || src.startsWith('https://')) return false
    if (src.startsWith('data:') || src.startsWith('blob:')) return false
    // 自定义媒体协议（主进程已注册特权协议，可直接访问）
    if (src.startsWith('hclaw-media://')) return false
    // 相对路径（让浏览器自己处理）
    if (src.startsWith('./') || src.startsWith('../')) return false
    // file:// 协议（跨平台用 hclaw-media://）
    if (src.startsWith('file://')) return false
    // Windows 绝对路径 → 需要转换为 hclaw-media://
    if (/^[a-zA-Z]:[\\/]/.test(src)) return true
    // Unix 绝对路径 / 网络共享路径 → 需要转换
    if (src.startsWith('/') || src.startsWith('\\\\')) return true
    return false
}

/** 调试用：打印 img props */
function img({node, src, alt, ...props}: any) {
    console.debug('[MarkdownRenderer] img props:', {src, alt, node_url: node?.url})
    return renderImg({src, alt, ...props})
}

function renderImg({src, alt, ...props}: any) {
    // 检测媒体类型：音频/视频走 MediaPlayer，图片走 LocalImage
    const mediaType = src ? inferMediaTypeFromUrl(src) : null
    if (mediaType && mediaType !== 'image') {
        return (
            <MediaPlayer
                media={{
                    type: mediaType,
                    url: localPathToMediaUrl(src),
                    caption: alt || undefined,
                    fileName: extractFileName(src)
                }}
            />
        )
    }
    return <LocalImage src={src} alt={alt || ''} />
}

/**
 * 将 file:// URL 转为本地文件路径
 */
function resolveFilePath(src: string): string {
    if (src.startsWith('file://')) {
        let path = src.slice('file://'.length)
        // Windows: file:///C:/... → /C:/... → 去掉前导 /
        if (/^\/[a-zA-Z]:[/\\]/.test(path)) {
            path = path.slice(1)
        }
        try {
            return decodeURIComponent(path)
        } catch {
            return path
        }
    }
    return src
}

/**
 * 智能图片组件：本地路径通过 hclaw-media:// 协议（主进程已注册）或 IPC → data: URL
 */
function LocalImage({src, alt}: {src: string; alt: string}) {
    const [resolvedSrc, setResolvedSrc] = useState<string>('')
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)
    const [showPreview, setShowPreview] = useState(false)

    useEffect(() => {
        setLoading(true)
        setError(false)
        setResolvedSrc('')

        if (!src) { setError(true); setLoading(false); return }

        // 非本地图片（网络 URL 或 hclaw-media:// 等协议 URL）直接使用
        if (!isLocalFilePath(src)) {
            setResolvedSrc(src)
            setLoading(false)
            return
        }

        // 方式 1: 通过 hclaw-media:// 协议（主进程自定义协议，渲染进程可直接访问）
        // 支持百分号编码路径（C:\... → C%3A%5C...）和反斜杠路径
        // localPathToMediaUrl 处理: Windows 绝对路径 → hclaw-media:///C:/path, Unix 绝对路径 → hclaw-media:///path
        let mediaUrl = localPathToMediaUrl(src)
        setResolvedSrc(mediaUrl)
        setLoading(false)

        // 方式 2（备用）: IPC readFileAsDataUrl → data: URL
        // 仅在 hclaw-media 不工作时使用
        // const filePath = resolveFilePath(src)
        // window.electronAPI?.readFileAsDataUrl?.(filePath).then((dataUrl) => {
        //     if (dataUrl) { setResolvedSrc(dataUrl); setLoading(false) }
        //     else { setError(true); setLoading(false) }
        // }).catch(() => { setError(true); setLoading(false) })
    }, [src])

    // 加载中占位（用 span 而非 div/figure，避免 validateDOMNesting: <div>/<figure> cannot appear as a descendant of <p>）
    if (loading) {
        return (
            <span
                className="my-2 flex items-center gap-2 p-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)]/20">
                <span
                    className="w-4 h-4 border-2 border-[var(--brand-primary)]/30 border-t-[var(--brand-primary)] rounded-full animate-spin inline-block"/>
                <span className="text-xs text-[var(--text-muted)]">加载图片中…</span>
            </span>
        )
    }

    // 加载失败占位
    if (error) {
        return (
            <span
                className="my-2 p-3 rounded-lg border border-[var(--border-muted)] bg-[var(--surface-muted)]/20 text-center inline-block">
                <span className="text-xs text-[var(--text-muted)]">
                    无法加载图片: {alt || src}
                </span>
            </span>
        )
    }

    return (
        <>
            <span className="my-2 inline-block">
                <img
                    src={resolvedSrc}
                    alt={alt || ''}
                    className="max-w-full h-auto rounded-lg cursor-pointer hover:opacity-80 transition-opacity"
                    loading="lazy"
                    onClick={() => setShowPreview(true)}
                />
            </span>
            {showPreview && (
                <ImagePreviewModal
                    src={resolvedSrc}
                    alt={alt || ''}
                    onClose={() => setShowPreview(false)}
                />
            )}
        </>
    )
}

/**
 * Markdown 渲染器的 props
 */
interface MarkdownRendererProps {
    children: string
    isUser?: boolean
    theme?: 'light' | 'dark' | 'yuanshandai' | 'shiyangjin'
}

/**
 * 预处理 markdown：将 URL 中的反斜杠转为正斜杠
 * micromark 把 \ 当作转义符，Windows 路径 C:\foo\bar.png 会被吃成 C:foobar.png
 * 在渲染前统一处理，不影响其他 markdown 语法（反斜杠转义仅对 ASCII 标点生效，不对字母生效，但稳妥起见只替换 URL 内的）
 */
/**
 * 剥离 HTML 标签中的 ref 属性，防止 rehypeRaw 将其作为 React ref 传递
 * React 19 拒绝字符串 ref，会抛出 markRef 错误
 */
function stripRefAttributes(markdown: string): string {
    if (typeof markdown !== 'string') return ''
    // 两阶段剥离 ref 属性，防止 rehype-raw 将其作为 React ref 传递导致 markRef 错误（React 19 拒绝字符串 ref）：
    // 第一阶段：定位所有 HTML 标签（<...>）
    // 第二阶段：仅在标签内部剥离 ref 属性，避免误伤标签内文本（如 <code>const ref = ...</code>）
    // 支持所有合法 HTML ref 属性写法：ref="..." | ref='...' | ref=value | ref = "..." | ref（布尔属性）
    return markdown.replace(/<[^>]+>/g, (tag) =>
        tag.replace(/\s+ref(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\`]+))?/gi, '')
    )
}

function normalizeMarkdownPaths(markdown: string): string {
    if (typeof markdown !== 'string') return ''
    return markdown.replace(/(\]\(|\[)([^)\]]+)(\)|\]\[)/g, (match, prefix, url, suffix) => {
        return prefix + url.replace(/\\/g, '/') + suffix
    })
}

/**
 * 转义非 HTML 标签的尖括号，防止 rehypeRaw 将 TypeScript 泛型（如 Promise<string>）当成 HTML 标签
 * 仅保留已知的合法 HTML 标签，其他 <...> 模式转义为 &lt;...&gt;
 */
function escapeNonHtmlTags(markdown: string): string {
    if (typeof markdown !== 'string') return ''
    const KNOWN_HTML_TAGS = new Set([
        'a','abbr','address','area','article','aside','audio','b','base','bdi','bdo','blockquote',
        'body','br','button','canvas','caption','cite','code','col','colgroup','data','datalist',
        'dd','del','details','dfn','dialog','div','dl','dt','em','embed','fieldset','figcaption',
        'figure','footer','form','h1','h2','h3','h4','h5','h6','head','header','hgroup','hr',
        'html','i','iframe','img','input','ins','kbd','label','legend','li','link','main','map',
        'mark','menu','meta','meter','nav','noscript','object','ol','optgroup','option','output',
        'p','picture','pre','progress','q','rp','rt','ruby','s','samp','script','section','search',
        'select','slot','small','source','span','strong','style','sub','summary','sup','table',
        'tbody','td','template','textarea','tfoot','th','thead','time','title','tr','track','u',
        'ul','var','video','wbr'
    ])
    // 匹配 <tagName ...> 或 </tagName> 模式
    return markdown.replace(/<\/?([A-Za-z][A-Za-z0-9]*)\b[^>]*?>/g, (match, tagName) => {
        if (KNOWN_HTML_TAGS.has(tagName.toLowerCase())) {
            return match  // 保留合法 HTML 标签
        }
        // 用零宽空格打断 HTML 标签语法，防止 rehypeRaw 将其解析为 HTML
        // 不直接使用 &lt; 实体，因为 React 渲染文本时不会解码实体
        return match.replace(/</g, '<\u200B').replace(/>/g, '\u200B>')
    })
}

/**
 * Markdown 渲染错误边界
 * 当 rehypeRaw 遇到无法识别的 HTML 标签导致渲染崩溃时，
 * 自动降级为纯文本显示
 */
class MarkdownErrorBoundary extends Component<
    { children: React.ReactNode; fallback: string },
    { hasError: boolean }
> {
    state = { hasError: false }

    static getDerivedStateFromError() {
        return { hasError: true }
    }

    componentDidUpdate(prevProps: { fallback: string }) {
        // 内容变化时重置错误状态，重新尝试渲染
        if (prevProps.fallback !== this.props.fallback && this.state.hasError) {
            this.setState({ hasError: false })
        }
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="whitespace-pre-wrap break-words font-mono text-sm text-[var(--text-primary)] p-3 rounded-lg bg-[var(--surface-muted)]/30 border border-[var(--border-muted)]">
                    {this.props.fallback}
                </div>
            )
        }
        return this.props.children
    }
}

/**
 * Markdown 渲染器组件
 */
const MarkdownRenderer = memo(function MarkdownRenderer({
                                                            children,
                                                            isUser = false,
                                                            theme = 'dark'
                                                        }: MarkdownRendererProps) {
    const normalizedChildren = useMemo(() => {
        const normalized = normalizeMarkdownPaths(children)
        const escaped = escapeNonHtmlTags(normalized)
        return stripRefAttributes(escaped)
    }, [children])

    // ── 链接打开方式 ──
    const {settings} = useSettingsStore()
    const linkMode = settings.linkOpening?.mode ?? 'ask'
    const [linkMenu, setLinkMenu] = useState<{visible: boolean; x: number; y: number; url: string}>({
        visible: false, x: 0, y: 0, url: ''
    })

    const components = useMemo(() => {
        const base = mdComponents(isUser, theme, linkMode)
        return {
            ...base,
            // 覆盖 a 组件以支持链接打开方式选择
            a({children, href, ref: _ref, ...props}: any) {
                const handleClick = (e: React.MouseEvent) => {
                    e.preventDefault()
                    if (!href) return

                    if (linkMode === 'builtin') {
                        window.electronAPI?.openBuiltin?.(href)
                    } else if (linkMode === 'system') {
                        window.electronAPI?.openSystem?.(href)
                    } else {
                        // ask: 弹 Context Menu
                        const logX = e.clientX
                        const logY = e.clientY
                        console.log('[LinkClick]', {clientX: e.clientX, clientY: e.clientY, innerWidth: logX + 10, innerHeight: logY, href})
                        setLinkMenu({visible: true, x: e.clientX, y: e.clientY, url: href})
                    }
                }
                return (
                    <a
                        href={href}
                        onClick={handleClick}
                        className="text-[var(--brand-primary)] hover:underline cursor-pointer"
                        {...props}
                    >
                        {children}
                    </a>
                )
            },
        }
    }, [isUser, theme, linkMode])

    return (
        <MarkdownErrorBoundary fallback={normalizedChildren}>
            <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}
                           urlTransform={stableUrlTransform}>
                {normalizedChildren}
            </ReactMarkdown>
            {createPortal(
                <LinkContextMenu
                    visible={linkMenu.visible}
                    x={linkMenu.x}
                    y={linkMenu.y}
                    url={linkMenu.url}
                    onClose={() => setLinkMenu(prev => ({...prev, visible: false}))}
                />,
                document.body
            )}
        </MarkdownErrorBoundary>
    )
})

export default MarkdownRenderer

/**
 * 生成 Markdown 组件配置
 */
export function mdComponents(isUser: boolean, theme: 'light' | 'dark' | 'yuanshandai' | 'shiyangjin', linkMode?: 'builtin' | 'system' | 'ask') {
    const darkThemes = ['dark', 'yuanshandai']
    const codeStyle = darkThemes.includes(theme) ? oneDark : oneLight

    return {
        // 普通 pre（非代码块中的 pre，react-markdown 会为无语言标注的代码块生成 <pre><code>）
        pre({children}: any) {
            return (
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-muted)]/50 p-3 my-2 text-sm font-mono leading-relaxed border border-[var(--border-muted)]">
                    {children}
                </pre>
            )
        },
        // 代码块
        code({node, inline, className, children, ref: _ref, ...props}: any) {
            const match = /language-(\w+)/.exec(className || '')
            // react-markdown v9 的 children 可能是数组，需要处理
            const codeString = Array.isArray(children) ? children.join('') : String(children ?? '')
            const trimmedCode = codeString.replace(/\n$/, '')
            return !inline && match ? (
                <div className="relative group overflow-x-auto">
                    <CopyButton code={trimmedCode} />
                    <SyntaxHighlighter
                        style={codeStyle}
                        language={match[1]}
                        PreTag="div"
                        className="rounded-lg"
                        {...props}
                    >
                        {trimmedCode}
                    </SyntaxHighlighter>
                </div>
            ) : (
                <code
                    className={`px-1.5 py-0.5 rounded text-sm font-mono ${
                        isUser
                            ? 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                            : 'bg-[var(--surface-muted)] text-[var(--text-primary)]'
                    }`}
                    {...props}
                >
                    {children}
                </code>
            )
        },
        // 行内代码
        inlineCode({children}: any) {
            const codeString = Array.isArray(children) ? children.join('') : String(children ?? '')
            return (
                <code
                    className={`px-1.5 py-0.5 rounded text-sm font-mono ${
                        isUser
                            ? 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                            : 'bg-[var(--surface-muted)] text-[var(--text-primary)]'
                    }`}
                >
                    {codeString}
                </code>
            )
        },
        // 链接 - 根据 linkOpening.mode 设置打开方式（组件内部使用时被 override，见 MarkdownRenderer 组件）
        a({children, href, ref: _ref, ...props}: any) {
            const handleClick = (e: React.MouseEvent) => {
                e.preventDefault()
                if (!href) return
                if (linkMode === 'system') {
                    window.electronAPI?.openSystem?.(href)
                } else {
                    // 默认使用内置浏览器（builtin 或未指定模式）
                    window.electronAPI?.openBuiltin?.(href)
                }
            }
            return (
                <a
                    href={href}
                    onClick={handleClick}
                    className="text-[var(--brand-primary)] hover:underline cursor-pointer"
                    {...props}
                >
                    {children}
                </a>
            )
        },
        // 段落
        p({children}: any) {
            return <p className="my-2 leading-relaxed">{children}</p>
        },
        // 标题
        h1({children}: any) {
            return <h1 className="text-2xl font-bold text-[var(--text-primary)] mt-4 mb-2">{children}</h1>
        },
        h2({children}: any) {
            return <h2 className="text-xl font-semibold text-[var(--text-primary)] mt-4 mb-2">{children}</h2>
        },
        h3({children}: any) {
            return <h3 className="text-lg font-semibold text-[var(--text-primary)] mt-3 mb-2">{children}</h3>
        },
        h4({children}: any) {
            return <h4 className="text-base font-medium text-[var(--text-primary)] mt-2 mb-1">{children}</h4>
        },
        h5({children}: any) {
            return <h5 className="text-sm font-medium text-[var(--text-secondary)] mt-2 mb-1">{children}</h5>
        },
        h6({children}: any) {
            return <h6 className="text-xs font-medium text-[var(--text-muted)] mt-2 mb-1">{children}</h6>
        },
        // 水平线
        hr({}: any) {
            return <hr className="my-4 border-t border-[var(--border)]" />
        },
        // 图片/音频/视频 — 根据扩展名自动选择渲染方式
        img({src, alt, ...props}: any) {
            console.debug('[MarkdownRenderer] img called with:', JSON.stringify({src, alt}))
            return renderImg({src, alt, ...props})
        },
        // 删除线
        del({children}: any) {
            return <del className="text-[var(--text-muted)] line-through">{children}</del>
        },
        // 列表
        ul({children}: any) {
            return <ul className="my-2 ml-4 list-disc space-y-1">{children}</ul>
        },
        ol({children}: any) {
            return <ol className="my-2 ml-4 list-decimal space-y-1">{children}</ol>
        },
        // 列表项
        li({children, checked, ref: _ref, ...props}: any) {
            // 任务列表项 (GFM extension)
            if (checked !== null && checked !== undefined) {
                return (
                    <li className="flex items-start gap-2 py-1" {...props}>
                        <input
                            type="checkbox"
                            checked={checked}
                            disabled
                            className="mt-1 h-4 w-4 rounded border-[var(--border)] text-[var(--brand-primary)] accent-[var(--brand-primary)]"
                        />
                        <span className={checked ? 'line-through text-[var(--text-muted)]' : ''}>
                            {children}
                        </span>
                    </li>
                )
            }
            return (
                <li className="py-1 break-words" {...props}>
                    {children}
                </li>
            )
        },
        // 引用
        blockquote({children}: any) {
            return (
                <blockquote
                    className="border-l-4 border-[var(--border-muted)] pl-4 py-1 my-2 bg-[var(--surface-muted)]/50 italic text-[var(--text-secondary)]">
                    {children}
                </blockquote>
            )
        },
        // 表格
        table({children}: any) {
            return (
                <div className="my-3 overflow-x-auto rounded-lg border border-[var(--border)]">
                    <table className="min-w-full divide-y divide-[var(--border)]">{children}</table>
                </div>
            )
        },
        thead({children}: any) {
            return <thead className="bg-[var(--surface-muted)]">{children}</thead>
        },
        tbody({children}: any) {
            return <tbody className="divide-y divide-[var(--border)]">{children}</tbody>
        },
        tr({children}: any) {
            return <tr className="even:bg-[var(--surface-muted)]/30">{children}</tr>
        },
        th({children}: any) {
            return (
                <th className="px-3 py-2 text-left text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
                    {children}
                </th>
            )
        },
        td({children}: any) {
            return (
                <td className="px-3 py-2 text-sm text-[var(--text-primary)]">{children}</td>
            )
        },
    } as any
}
