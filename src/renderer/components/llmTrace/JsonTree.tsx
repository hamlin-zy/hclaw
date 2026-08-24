import {useState} from 'react'
import {CopyButton} from '../common/CopyButton'

/** 字符串超过此长度截断显示（Task 7 brief 规格） */
const STR_LIMIT = 220

/**
 * JSON 树查看器：递归折叠树。
 *
 * - 字符串 >220 字符截断显示 `…[N chars]` + 复制按钮
 * - 数组折叠预览 `Array(n)`；对象折叠预览前两个 key
 * - 点击容器节点切换 collapsed
 */
export function JsonTree({data}: {data: unknown}) {
    return (
        <div className="font-mono text-[11.5px] leading-relaxed select-text">
            <TreeNode value={data} />
        </div>
    )
}

/** 单个树节点：容器类型带折叠态，原始值直接渲染 */
function TreeNode({fieldKey, value}: {fieldKey?: string; value: unknown}) {
    const [collapsed, setCollapsed] = useState(false)

    if (value === null || typeof value !== 'object') {
        return <PrimitiveRow fieldKey={fieldKey} value={value} />
    }

    const isArray = Array.isArray(value)
    const entries: Array<[string, unknown]> = isArray
        ? (value as unknown[]).map((v, i) => [String(i), v])
        : Object.entries(value as Record<string, unknown>)
    const openBracket = isArray ? '[' : '{'
    const closeBracket = isArray ? ']' : '}'

    // 折叠预览：数组 → Array(n)；对象 → 前两个 key
    let preview: string
    if (isArray) {
        preview = `Array(${entries.length})`
    } else if (entries.length === 0) {
        preview = '{}'
    } else {
        const keys = entries.slice(0, 2).map(([k]) => k).join(', ')
        preview = `{ ${keys}${entries.length > 2 ? ', …' : ''} }`
    }

    return (
        <div>
            <div
                className="cursor-pointer rounded hover:bg-[var(--surface-muted)] -mx-1 px-1"
                onClick={() => setCollapsed(c => !c)}
            >
                <KeyLabel fieldKey={fieldKey} />
                <span className="text-[var(--text-muted)]">{collapsed ? '▸ ' : '▾ '}</span>
                {collapsed ? (
                    <>
                        <span className="italic text-[var(--text-secondary)]">{preview}</span>
                    </>
                ) : (
                    <span className="text-[var(--text-secondary)]">{openBracket}</span>
                )}
            </div>
            {!collapsed && (
                <>
                    <ul className="pl-4 ml-2 border-l border-dashed border-[var(--border)]">
                        {entries.map(([k, v]) => (
                            <li key={k}><TreeNode fieldKey={k} value={v} /></li>
                        ))}
                    </ul>
                    <div className="text-[var(--text-secondary)]">{closeBracket}</div>
                </>
            )}
        </div>
    )
}

/** 原始值行：长字符串截断 + 复制按钮 */
function PrimitiveRow({fieldKey, value}: {fieldKey?: string; value: unknown}) {
    const isLongStr = typeof value === 'string' && value.length > STR_LIMIT
    const strDisplay = typeof value === 'string'
        ? (isLongStr ? `${value.slice(0, STR_LIMIT)}…[${value.length} chars]` : value)
        : ''

    return (
        <div className="whitespace-pre-wrap break-all -mx-1 px-1">
            <KeyLabel fieldKey={fieldKey} />
            {typeof value === 'string' && (
                <span className={isLongStr ? '' : 'text-green-700 dark:text-[#98c98f]'}>
                    "{strDisplay}"
                </span>
            )}
            {typeof value === 'number' && (
                <span className="text-amber-700 dark:text-[#d8b47a]">{String(value)}</span>
            )}
            {typeof value === 'boolean' && (
                <span className="text-purple-600 dark:text-[#cf8ee0]">{String(value)}</span>
            )}
            {(value === null || value === undefined) && (
                <span className="italic text-[var(--text-muted)]">null</span>
            )}
            {isLongStr && <CopyButton name={value as string} size="sm" />}
        </div>
    )
}

function KeyLabel({fieldKey}: {fieldKey?: string}) {
    if (fieldKey === undefined) return null
    return (
        <>
            <span className="text-sky-700 dark:text-[#7ec3f0]">{fieldKey}</span>
            <span className="text-[var(--text-secondary)]">: </span>
        </>
    )
}
