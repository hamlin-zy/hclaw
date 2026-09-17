// 插件分组卡片（共享）：单层折叠标题栏 + 内容区，供 Skills / 命令 / Agents 三处插件列表统一复用
import type {ReactNode} from 'react'
import {motion} from 'framer-motion'
import {Folder, ChevronDown} from 'lucide-react'
import {dropdown} from '../../lib/motionPresets'
import CollapsibleSection, {collapsibleTriggerKeyDown} from './CollapsibleSection'

interface PluginGroupCardBaseProps {
  /** 分组名 */
  title: string
  /** 标题后紧跟的附属（如 CopyButton） */
  titleExtra?: ReactNode
  /** 计数文案，如 "3 个技能" */
  countLabel: ReactNode
  /** 受控折叠态 */
  collapsed: boolean
  /** 折叠切换回调 */
  onToggleCollapse: () => void
  /** 分组内是否全部启用（决定批量按钮文案） */
  allEnabled: boolean
  /** 页头 data-name（各调用方保持既有取值） */
  headerDataName: string
  children: ReactNode
}

/**
 * 批量按钮与 data-name **联动**：一旦渲染批量按钮，就必须给出它的 data-name——
 * 否则会产出无 data-name 的交互元素，违反 `tests/renderer/components/dataNameGuard.test.tsx` 约定。
 */
type PluginGroupCardProps = PluginGroupCardBaseProps &
  (
    | { onToggleBatch: () => void; batchDataName: string }
    | { onToggleBatch?: undefined; batchDataName?: undefined }
  )

/**
 * 插件分组卡片。
 * 采用**受控折叠**（`collapsed` + `onToggleCollapse`），折叠态由调用方持有。
 * 标题栏为单层 `CollapsibleSection`（自定义 trigger），不再外套 CapabilityCard。
 */
export default function PluginGroupCard(props: PluginGroupCardProps) {
  const {title, titleExtra, countLabel, collapsed, onToggleCollapse, allEnabled, headerDataName, children} = props
  const {onToggleBatch, batchDataName} = props

  return (
    <motion.div
      layout
      {...dropdown}
      transition={{duration: 0.15}}
      className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden"
    >
      {/* trigger 模式下 CollapsibleSection 不再接线 onToggle：点击/键盘由下方 trigger 自行负责 */}
      <CollapsibleSection
        title={title}
        expanded={!collapsed}
        noMargin
        trigger={
          <div
            className="flex items-center justify-between px-3 py-2 bg-[color-mix(in_srgb,var(--surface-muted)_50%,transparent)] cursor-pointer select-none"
            role="button"
            tabIndex={0}
            onClick={onToggleCollapse}
            onKeyDown={collapsibleTriggerKeyDown(onToggleCollapse)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展开分组' : '折叠分组'}
            data-name={headerDataName}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Folder className="w-4 h-4 [color:var(--brand-primary)] shrink-0" />
              <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{title}</span>
              {titleExtra}
              <span className="text-[10px] text-[var(--text-muted)] shrink-0">{countLabel}</span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {onToggleBatch && (
                <button
                  onClick={e => {
                    e.stopPropagation()
                    onToggleBatch()
                  }}
                  className="text-[10px] font-medium text-[var(--text-brand)] hover:text-[color-mix(in_srgb,var(--brand-primary)_80%,transparent)] transition-colors"
                  data-name={batchDataName}
                >
                  {allEnabled ? '全部禁用' : '全部启用'}
                </button>
              )}
              <ChevronDown
                className={`w-4 h-4 text-[var(--text-muted)] transition-transform duration-300 ${collapsed ? '' : 'rotate-180'}`}
              />
            </div>
          </div>
        }
      >
        {children}
      </CollapsibleSection>
    </motion.div>
  )
}
