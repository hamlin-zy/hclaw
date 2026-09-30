import {useEffect, type ComponentType} from 'react'
import {createPortal} from 'react-dom'
import {KbdCombo} from '../../components/common/Kbd'
import {KeyboardIcon, LayoutIcon, RemoveIcon, SplitIcon, type IconProps} from '../../components/icons'
import {GroupCard, StaticRow} from '../../components/common/ShortcutGroupCard'
import {IS_MAC} from '../../lib/platform'
import {quickOpenBindings} from '../lib/quickOpenKeymap'

const TITLE_ID = 'pm-shortcut-help-title'

type HelpRow = {label: string; keys: (string | string[])[]}
type HelpSection = {title: string; icon: ComponentType<IconProps>; rows: HelpRow[]}

/** 呼出键位取自键位表（quickOpenBindings），避免说明文案与 lib/quickOpenKeymap.ts 漂移；
    其余档位是固定行为，手写字符串。图标与设置页快捷键 Tab 同源（Keyboard/Layout 直接复用）。 */
function helpSections(): HelpSection[] {
  const bindings = quickOpenBindings(IS_MAC)
  return [
    {
      title: '呼出（PM 窗口内全局生效）',
      icon: KeyboardIcon,
      rows: [
        {label: '文件搜索', keys: bindings.quickOpenFileSearch.split('+')},
        {label: '最近文件', keys: bindings.quickOpenRecentFiles.split('+')},
        {label: '全局搜索（在文件中查找）', keys: bindings.quickOpenFindInFiles.split('+')},
      ],
    },
    {
      title: '编辑区 / 差异视图（按行选中）',
      icon: SplitIcon,
      rows: [
        {label: '全选所有行', keys: ['CommandOrControl', 'A']},
        {label: '复制所选行原文', keys: ['CommandOrControl', 'C']},
        {label: '清除行选中', keys: ['Esc']},
      ],
    },
    {
      title: '面板拖拽重排中',
      icon: LayoutIcon,
      rows: [
        {label: '取消本次重排，恢复原顺序', keys: ['Esc']},
      ],
    },
  ]
}

/**
 * PM 窗口的「快捷键说明」模态：遮罩 + 居中卡片，三路关闭（Esc / 点遮罩 / 关闭按钮）。
 *
 * 卡内三张键位卡外观与「系统设置 → 快捷键」页同源：分节即 GroupCard（卡外壳 + 图标标题条 +
 * divide-y 行容器），行即 StaticRow（右对齐键位 + hover 高亮）——两组件已下沉至
 * components/common/ShortcutGroupCard.tsx，设置页与弹窗共用同一真源。
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
          <div className="flex flex-col gap-4">
            {helpSections().map(section => (
              <GroupCard key={section.title} title={section.title} icon={section.icon}>
                {section.rows.map(row => (
                  // testid 挂包裹 div（StaticRow 是设置页共享组件，不加测试属性）
                  <div key={row.label} data-testid="pm-shortcut-help-row">
                    <StaticRow item={{label: row.label, keys: <KbdCombo keys={row.keys}/>}}/>
                  </div>
                ))}
              </GroupCard>
            ))}
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
