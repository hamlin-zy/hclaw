import type {QuickOpenMode} from '../lib/quickOpenKeymap'

/** 模式专属 placeholder（术语以 CONTEXT.md 为准；浮层只允许三行，故模式名挂在搜索框上） */
const MODE_PLACEHOLDER: Record<QuickOpenMode, string> = {
    'file-search': 'File Search — 输入文件路径名中的片段',
    'recent-files': 'Recent Files — 按打开时间倒序',
    'find-in-files': 'Find in Files — 输入要检索的内容',
}

/**
 * QuickOpen 浮层骨架（ADR-0002）：固定三行 —— 搜索框 / 匹配列表 / 选中项预览。
 *
 * 票 01 只建壳：三种模式打开同一个空浮层，列表与预览留空（数据源、预览取数、检索属票据 02–05）。
 * 键位（呼出 / Esc 关闭 / 上下键归列表）由 `useQuickOpen` 的 capture 阶段 document 监听统一处理，
 * 本组件只负责结构与搜索框的受控值，不自行接管键盘。
 */
export function QuickOpen({mode, query, onQueryChange}: {
    mode: QuickOpenMode
    query: string
    onQueryChange: (value: string) => void
}) {
    return (
        <div className="pm-quickopen-backdrop">
            <div
                className="pm-quickopen"
                role="dialog"
                aria-modal="true"
                aria-label="QuickOpen"
                data-testid="pm-quickopen"
                data-mode={mode}
            >
                <input
                    className="pm-quickopen-input"
                    // 打开即聚焦搜索框：编辑器失去焦点不改变其选区与滚动位置
                    autoFocus
                    type="text"
                    value={query}
                    onChange={e => onQueryChange(e.target.value)}
                    placeholder={MODE_PLACEHOLDER[mode]}
                    aria-label="QuickOpen 搜索"
                    data-testid="pm-quickopen-input"
                />
                <div className="pm-quickopen-list" role="listbox" aria-label="匹配列表" data-testid="pm-quickopen-list" />
                <div className="pm-quickopen-preview" aria-label="选中项预览" data-testid="pm-quickopen-preview" />
            </div>
        </div>
    )
}
