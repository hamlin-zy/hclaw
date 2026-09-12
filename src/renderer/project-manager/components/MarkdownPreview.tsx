import {useEffect, useState} from 'react'
import {createPortal} from 'react-dom'
import ReactMarkdown from 'react-markdown'
import type {Components} from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {Prism as SyntaxHighlighter} from 'react-syntax-highlighter'
import {oneDark, oneLight} from 'react-syntax-highlighter/dist/esm/styles/prism'
import LinkContextMenu from '../../components/common/LinkContextMenu'
import {resolveMarkdownImageSrc} from '../utils/mdImageSrc'

/**
 * 只读 Markdown 预览（项目管理窗口专用）。
 *
 * 与聊天窗口的 `components/message-list/MarkdownRenderer.tsx` **渲染主干刻意不复用**：后者耦合
 * MediaPlayer / ImagePreviewModal / useSettingsStore 等聊天基础设施，把一个只读文件查看器
 * 拖进整条聊天依赖链不划算。这里只依赖 react-markdown + remark-gfm + react-syntax-highlighter，
 * 外加一个**无 store 依赖**的纯展示组件 `LinkContextMenu`（其内部只用 window.electronAPI）。
 *
 * 图片：本地图统一走 `hclaw-media://`（主进程已注册特权协议，CSP 已放行 `https:` / `file:` /
 * `hclaw-media:`），因此相对路径要先用 `basePath`（当前 md 文件绝对路径）补全，详见 mdImageSrc.ts。
 *
 * **不启用 rehype-raw**：本窗口展示的是工作区里任意（可能不可信）的文件，而
 * projectManager.html 的 CSP 含 `script-src 'unsafe-inline'`。开启 raw HTML 会把文件内容里的
 * `<script>` / `onerror=` 等直接变成可执行面。只读查看器没有「渲染原始 HTML」的正当需求，
 * 因此这里默认由 react-markdown 忽略原始 HTML（默认行为）。
 */

/**
 * 链接打开方式，pm 窗口**固定为 'ask'**（点击弹菜单让用户现场选择内置/系统浏览器）。
 *
 * 为什么不读聊天侧 `useSettingsStore().settings.linkOpening?.mode`（核实结论）：
 * 1. pm 窗口是独立入口 `main_window/projectManager.html`，与聊天窗口的 store 图**互不共享**
 *    ——pm 侧只用 `project-manager/stores/*` 这一套本地 store，从未引入 `renderer/stores/*`。
 * 2. `settingsStore.ts` 的导入图会把 `conversationStore` 拉进来，而后者在**模块顶层**
 *    （conversationStore.ts:1105 `if (typeof window !== 'undefined')`）就注册了
 *    onConversationCreated / onConversationUpdated / onConversationDeleted 等全局 IPC 监听。
 *    在 pm 窗口仅仅是"读一个设置"就会装上一整套会话事件反应链，属于不可接受的副作用。
 * 3. `settingsStore.loadSettings()` 更重：会 configRead/configWrite 落库、对账
 *    permission_mode / message-display-mode、解析并应用主题——pm 窗口没有理由触发这些。
 * 4. 即便硬导入，pm 窗口从不调用 loadSettings()，`settings` 永远是 DEFAULT_SETTINGS，
 *    读到的 linkOpening.mode 恒为 'ask'——收益为零，风险非零。
 *
 * 因此这里按需求给的决策规则退化为「默认 ask」。将来若要支持三态，应经过主进程 configRead
 * 轻量读取（不牵入聊天 store），而不是直接 import settingsStore。
 */
const LINK_OPENING_MODE: 'builtin' | 'system' | 'ask' = 'ask'

/** 深色主题集合（与 lib/theme.ts 的 applyThemeClass 同源）：class 挂在 <html> 上 */
const DARK_THEMES = ['dark', 'yuanshandai']

function isDarkTheme(): boolean {
  const el = document.documentElement
  return DARK_THEMES.some(t => el.classList.contains(t))
}

/**
 * 主题 class 变化时触发重渲染。
 * useThemeSync 只改 <html> 的 class 而不发出 React 信号，因此用 MutationObserver 订阅
 * class 属性；卸载时断开，不留监听。
 */
function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(isDarkTheme)
  useEffect(() => {
    const el = document.documentElement
    const update = () => setDark(isDarkTheme())
    update()
    const observer = new MutationObserver(update)
    observer.observe(el, {attributes: true, attributeFilter: ['class']})
    return () => observer.disconnect()
  }, [])
  return dark
}

// 模块级常量：插件数组只建一次，避免每次渲染新数组导致 react-markdown 重解析
const remarkPlugins = [remarkGfm]

/**
 * 宽松放行所有 URL（模块级稳定引用，避免每次渲染换函数导致重解析）。
 *
 * 必须显式传：react-markdown 的 defaultUrlTransform 只认白名单协议
 * （`^(https?|ircs?|mailto|xmpp)$`），会把 `hclaw-media://local/E:/a.png` 清空成 `''`，
 * 图片 src 直接丢失。参照聊天侧 MarkdownRenderer 的 stableUrlTransform 范式，
 * 这里不额外过滤——安全边界由「不启用 rehype-raw」把守，而非 URL 白名单。
 */
const pmUrlTransform = (url: string) => url

export function MarkdownPreview({content, basePath}: {content: string; basePath?: string}) {
  const codeStyle = useIsDarkTheme() ? oneDark : oneLight

  // 链接菜单状态：记录点击坐标（clientX/clientY）与目标 URL，供 LinkContextMenu 定位 + 打开
  const [linkMenu, setLinkMenu] = useState<{visible: boolean; x: number; y: number; url: string}>(
    {visible: false, x: 0, y: 0, url: ''},
  )

  const components: Components = {
    // 图片：把相对路径/本地绝对路径转成 hclaw-media://（见 mdImageSrc.ts）。
    // `node` 必须解构掉（不要把 react-markdown 的 AST 节点透传到 DOM）；src 解析为空
    // 时返回 null —— 空 src 会让浏览器把当前页面 URL 当成图片再请求一次。
    img({node: _node, src, alt, title}) {
      const resolved = resolveMarkdownImageSrc(src ?? '', basePath)
      if (!resolved) return null
      return (
        <img
          className="pm-md-img"
          src={resolved}
          alt={alt ?? ''}
          title={title}
          loading="lazy"
          data-name="markdown-preview-img"/>
      )
    },
    // 代码块：react-markdown 生成 <pre><code>。这里把 pre 换成 div（而非渲染 pre），
    // 既避免 SyntaxHighlighter 的 <div> 落进 <pre> 的非法嵌套，也让无语言标注的围栏
    // 代码块有一个稳定的块级容器（样式见 .pm-md-code-block）。
    pre({children}) {
      return <div className="pm-md-code-block">{children}</div>
    },
    // 有语言标注 → Prism 高亮；否则当成行内代码（无语言围栏块由上面的 .pm-md-code-block
    // 后代规则覆盖成块级外观，不会显示成药丸）。
    code({className, children}) {
      const match = /language-(\w+)/.exec(className || '')
      if (match) {
        const text = Array.isArray(children) ? children.join('') : String(children ?? '')
        return (
          <SyntaxHighlighter
            style={codeStyle}
            language={match[1]}
            PreTag="div"
            className="pm-md-highlight"
          >
            {text.replace(/\n$/, '')}
          </SyntaxHighlighter>
        )
      }
      return <code className="pm-md-inline-code">{children}</code>
    },
    // 链接点击：**必须** preventDefault。
    // 原来渲染 target="_blank" 会走 Electron 默认窗口打开路径（Windows 上表现为弹默认窗口/弹窗），
    // 与聊天侧行为不一致。现在改为显式接管：
    //   - 'ask'（当前固定值）→ 在点击坐标处弹出 LinkContextMenu，由用户选内置/系统浏览器
    //   - 'builtin' / 'system' → 直接分别调用 electronAPI.openBuiltin / openSystem
    // 保留 href（不降级为 <span>）：既维持 .pm-md-link 的可点击视觉，也保留键盘可达性
    // （Tab 聚焦 + Enter 触发 click）与右键「复制链接地址」等原生能力。
    a({href, children}) {
      const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault()
        if (!href) return
        if (LINK_OPENING_MODE === 'builtin') {
          window.electronAPI?.openBuiltin?.(href)
        } else if (LINK_OPENING_MODE === 'system') {
          window.electronAPI?.openSystem?.(href)
        } else {
          setLinkMenu({visible: true, x: e.clientX, y: e.clientY, url: href})
        }
      }

      return (
        <a
          className="pm-md-link"
          href={href}
          onClick={handleClick}
         data-name="markdown-preview-a">
          {children}
        </a>
      )
    },
  }

  return (
    <div className="pm-md-preview">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components} urlTransform={pmUrlTransform}>
        {content}
      </ReactMarkdown>
      {/* 挂在 document.body（createPortal）：菜单用 position:fixed 定位到点击坐标，
          留在 .pm-md-preview 内会被祖先的 overflow/层叠上下文裁剪。样式由
          LinkContextMenu 自带（Tailwind + CSS 变量），无需额外 CSS。 */}
      {createPortal(
        <LinkContextMenu
          visible={linkMenu.visible}
          x={linkMenu.x}
          y={linkMenu.y}
          url={linkMenu.url}
          onClose={() => setLinkMenu(prev => ({...prev, visible: false}))}
        />,
        document.body,
      )}
    </div>
  )
}
