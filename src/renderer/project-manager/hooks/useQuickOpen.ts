import {useEffect, useState} from 'react'
import {quickOpenBindings, resolveQuickOpenCommand, type QuickOpenMode} from '../lib/quickOpenKeymap'

/** macOS 判定（与 renderer/services/shortcutManager 同款） */
function detectIsMac(): boolean {
    return typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0
}

/**
 * QuickOpen 浮层的状态与键位接线（在 ProjectManagerApp 挂**唯一**实例）。
 *
 * 监听器挂在 document 的 **capture 阶段**：capture 先于 CodeMirror（含 vim 模式）在自身 DOM 上的
 * 监听器执行，命中即 `preventDefault` + `stopPropagation`，把事件从编辑器手里抢过来，
 * 因此不会出现「焦点在编辑器里快捷键就不灵」（ADR-0001 的有意取舍）。
 * 浮层未打开时 Esc / 上下键一律放行，编辑器行为不变。
 */
export function useQuickOpen() {
    const [mode, setMode] = useState<QuickOpenMode | null>(null)
    const [query, setQuery] = useState('')

    // 依赖 mode：开闭态直接来自闭包，不引入第二份「当前是否打开」的状态
    useEffect(() => {
        const isMac = detectIsMac()
        const bindings = quickOpenBindings(isMac)
        const onKeyDown = (e: KeyboardEvent) => {
            const cmd = resolveQuickOpenCommand(e, bindings, isMac, mode !== null)
            if (!cmd) return
            e.preventDefault()
            e.stopPropagation()
            if (cmd.kind === 'close') {
                setMode(null)
                return
            }
            if (cmd.kind === 'move') {
                // 上下键归列表：票 01 列表恒空，这里只保证事件不被编辑器消费
                return
            }
            // 呼出：重置查询，三种模式一律打开同一个空壳
            setQuery('')
            setMode(cmd.mode)
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
    }, [mode])

    return {mode, query, setQuery}
}
