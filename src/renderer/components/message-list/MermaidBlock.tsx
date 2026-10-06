/**
 * Mermaid 流程图渲染块
 *
 * 把一段 mermaid 源码渲染为 SVG。要点：
 * - **懒加载**：`import('mermaid')` 动态引入，首次遇到流程图才拉取 mermaid 体积，主 bundle 不膨胀。
 * - **降级**：parse/render 失败或超时 → 回退为普通代码块（源码可读 + 可复制），绝不白屏。
 * - **主题跟随**：isDark 变化时以 dark/default 主题重新渲染。
 * - **注入方式**：svg 通过 hostRef.innerHTML 注入；host div 不持有 JSX children，
 *   React 重渲染只改 className，不会清掉手动注入的 svg。
 *
 * 安全：securityLevel 固定 'strict'，禁用 mermaid 输出中的脚本与点击事件
 * （消息内容可能来自不可信来源，且主窗口 script-src 含 'unsafe-inline'）。
 */

import {memo, useEffect, useRef, useState} from 'react'
import {TransformWrapper, TransformComponent} from 'react-zoom-pan-pinch'
import ImagePreviewModal from '../common/ImagePreviewModal'

/** 渲染超时：超过则视为失败并降级，避免坏图卡住消息流 */
const RENDER_TIMEOUT_MS = 4000

/** 最小渲染高度：宽扁图在容器宽度下高度不足时，自动缩放至此高度保证可读 */
const MIN_HEIGHT = 280

/** 缩放控制按钮共用样式 */
const zoomBtnClass = 'w-7 h-7 flex items-center justify-center text-sm rounded transition-colors ' +
    'bg-[var(--surface-muted)] hover:bg-[var(--surface-overlay)] ' +
    'text-[var(--text-secondary)] hover:text-[var(--text-primary)] ' +
    'border border-[var(--border)]'

/** 右上角控件按钮（全屏/复制）共用样式 */
const controlBtnClass = 'px-2 py-1 text-xs rounded transition-colors ' +
    'bg-[var(--surface-muted)] hover:bg-[var(--surface-overlay)] ' +
    'text-[var(--text-secondary)] hover:text-[var(--text-primary)] ' +
    'border border-[var(--border)]'

/** 短哈希：为 mermaid.render 生成稳定的 id 前缀（同源码 + 同主题 → 同前缀） */
function hashString(input: string): string {
    let h = 5381
    for (let i = 0; i < input.length; i++) {
        h = ((h << 5) + h + input.charCodeAt(i)) | 0
    }
    return (h >>> 0).toString(36)
}

// 模块级实例序号：hash 前缀相同的两个 MermaidBlock 实例（同 code + 同主题）
// 共享同一个 id 会让 mermaid.render 的临时 DOM 容器 #d<id> 撞车，进而：
//   1. 并发 render 相互覆盖 svg 内容；
//   2. finally 里 getElementById('d'+id)?.remove() 会误删兄弟实例的错误容器。
// 追加自增 uid 保证实例唯一，hash 前缀保留以维持语义可读性。
let uidCounter = 0

type Status = 'loading' | 'ready' | 'error'

interface MermaidBlockProps {
    code: string
    isDark: boolean
    /** 流式输出中：parse 失败时保持 loading 而非降级为 error，避免 partial 代码反复闪烁 */
    isStreaming?: boolean
}

export const MermaidBlock = memo(function MermaidBlock({code, isDark, isStreaming}: MermaidBlockProps) {
    const hostRef = useRef<HTMLDivElement | null>(null)
    const [status, setStatus] = useState<Status>('loading')
    const [copied, setCopied] = useState(false)
    /** 全屏查看用的 SVG 源码；存字符串不走 blob URL，避免 revoke 时序导致 img 加载失败 */
    const [svgContent, setSvgContent] = useState<string | null>(null)
    const [fullscreen, setFullscreen] = useState(false)
    /** TransformWrapper 的 setTransform 引用，供 useEffect 中设置初始缩放 */
    const setTransformRef = useRef<((x: number, y: number, scale: number, animationTime?: number) => void) | null>(null)
    /** wrapper 最小高度：缩放时同步抬高，避免缩放后内容被 overflow-hidden 裁剪 */
    const [wrapperMinH, setWrapperMinH] = useState(80)

    useEffect(() => {
        let cancelled = false
        setStatus('loading')
        setWrapperMinH(80)
        setSvgContent(null)
        // 复位缩放：TransformWrapper 无 key，实例跨 code/isDark/isStreaming 变化复用，
        // 上一次按宽扁图算出的 transform 会残留到新图（宽扁图被放大后又切到高图 → 图被放大并上移、
        // 被 overflow-hidden 裁剪）。必须在新 code 的首次 rAF 之前复位，且覆盖 loading/error 路径。
        setTransformRef.current?.(0, 0, 1, 0)
        let hangTimer: number | null = null
        const timer = window.setTimeout(() => {
            if (cancelled) return
            // 流式期间超时保持 loading：partial 代码 parse/render 卡住是预期的
            setStatus(isStreaming ? 'loading' : 'error')
            // 二次看门：如果 promise 继续悬挂（例如 mermaid 内部死锁、异常被吞），
            // 第一次 timer 只能把 status 停在 loading；再加一个 RENDER_TIMEOUT_MS 兜底强制降级，
            // 否则 status 会永久卡在 loading。非流式已经直接 error，无需二次看门。
            if (isStreaming) {
                hangTimer = window.setTimeout(() => {
                    if (!cancelled) setStatus('error')
                }, RENDER_TIMEOUT_MS)
            }
        }, RENDER_TIMEOUT_MS)
        const settle = (next: Status) => {
            if (cancelled) return
            window.clearTimeout(timer)
            if (hangTimer) window.clearTimeout(hangTimer)
            setStatus(next)
        }

        ;(async () => {
            // id 提到 try 外层：finally 需要它来定位 mermaid 可能遗留在 body 的临时容器
            const id = `mermaid-${hashString(code + (isDark ? 'd' : 'l'))}-${uidCounter++}`
            try {
                const mermaid = (await import('mermaid')).default
                mermaid.initialize({
                    startOnLoad: false,
                    securityLevel: 'strict',
                    theme: isDark ? 'dark' : 'default',
                })
                // 先 parse 预校验：语法错误在此抛出，避免 render 往 document 插入错误占位
                await mermaid.parse(code)
                const {svg} = await mermaid.render(id, code)
                if (cancelled) return
                if (hostRef.current) hostRef.current.innerHTML = svg
                // 存原始 SVG 源码供全屏预览，不走 blob URL：
                // 1. blob URL 在组件 re-render（isStreaming 翻转等）触发 effect 重跑时被 revoke，img 加载已 revoke 的 URL 会静默失败；
                // 2. 含 <br> 等 HTML 标签的节点 mermaid 用 <foreignObject> 渲染，<img> 无法渲染该类 SVG。
                // 覆盖 mermaid 的 width="100%"：它配套的 max-width 依赖「有确定宽度的父容器」，
                // 而预览容器是 shrink-to-fit 的绝对定位盒子，百分比宽度会解析成 0 → 整图不可见。
                // 这里改给 100%×100%，由预览容器提供确定尺寸 + SVG 的 preserveAspectRatio 等比适配。
                setSvgContent(svg.replace('<svg ', '<svg style="width:100%;height:100%;display:block" '))
                settle('ready')
                // 计算初始缩放：宽扁图在容器宽度下高度不足时放大至 MIN_HEIGHT
                requestAnimationFrame(() => {
                    if (cancelled) return
                    const svgEl = hostRef.current?.querySelector('svg')
                    if (!svgEl || !setTransformRef.current) return
                    const rect = svgEl.getBoundingClientRect()
                    if (rect.height <= 0 || rect.height >= MIN_HEIGHT) return
                    const scale = Math.min(MIN_HEIGHT / rect.height, 5) // maxScale=5
                    setWrapperMinH(MIN_HEIGHT)
                    // 补偿 flex 居中偏移：wrapper 抬高后 content 居中，需上移使顶部对齐
                    const translateY = -(MIN_HEIGHT - rect.height) / 2
                    setTransformRef.current(0, translateY, scale, 0)
                })
            } catch {
                // ★ 流式期间不降级为 error：partial mermaid 代码 parse 失败是预期行为，
                //   降级到 error 会展示原始代码，下一帧又回到 loading，造成闪烁。
                //   流结束后（isStreaming=false）才真正降级，此时代码已完整。
                settle(isStreaming ? 'loading' : 'error')
            } finally {
                // mermaid v12 渲染失败且 suppressErrorRendering 为默认 false 时，会把错误 SVG
                // 塞进临时容器 #d<id> 并插入 document.body；异常抛出后本组件无从回收，
                // 会永久残留。这里幂等清理：成功路径 mermaid 已自行移除，重复 remove 无副作用。
                document.getElementById(`d${id}`)?.remove()
            }
        })()

        return () => {
            cancelled = true
            window.clearTimeout(timer)
            if (hangTimer) window.clearTimeout(hangTimer)
        }
    }, [code, isDark, isStreaming])

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(code)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 2000)
        } catch {
            // 复制失败，静默处理
        }
    }

    const renderControls = (withZIndex: boolean) => (
        <div
            data-find-exclude
            className={`absolute top-2 right-2 ${withZIndex ? 'z-10 ' : ''}flex gap-1.5`}
        >
            {svgContent && (
                <button
                    onClick={() => setFullscreen(true)}
                    className={`${controlBtnClass} flex items-center justify-center`}
                    title="全屏查看"
                    data-name="mermaid-block-fullscreen"
                >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/>
                    </svg>
                </button>
            )}
            <button
                onClick={handleCopy}
                className={controlBtnClass}
                title="复制代码"
                data-name="mermaid-block-copy"
            >
                {copied ? '已复制' : '复制'}
            </button>
        </div>
    )

    // 降级：渲染失败 / 超时 → 普通代码块（与 MarkdownRenderer 无语言围栏样式对齐）
    if (status === 'error') {
        return (
            <div className="relative group my-3.5">
                {renderControls(false)}
                <pre
                    className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-muted)] p-3 text-sm font-mono leading-[1.6] border border-[var(--border)]">
                    {code}
                </pre>
            </div>
        )
    }

    return (
        <div
            className="relative group my-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            {status === 'loading' && (
                <div className="py-4 text-center text-xs text-[var(--text-secondary)]">渲染流程图…</div>
            )}
            {status === 'ready' && renderControls(true)}
            {/*
              TransformWrapper 始终渲染（含 loading）以保持 hostRef 挂载点稳定：
              SVG 通过 useEffect → hostRef.current.innerHTML 注入，
              若条件渲染 TransformWrapper 会导致 ref 指向不同 DOM 节点，注入的 SVG 丢失。
              TransformWrapper 是纯 Context Provider，不产生额外 DOM。
            */}
            <TransformWrapper
                minScale={0.3}
                maxScale={5}
                limitToBounds={false}
                doubleClick={{mode: 'reset'}}
                wheel={{step: 0.002}}
                smooth
            >
                {({zoomIn, zoomOut, resetTransform, setTransform}) => {
                    setTransformRef.current = setTransform
                    return (
                    <>
                        <TransformComponent
                            wrapperClass="!w-full !flex !items-center !justify-center cursor-grab active:cursor-grabbing overflow-hidden"
                            wrapperStyle={{minHeight: wrapperMinH}}
                        >
                            {/* 无 JSX children：React 不触碰手动注入的 svg；仅通过 className 控制显隐 */}
                            <div
                                ref={hostRef}
                                className={status === 'ready' ? 'mermaid-block' : 'mermaid-block hidden'}
                                data-name="mermaid-block-svg"
                            />
                        </TransformComponent>
                        {status === 'ready' && (
                            <div className="absolute bottom-2 right-2 z-10 flex gap-1.5" data-find-exclude>
                                <button
                                    onClick={() => void zoomIn()}
                                    className={zoomBtnClass}
                                    title="放大"
                                    data-name="mermaid-block-zoom-in"
                                >+</button>
                                <button
                                    onClick={() => void zoomOut()}
                                    className={zoomBtnClass}
                                    title="缩小"
                                    data-name="mermaid-block-zoom-out"
                                >−</button>
                                <button
                                    onClick={() => void resetTransform()}
                                    className={zoomBtnClass}
                                    title="重置"
                                    data-name="mermaid-block-zoom-reset"
                                >↺</button>
                            </div>
                        )}
                    </>
                    )
                }}
            </TransformWrapper>
            {fullscreen && svgContent && (
                <ImagePreviewModal
                    svgContent={svgContent}
                    alt="mermaid 流程图"
                    onClose={() => setFullscreen(false)}
                />
            )}
        </div>
    )
})