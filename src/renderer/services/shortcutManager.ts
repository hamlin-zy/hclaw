import {matchEvent, mergeOverrides, SHORTCUT_DEFS, type ShortcutAction} from '../../shared/shortcuts'

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0

type Handlers = Partial<Record<ShortcutAction, Set<() => void>>>

const state = {
    bindings: mergeOverrides(undefined),
    handlers: {} as Handlers,
    recording: false,
}

/** 重建匹配表（settings 变更时调用） */
export function setBindings(overrides?: Record<string, string>): void {
    state.bindings = mergeOverrides(overrides)
}

/** 录制期间挂起分发 */
export function setRecording(recording: boolean): void {
    state.recording = recording
}

/** 订阅 action；返回取消订阅函数 */
export function on(action: ShortcutAction, handler: () => void): () => void {
    ;(state.handlers[action] ??= new Set()).add(handler)
    return () => { state.handlers[action]?.delete(handler) }
}

/** 读取某 action 的当前有效绑定 */
export function getBinding(action: ShortcutAction): string {
    return state.bindings[action]
}

/** 冲突时仅第一个生效：按 SHORTCUT_DEFS 声明序找第一个命中的 action */
function dispatch(e: KeyboardEvent): void {
    if (state.recording) return
    for (const def of SHORTCUT_DEFS) {
        if (def.scope !== 'app') continue
        if (matchEvent(e, state.bindings[def.id], isMac)) {
            e.preventDefault()
            state.handlers[def.id]?.forEach(h => h())
            return
        }
    }
}

let started = false

/**
 * 仅限单调用方（App 是唯一调用点，经 useGlobalHotkeys 挂载/卸载）：
 * 内部用 started 标志防重入，stop 会全局清理监听器；不支持多调用方引用计数。
 */
export function startShortcutManager(): () => void {
    if (started) return () => {}
    started = true
    const handler = (e: KeyboardEvent) => dispatch(e)
    document.addEventListener('keydown', handler)
    return () => {
        document.removeEventListener('keydown', handler)
        started = false
    }
}

export const shortcutManager = {
    setBindings,
    setRecording,
    on,
    getBinding,
    startShortcutManager,
}
