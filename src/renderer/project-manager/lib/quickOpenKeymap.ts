/**
 * PM 窗口 QuickOpen 的键位层：模式、动作、平台相关默认键位，以及纯函数式的匹配与语义解析。
 *
 * 复用共享键位层（`@shared/shortcuts`）的规范化 / 匹配 / 冲突检测，但持**独立**定义表与独立实例，
 * 不注册进主窗口的 `shortcutManager`，因此主窗口键位行为零变化。
 * 平台差异（macOS 用 `Cmd+Shift+O` 而非 `Cmd+Shift+N`）由共享层的 `darwin` 覆盖字段表达，见 ADR-0001。
 */
import {findConflicts, matchEvent, resolveDefaults, type AcceleratorSource} from '@shared/shortcuts'

/** QuickOpen 承载的三种模式（术语以 CONTEXT.md 为准） */
export type QuickOpenMode = 'file-search' | 'recent-files' | 'find-in-files'

export type QuickOpenAction = 'quickOpenFileSearch' | 'quickOpenRecentFiles' | 'quickOpenFindInFiles'

type QuickOpenDef = AcceleratorSource<QuickOpenAction> & {mode: QuickOpenMode}

/**
 * 声明序 = 运行时优先级（同键时仅第一个生效，与共享层 dispatch 同语义）。
 * macOS 上 File Search 用 `Cmd+Shift+O`：`Cmd+Shift+N` 在 macOS 是 Finder 的「新建文件夹」，不能绑。
 */
export const QUICKOPEN_DEFS: readonly QuickOpenDef[] = [
    {id: 'quickOpenFileSearch', default: 'CommandOrControl+Shift+N', darwin: 'CommandOrControl+Shift+O', mode: 'file-search'},
    {id: 'quickOpenRecentFiles', default: 'CommandOrControl+E', mode: 'recent-files'},
    {id: 'quickOpenFindInFiles', default: 'CommandOrControl+Shift+F', mode: 'find-in-files'},
]

/** 当前平台的 QuickOpen 有效绑定 */
export function quickOpenBindings(isMac: boolean): Record<QuickOpenAction, string> {
    return resolveDefaults(QUICKOPEN_DEFS, isMac)
}

/** 快捷键自检：同键多动作时返回冲突组（声明序在前者生效） */
export function findQuickOpenConflicts(
    bindings: Record<QuickOpenAction, string>,
): Record<string, QuickOpenAction[]> {
    return findConflicts(bindings, QUICKOPEN_DEFS)
}

/** 浮层键位语义：动作 → 模式；Esc 关闭；上下键归列表 */
export type QuickOpenCommand =
    | {kind: 'open'; mode: QuickOpenMode}
    | {kind: 'close'}
    | {kind: 'move'; delta: 1 | -1}

/** 事件命中的键位定义；无命中返回 null。同键时按声明序取第一个 */
function matchQuickOpenDef(
    e: {ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; key: string},
    bindings: Record<QuickOpenAction, string>,
    isMac: boolean,
): QuickOpenDef | null {
    for (const def of QUICKOPEN_DEFS) {
        if (matchEvent(e, bindings[def.id], isMac)) return def
    }
    return null
}

/**
 * 键位语义（纯函数）：快捷键打开对应模式；浮层已打开时 Esc 关闭、上下键归列表。
 * 未打开时 Esc / 上下键一律放行（返回 null），不打扰编辑器。
 */
export function resolveQuickOpenCommand(
    e: {ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; key: string},
    bindings: Record<QuickOpenAction, string>,
    isMac: boolean,
    open: boolean,
): QuickOpenCommand | null {
    const def = matchQuickOpenDef(e, bindings, isMac)
    if (def) return {kind: 'open', mode: def.mode}
    if (!open) return null
    if (e.key === 'Escape') return {kind: 'close'}
    if (e.key === 'ArrowDown') return {kind: 'move', delta: 1}
    if (e.key === 'ArrowUp') return {kind: 'move', delta: -1}
    return null
}
