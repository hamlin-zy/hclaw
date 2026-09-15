import {matchEvent, mergeOverrides, SHORTCUT_DEFS, type ShortcutAction} from '../../shared/shortcuts'
import {IS_MAC} from '../lib/platform'

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
    return () => {
        const set = state.handlers[action]
        if (!set) return
        set.delete(handler)
        // 删除后无订阅者则清掉空 Set key，避免 handlers 长期累积空集合
        if (set.size === 0) delete state.handlers[action]
    }
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
        if (matchEvent(e, state.bindings[def.id], IS_MAC)) {
            e.preventDefault()
            state.handlers[def.id]?.forEach(h => h())
            return
        }
    }
}

let activeStarts = 0
let removeKeydown: (() => void) | null = null

/**
 * 引用计数式启停：支持多调用方。首个调用挂载 keydown 监听，最后一个 cleanup
 * （计数归零）时移除监听；重复调用 cleanup 仅生效一次。快捷键分发/绑定行为不变。
 */
export function startShortcutManager(): () => void {
    activeStarts++
    if (activeStarts === 1) {
        const handler = (e: KeyboardEvent) => dispatch(e)
        document.addEventListener('keydown', handler)
        removeKeydown = () => document.removeEventListener('keydown', handler)
    }
    let stopped = false
    return () => {
        if (stopped) return
        stopped = true
        activeStarts--
        if (activeStarts === 0) {
            removeKeydown?.()
            removeKeydown = null
        }
    }
}

export const shortcutManager = {
    setBindings,
    setRecording,
    on,
    getBinding,
    startShortcutManager,
}
