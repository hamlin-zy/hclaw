// 浮层第三行「选中项预览」的内容体（工单 04）。
//
// 纯文本渲染：等宽字体 + 自画行号 + `<mark>` 标命中 + 语法着色，**不创建编辑器实例**（ADR-0002）。
//   着色复用 lib/syntaxHighlight.ts（与 CodeEditor / DiffViewer 同一批 --code-* 令牌，三处同色），
//   以 `.pm-tok-*` 类名落 <span>，不挂 CodeMirror。
// 取数、防抖、token 校验、LRU-10 缓存全在 hooks/useQuickOpenPreview.ts + lib/quickOpenPreview.ts，
// 本文件只负责把状态画出来（含失败时的单行原因文案——不空白、不提供重试）。
import type {QuickOpenMode} from '../lib/quickOpenKeymap'
import type {QuickOpenItem} from '../lib/quickOpenResults'
import {mergePreviewSegments, type PreviewSegment} from '../lib/quickOpenPreview'
import {useQuickOpenPreview} from '../hooks/useQuickOpenPreview'

export interface QuickOpenPreviewProps {
    mode: QuickOpenMode
    /** 当前键盘选中项；列表为空时为 null */
    item: QuickOpenItem | null
    /** 工作区根：预览取数与缓存键的归属维度；缺省（无工作区 / 单测直渲）时不取数 */
    workspacePath?: string | null
}

/**
 * 一行预览的片段渲染。
 * 着色走 `.pm-tok-*`（与 CodeEditor / DiffViewer 同一批 `--code-*` 令牌，故三处同色）；
 * 命中区间（Find in Files）再叠一层 `.pm-quickopen-mark`——mark 只换底色，颜色仍由外层
 * 着色 span 继承，两者可同时成立。
 */
function PreviewSegments({segments}: {segments: PreviewSegment[]}) {
    return (
        <>
            {segments.map((seg, i) => (
                <span key={i} className={seg.cls === '' ? undefined : seg.cls}>
                    {seg.hit ? <mark className="pm-quickopen-mark">{seg.text}</mark> : seg.text}
                </span>
            ))}
        </>
    )
}

export function QuickOpenPreview({mode, item, workspacePath = null}: QuickOpenPreviewProps) {
    const {view, tokens} = useQuickOpenPreview(workspacePath, mode, item)

    if (!item) {
        return <p className="pm-quickopen-preview-empty">上下键选择条目以查看预览</p>
    }
    return (
        <div className="pm-quickopen-preview-body">
            {/* 完整相对路径 · 大小 · 修改时间（失败时至少有路径，不留空白）。
                未取数（idle：无工作区）时元信息行退化为路径本身。 */}
            <p className="pm-quickopen-preview-path" data-testid="pm-quickopen-preview-meta">
                {view.meta !== '' ? view.meta : item.path}
            </p>
            {view.status === 'loading' && <p className="pm-quickopen-preview-pending">读取中…</p>}
            {view.status === 'error' && (
                <p className="pm-quickopen-preview-error" data-testid="pm-quickopen-preview-error">{view.error}</p>
            )}
            {view.status === 'ready' && (
                <div className="pm-quickopen-preview-lines select-text" data-testid="pm-quickopen-preview-lines">
                    {view.rows.map((row, i) => (
                        <div
                            key={row.lineNumber}
                            className={`pm-quickopen-preview-line${row.hitStart !== null ? ' is-hit' : ''}`}
                            data-line={row.lineNumber}
                        >
                            <span className="pm-quickopen-preview-lineno">{row.lineNumber}</span>
                            <span className="pm-quickopen-preview-text">
                                <PreviewSegments
                                    segments={mergePreviewSegments(
                                        row.text,
                                        tokens?.[i] ?? null,
                                        row.hitStart,
                                        row.hitEnd,
                                    )}
                                />
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
