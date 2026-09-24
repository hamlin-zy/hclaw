import {useEffect} from 'react'
import {createPortal} from 'react-dom'
import {KbdCombo} from '../../components/common/Kbd'
import {RemoveIcon} from '../../components/icons'
import {IS_MAC} from '../../lib/platform'
import {quickOpenBindings} from '../lib/quickOpenKeymap'

const TITLE_ID = 'pm-shortcut-help-title'

type HelpRow = {label: string; keys: (string | string[])[]}
type HelpSection = {title: string; rows: HelpRow[]}

/** 呼出键位取自键位表（quickOpenBindings），避免说明文案与 lib/quickOpenKeymap.ts 漂移；
    其余档位是固定行为，手写字符串。 */
function helpSections(): HelpSection[] {
  const bindings = quickOpenBindings(IS_MAC)
  return [
    {
      title: '呼出（PM 窗口内全局生效）',
      rows: [
        {label: '文件搜索', keys: bindings.quickOpenFileSearch.split('+')},
        {label: '最近文件', keys: bindings.quickOpenRecentFiles.split('+')},
        {label: '全局搜索（在文件中查找）', keys: bindings.quickOpenFindInFiles.split('+')},
      ],
    },
    {
      title: 'QuickOpen 浮层内',
      rows: [
        {label: '移动选中项', keys: [['Up', 'Down']]},
        {label: '打开选中项', keys: ['Enter']},
        {label: '关闭浮层', keys: ['Esc']},
      ],
    },
    {
      title: '编辑区 / 差异视图（按行选中）',
      rows: [
        {label: '全选所有行', keys: ['CommandOrControl', 'A']},
        {label: '复制所选行原文', keys: ['CommandOrControl', 'C']},
        {label: '清除行选中', keys: ['Esc']},
      ],
    },
    {
      title: '面板拖拽重排中',
      rows: [
        {label: '取消本次重排，恢复原顺序', keys: ['Esc']},
      ],
    },
  ]
}

/**
 * PM 窗口的「快捷键说明」模态：遮罩 + 居中卡片，三路关闭（Esc / 点遮罩 / 关闭按钮）。
 *
 * `open === false` 时返回 null（不渲染任何 DOM）；弹窗用 createPortal 挂到 body，
 * 避免被 .pm-canvas 的 overflow 裁剪与层级意外。Esc 监听仅在 open 期间存在，卸载即解绑。
 */
export function ShortcutHelpDialog({open, onClose}: {open: boolean; onClose: () => void}) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[100001] bg-black/40"
        onClick={onClose}
        data-testid="pm-shortcut-help-backdrop"
      />
      {/* 容器只负责居中，pointer-events-none 让点击穿透到遮罩；卡片自身恢复 auto */}
      <div className="fixed inset-0 z-[100001] flex items-center justify-center pointer-events-none">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={TITLE_ID}
          data-testid="pm-shortcut-help"
          className="pointer-events-auto flex flex-col gap-3 w-[420px] max-w-[90vw] max-h-[80vh] overflow-y-auto
                     p-4 rounded-[8px] bg-[var(--surface-elevated)] border border-[var(--border)]
                     shadow-[var(--shadow-overlay)] select-text"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 id={TITLE_ID} className="text-[13px] font-semibold text-[var(--text-primary)]">快捷键说明</h2>
            <button
              type="button"
              aria-label="关闭"
              onClick={onClose}
              className="shrink-0 flex items-center justify-center w-[18px] h-[18px] rounded-[4px]
                         text-[var(--text-muted)] hover:text-[var(--text-primary)]
                         hover:bg-[var(--surface-muted)] cursor-pointer"
            >
              <RemoveIcon className="w-3.5 h-3.5"/>
            </button>
          </div>
          {helpSections().map(section => (
            <section key={section.title} className="flex flex-col gap-1">
              <h3 className="text-[11px] font-semibold text-[var(--text-secondary)]">{section.title}</h3>
              <div className="flex flex-col">
                {section.rows.map(row => (
                  <div
                    key={row.label}
                    data-testid="pm-shortcut-help-row"
                    className="flex items-center justify-between gap-3 py-1"
                  >
                    <span className="text-[12px] text-[var(--text-primary)]">{row.label}</span>
                    <span className="shrink-0 flex items-center"><KbdCombo keys={row.keys}/></span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>,
    document.body,
  )
}
