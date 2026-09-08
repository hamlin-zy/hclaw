import {useState} from 'react'
import type {PhraseItem} from '@shared/types/phrase'
import {usePhraseStore} from '../stores/phraseStore'
import {matchEvent} from '@shared/shortcuts'
import {shortcutManager} from '../services/shortcutManager'

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0

/** 在 value 的 [selectionStart, selectionEnd) 区间插入 text，返回新值与新光标位置 */
export function insertAtCursor(value: string, selectionStart: number, selectionEnd: number, text: string): {value: string; cursor: number} {
    const before = value.slice(0, selectionStart)
    const after = value.slice(selectionEnd)
    const newValue = before + text + after
    return {value: newValue, cursor: selectionStart + text.length}
}

/** 将选中短语插入 textarea 光标处、恢复焦点并触发 MRU touch（InputArea 与 ParamInputModal 共用） */
export function pickPhraseInto(
    ta: HTMLTextAreaElement,
    phrase: PhraseItem,
    setValue: (v: string) => void,
): void {
    const r = insertAtCursor(ta.value, ta.selectionStart ?? ta.value.length, ta.selectionEnd ?? ta.selectionStart ?? ta.value.length, phrase.content)
    setValue(r.value)
    requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = r.cursor
        ta.focus()
    })
    void usePhraseStore.getState().touch(phrase.id)
}

/** 管理呼出 PhrasePicker 的 open 状态与快捷键拦截（绑定经快捷键配置系统） */
export function usePhrasePicker() {
    const [open, setOpen] = useState(false)
    const openOnShortcut = (e: React.KeyboardEvent) => {
        if (matchEvent(e as unknown as KeyboardEvent, shortcutManager.getBinding('togglePhrasePicker'), isMac)) {
            // 阻断合成事件继续冒泡到 document 级监听器，防止快捷键双触发
            e.stopPropagation()
            e.preventDefault()
            setOpen(true)
        }
    }
    const close = () => setOpen(false)
    return {open, openOnShortcut, close}
}
