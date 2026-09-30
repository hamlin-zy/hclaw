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

/** 渲染超时：超过则视为失败并降级，避免坏图卡住消息流 */
const RENDER_TIMEOUT_MS = 4000

/** 稳定短哈希：为 mermaid.render 生成唯一 DOM id（同源码 + 同主题 → 同 id） */
function hashString(input: string): string {
    let h = 5381
    for (let i = 0; i < input.length; i++) {
        h = ((h << 5) + h + input.charCodeAt(i)) | 0
    }
    return (h >>> 0).toString(36)
}

type Status = 'loading' | 'ready' | 'error'

interface MermaidBlockProps {
    code: string
    isDark: boolean
}

export const MermaidBlock = memo(function MermaidBlock({code, isDark}: MermaidBlockProps) {
    const hostRef = useRef<HTMLDivElement | null>(null)
    const [status, setStatus] = useState<Status>('loading')
    const [copied, setCopied] = useState(false)

    useEffect(() => {
        let cancelled = false
        setStatus('loading')
        const timer = window.setTimeout(() => {
            if (!cancelled) setStatus('error')
        }, RENDER_TIMEOUT_MS)
        const settle = (next: Status) => {
            if (cancelled) return
            window.clearTimeout(timer)
            setStatus(next)
        }

        ;(async () => {
            // id 提到 try 外层：finally 需要它来定位 mermaid 可能遗留在 body 的临时容器
            const id = `mermaid-${hashString(code + (isDark ? 'd' : 'l'))}`
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
                settle('ready')
            } catch {
                settle('error')
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
        }
    }, [code, isDark])

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(code)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 2000)
        } catch {
            // 复制失败，静默处理
        }
    }

    // 降级：渲染失败 / 超时 → 普通代码块（与 MarkdownRenderer 无语言围栏样式对齐）
    if (status === 'error') {
        return (
            <div className="relative group my-3.5">
                <button
                    onClick={handleCopy}
                    data-find-exclude
                    className="absolute top-2 right-2 px-2 py-1 text-xs rounded transition-colors
                        bg-[var(--surface-muted)] hover:bg-[var(--surface-overlay)]
                        text-[var(--text-secondary)] hover:text-[var(--text-primary)]
                        border border-[var(--border)]"
                    title="复制代码"
                    data-name="mermaid-block-button"
                >
                    {copied ? '已复制' : '复制'}
                </button>
                <pre
                    className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-muted)] p-3 text-sm font-mono leading-[1.6] border border-[var(--border)]">
                    {code}
                </pre>
            </div>
        )
    }

    return (
        <div
            className="relative group my-3.5 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            {status === 'loading' && (
                <div className="py-4 text-center text-xs text-[var(--text-secondary)]">渲染流程图…</div>
            )}
            {/* 无 JSX children：React 不触碰手动注入的 svg；仅通过 className 控制显隐 */}
            <div
                ref={hostRef}
                className={status === 'ready' ? 'mermaid-block' : 'mermaid-block hidden'}
                data-name="mermaid-block-svg"
            />
        </div>
    )
})