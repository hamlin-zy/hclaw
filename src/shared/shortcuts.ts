/**
 * 快捷键注册中心（共享层）：定义 + 规范化 + 匹配 + 冲突检测纯函数。
 * 存储格式统一 Electron accelerator；CommandOrControl 平台无关。
 */

export type ShortcutAction =
    | 'toggleWindow' | 'newSession' | 'newMemo'
    | 'prevSession' | 'nextSession'
    | 'toggleLeftSidebar' | 'toggleRightSidebar'
    | 'toggleTheme' | 'toggleCommandPalette'
    | 'prevInputHistory' | 'nextInputHistory' | 'togglePhrasePicker'

export type ShortcutScope = 'global' | 'app'
export type ShortcutGroup = '面板 & 窗口' | '输入 & 会话' | '全局'

export interface ShortcutDef {
    id: ShortcutAction
    default: string
    scope: ShortcutScope
    label: string
    group: ShortcutGroup
}

/** 声明序 = 运行时优先级（冲突时仅第一个生效） */
export const SHORTCUT_DEFS: ShortcutDef[] = [
    {id: 'toggleWindow', default: 'CommandOrControl+Shift+Space', scope: 'global', label: '隐藏 / 显示 HClaw 窗口', group: '全局'},
    {id: 'newSession', default: 'CommandOrControl+N', scope: 'app', label: '新建会话', group: '输入 & 会话'},
    {id: 'newMemo', default: 'CommandOrControl+Shift+N', scope: 'app', label: '新建备忘录', group: '输入 & 会话'},
    {id: 'prevSession', default: 'Alt+Up', scope: 'app', label: '上一个会话', group: '输入 & 会话'},
    {id: 'nextSession', default: 'Alt+Down', scope: 'app', label: '下一个会话', group: '输入 & 会话'},
    {id: 'prevInputHistory', default: 'CommandOrControl+Up', scope: 'app', label: '上一条输入历史', group: '输入 & 会话'},
    {id: 'nextInputHistory', default: 'CommandOrControl+Down', scope: 'app', label: '下一条输入历史', group: '输入 & 会话'},
    {id: 'togglePhrasePicker', default: 'CommandOrControl+Shift+V', scope: 'app', label: '呼出短语选择器', group: '输入 & 会话'},
    {id: 'toggleLeftSidebar', default: 'CommandOrControl+B', scope: 'app', label: '切换左侧栏', group: '面板 & 窗口'},
    {id: 'toggleRightSidebar', default: 'CommandOrControl+Shift+B', scope: 'app', label: '切换右侧备忘录面板', group: '面板 & 窗口'},
    {id: 'toggleTheme', default: 'CommandOrControl+Shift+T', scope: 'app', label: '切换明暗主题', group: '面板 & 窗口'},
    {id: 'toggleCommandPalette', default: 'CommandOrControl+K', scope: 'app', label: '命令选择弹窗', group: '面板 & 窗口'},
]

export const DEFAULT_OVERRIDES: Record<ShortcutAction, string> =
    Object.fromEntries(SHORTCUT_DEFS.map(d => [d.id, d.default])) as Record<ShortcutAction, string>

/** 合法主键：单字符 / Fn / 方向键 */
const KEY_RE = /^(?:[a-z0-9]$|[+\-.,/;'`\[\]\\=]|\S$|f([1-9]|1[0-2])$|up$|down$|left$|right$|space$|tab$|enter$|escape$|backspace$|delete$|home$|end$|pageup$|pagedown$)/i
const MODIFIERS = new Set(['ctrl', 'commandorcontrol', 'cmdorctrl', 'cmd', 'command', 'meta', 'shift', 'alt', 'option', 'altgr'])
const ARROW: Record<string, string> = {up: 'Up', down: 'Down', left: 'Left', right: 'Right', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right'}

/** 将任意 accelerator 字符串归一化为规范格式；非法返回 null */
export function normalizeAccelerator(acc: string): string | null {
    if (!acc) return null
    const parts = acc.split('+').map(p => p.trim()).filter(Boolean)
    if (parts.length < 2) return null
    const keys = parts.map(p => p.toLowerCase())
    const main = ARROW[keys[keys.length - 1]] ?? keys[keys.length - 1]
    const mods = keys.slice(0, -1)
    if (mods.some(m => !MODIFIERS.has(m))) return null
    if (MODIFIERS.has(main)) return null // 纯修饰键
    if (!KEY_RE.test(main)) return null

    const hasCOC = mods.some(m => m === 'commandorcontrol' || m === 'cmdorctrl' || m === 'ctrl' || m === 'cmd' || m === 'command' || m === 'meta')
    const hasShift = mods.includes('shift')
    const hasAlt = mods.some(m => m === 'alt' || m === 'option' || m === 'altgr')
    if (!hasCOC && !hasShift && !hasAlt) return null // 无修饰键

    // 主键规范化：首字母大写，其余保持
    const normMain = main[0].toUpperCase() + main.slice(1)
    return [
        hasCOC ? 'CommandOrControl' : null,
        hasAlt ? 'Alt' : null,
        hasShift ? 'Shift' : null,
        normMain,
    ].filter(Boolean).join('+')
}

/** 键盘事件 → accelerator；非法返回 null */
export function eventToAccelerator(
    e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; key: string },
    isMac: boolean,
): string | null {
    // mac: ctrl 与 meta 等价；非 mac 仅 ctrl
    const coc = isMac ? (e.ctrlKey || e.metaKey) : e.ctrlKey
    if (!isMac && e.metaKey) return null
    if (!coc && !e.shiftKey && !e.altKey) return null
    if (MODIFIERS.has(e.key.toLowerCase())) return null
    // 拼装：按固定顺序重排（复用 normalize 做校验与归一）
    const parts = [coc ? 'CommandOrControl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', e.key].filter(Boolean)
    return normalizeAccelerator(parts.join('+'))
}

/** 事件是否匹配某 accelerator */
export function matchEvent(
    e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; key: string },
    acc: string,
    isMac: boolean,
): boolean {
    const norm = normalizeAccelerator(acc)
    if (!norm) return false
    const evAcc = eventToAccelerator(e, isMac)
    return evAcc === norm
}

/** 默认表 + 覆盖项 → 有效绑定（废弃 id 容错清理） */
export function mergeOverrides(overrides?: Record<string, string>): Record<ShortcutAction, string> {
    const result = {...DEFAULT_OVERRIDES}
    if (overrides) {
        for (const [id, acc] of Object.entries(overrides)) {
            if (id in DEFAULT_OVERRIDES) {
                const norm = normalizeAccelerator(acc)
                if (norm) result[id as ShortcutAction] = norm
            }
        }
    }
    return result
}

/** 冲突组：accelerator → 同键 action 列表（仅 >1 项） */
export function findConflicts(effective: Record<ShortcutAction, string>): Record<string, ShortcutAction[]> {
    const byAcc: Record<string, ShortcutAction[]> = {}
    for (const def of SHORTCUT_DEFS) {
        const acc = normalizeAccelerator(effective[def.id])
        if (!acc) continue
        ;(byAcc[acc] ??= []).push(def.id)
    }
    return Object.fromEntries(Object.entries(byAcc).filter(([, ids]) => ids.length > 1))
}
