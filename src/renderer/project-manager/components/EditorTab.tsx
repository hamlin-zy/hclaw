import {useState} from 'react'
import {useEditorTabStore, type EditorTabState} from '../stores/editorTabStore'
import {ContextMenu, type ContextMenuItem} from '../ui/ContextMenu'

/**
 * 单个编辑器 tab（spec §11.4）：文件 tab 普通样式、diff tab 标题走 --brand-primary、
 * 激活态三边描边与卡片连通。视觉全部走 globals.css 的 .pm-tab* 类，组件不写内联样式。
 *
 * 右键菜单复用 ui/ContextMenu（spec §13.6）：fixed 定位用视口坐标 clientX/clientY。
 */
export function EditorTab({tab}: {tab: EditorTabState}) {
  const {activeTabId, setActive, closeTab, closeOther, closeAll, closeLeft, closeRight, pin} = useEditorTabStore()
  const [menu, setMenu] = useState<{x: number, y: number} | null>(null)
  const active = activeTabId === tab.id

  const items: ContextMenuItem[] = [
    {label: '置顶', onClick: () => pin(tab.id)},
    {label: '关闭', onClick: () => closeTab(tab.id)},
    {label: '关闭其他', onClick: () => closeOther(tab.id)},
    {label: '关闭全部', onClick: () => closeAll()},
    {label: '关闭左侧标签', onClick: () => closeLeft(tab.id)},
    {label: '关闭右侧标签', onClick: () => closeRight(tab.id)},
  ]

  const className = [
    'pm-tab',
    active && 'is-active',
    tab.type === 'diff' && 'is-diff',
  ].filter(Boolean).join(' ')

  return (
    <>
      {/* data-testid 必须留在可点击的 tab 根元素上：EditorArea.test 靠 click 它激活 */}
      {/* data-tab-id 供 EditorArea 把激活 tab 滚入可视区：title 可能重复/含特殊字符，不能拿来定位 */}
      <div
        className={className}
        role="tab"
        aria-selected={active}
        data-tab-id={tab.id}
        data-testid={`editor-tab-${tab.title}`}
        onClick={() => setActive(tab.id)}
        onContextMenu={e => { e.preventDefault(); setMenu({x: e.clientX, y: e.clientY}) }}
      >
        <span className="pm-tab-title">
          {tab.pinned ? '📌 ' : ''}{tab.statusBadge ? `[${tab.statusBadge}] ` : ''}{tab.title}
        </span>
        <button
          type="button"
          className="pm-tab-close"
          aria-label={`close-tab-${tab.title}`}
          onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
        >×</button>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  )
}
