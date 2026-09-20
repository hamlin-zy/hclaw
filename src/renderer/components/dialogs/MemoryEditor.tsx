// MemoryEditor：memory-manager 专用 CodeMirror 6 轻量包装。
//
// 为什么不复用 project-manager/components/CodeEditor：后者 props 为
// {content, path, forceVim, onSelectionChange, onEditorReady, ref}，没有 onChange——
// 它自行管理编辑状态、仅通过命令式句柄暴露定位能力，拿不到用户输入的内容变更。
// 记忆编辑需要受控 onChange（写回 store.dirtyContent），因此用 EditorView.updateListener
// 直接实现（task-4 brief Ruling 2 的 fallback 路径）。
//
// 主题令牌复用 CodeEditor 的 themedHighlight 与 CSS 变量主题，四主题自动适配；
// 记忆文件是 Markdown，无行号/搜索面板需求，保持最小扩展集。
import {useEffect, useRef} from 'react'
import {EditorState} from '@codemirror/state'
import {EditorView, keymap} from '@codemirror/view'
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands'
import {syntaxHighlighting} from '@codemirror/language'
import {themedHighlight} from '../../project-manager/components/CodeEditor'

const themedTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--text-primary)',
    fontSize: '13px',
    height: '100%',
  },
  '&.cm-editor .cm-scroller': {
    fontFamily: 'inherit',
    overflow: 'auto',
  },
  '&.cm-editor .cm-content': {
    padding: '12px 16px',
    caretColor: 'var(--text-primary)',
  },
  '&.cm-editor .cm-cursor': {borderLeftColor: 'var(--text-primary)'},
  '&.cm-editor .cm-selectionBackground, &.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--code-selection)',
  },
  '&.cm-editor.cm-focused': {outline: 'none'},
})

export default function MemoryEditor({
  content,
  /** 文档身份（文件路径）：仅当它变化时才重建 EditorView；content 只在挂载时作为初始 doc */
  fileKey,
  onChange,
}: {
  content: string
  fileKey?: string
  onChange?: (value: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // 回调走 ref：避免 onChange 每帧新建导致 EditorView 重建（对齐 CodeEditor 的做法）
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          syntaxHighlighting(themedHighlight),
          themedTheme,
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current?.(update.state.doc.toString())
            }
          }),
        ],
      }),
      parent: hostRef.current,
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 仅按 fileKey（文件身份）重建；content 是挂载时的初始 doc，编辑中父级不回灌
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey])

  return <div ref={hostRef} className="h-full overflow-hidden" data-testid="memory-editor-host" />
}
