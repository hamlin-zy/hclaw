import {createContext, useContext, useState} from 'react'
import {CopyButton} from '../common/CopyButton'

/** 字符串超过此长度截断显示（Task 7 brief 规格） */
const STR_LIMIT = 220

/** 根节点初始折叠态（「全部折叠/全部展开」按钮经 key 重挂载传播到整棵树） */
const CollapseContext = createContext(false)

/**
 * JSON 树查看器：递归折叠树。
 *
 * - 顶部「全部折叠/全部展开」按钮：经 context 提供默认折叠态 + key 重挂载使整棵树生效，
 *   挂载后各节点仍可独立切换
 * - 字符串 >220 字符截断显示 `…[N chars]` + 复制按钮
 * - 数组折叠预览 `Array(n)`；对象折叠预览前两个 key
 */
export function JsonTree({data}: {data: unknown}) {
    const [allCollapsed, setAllCollapsed] = useState(false)
    return (
        <div className="font-mono text-[11.5px] leading-relaxed select-text">
            <button
                onClick={() => setAllCollapsed(c => !c)}
                className="mb-1 py-0.5 px-2 text-[11px] rounded border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
             data-name="json-tree-button">{allCollapsed ? '全部展开' : '全部折叠'}</button>
            <CollapseContext.Provider value={allCollapsed}>
                {/* key 重挂载：折叠态变化时按新默认值重建所有节点的内部 state */}
                <TreeNode key={String(allCollapsed)} value={data} />
            </CollapseContext.Provider>
        </div>
    )
}

/** 单个树节点：容器类型带折叠态，原始值直接渲染 */
function TreeNode({fieldKey, value}: {fieldKey?: string; value: unknown}) {
    const [collapsed, setCollapsed] = useState(useContext(CollapseContext))

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
             data-name="json-tree-div">
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

/** 原始值行：长字符串截断 + 复制按钮；JSON 内嵌字符串可展开为嵌套树 */
function PrimitiveRow({fieldKey, value}: {fieldKey?: string; value: unknown}) {
    const [jsonExpanded, setJsonExpanded] = useState(false)
    const isLongStr = typeof value === 'string' && value.length > STR_LIMIT
    // 长字符串若本身是合法 JSON 对象/数组，提供展开嵌套树的入口
    let parsedJson: object | null = null
    if (isLongStr) {
        try {
            const p = JSON.parse(value as string)
            if (p && typeof p === 'object') parsedJson = p
        } catch { /* 非 JSON：保持截断+复制 */ }
    }
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
            {parsedJson && (
                <button
                    onClick={() => setJsonExpanded(e => !e)}
                    className="ml-1 py-0 px-1.5 text-[11px] rounded-full border-none text-[var(--text-secondary)] bg-[var(--surface-elevated)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
                    title="展开/收起内嵌 JSON"
                 data-name="json-tree-toggle-button">{jsonExpanded ? '收起' : '展开'}</button>
            )}
            {isLongStr && <CopyButton name={value as string} size="sm" />}
            {parsedJson && jsonExpanded && (
                <div className="pl-3 ml-2 border-l border-dashed border-[var(--border)] my-0.5">
                    <TreeNode value={parsedJson} />
                </div>
            )}
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
