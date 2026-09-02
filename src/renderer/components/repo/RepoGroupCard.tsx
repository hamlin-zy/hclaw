// 仓库分组卡片：分组容器 + 标题栏（owner/repo + 能力计数 + 版本控件 + 批处理）+ 折叠
import {useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {Folder, ChevronDown} from 'lucide-react'
import RepoVersionControl from './RepoVersionControl'

interface RepoLike {
  id: string
  name: string
  source: string
  capabilities: {skills: string[]; agents: string[]; plugins: string[]}
}

interface BatchItemLike {
  id: string
  enabled: boolean
}

export default function RepoGroupCard({repo, skillCount, agentCount, children, onToggleBatch, skills, agents, onVersionSwitched}: {
  repo: RepoLike
  skillCount: number
  agentCount: number
  children: React.ReactNode
  onToggleBatch?: (itemIds: string[], enabled: boolean) => Promise<unknown>
  skills?: BatchItemLike[]
  agents?: BatchItemLike[]
  onVersionSwitched?: () => void
}) {
  const [collapsed, setCollapsed] = useState(true)
  // 批量按钮的数据源：优先 agents（仓库 Agent 分组），否则回退到 skills（仓库技能分组）
  const hasAgents = !!agents && agents.length > 0
  const batchItems = hasAgents ? agents : (skills || [])
  const batchType = hasAgents ? 'agents' : 'skills'
  const allEnabled = batchItems.length > 0 && batchItems.every(s => s.enabled)

  return (
    <motion.div layout initial={{opacity: 0, y: -8}} animate={{opacity: 1, y: 0}} exit={{opacity: 0, y: -8}} transition={{duration: 0.15}}
      className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--surface-muted)]/50 cursor-pointer"
        onClick={() => setCollapsed(c => !c)} data-name="repo-group-card-header">
        <div className="flex items-center gap-2 min-w-0">
          <Folder className="w-4 h-4 text-[var(--brand-primary)] shrink-0"/>
          <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{repo.id}</span>
          <span className="text-[10px] text-[var(--text-muted)] shrink-0">
            {skillCount > 0 && `${skillCount} 个技能`}{skillCount > 0 && agentCount > 0 && ' · '}{agentCount > 0 && `${agentCount} 个代理`}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0" onClick={e => e.stopPropagation()}>
          {onToggleBatch && batchItems.length > 0 && (
            <button
              onClick={async () => {
                const target = !allEnabled
                const ids = batchItems.filter(s => s.enabled !== target).map(s => s.id)
                if (ids.length > 0) await onToggleBatch(ids, target)
              }}
              className="text-[10px] font-medium text-[var(--brand-primary)] hover:text-[var(--brand-primary)]/80 transition-colors"
              data-name={`${batchType}-dialog-batch-toggle-button`}>
              {allEnabled ? '全部禁用' : '全部启用'}
            </button>
          )}
          <RepoVersionControl repoId={repo.id} current="" loading={false} onVersionSwitched={onVersionSwitched}/>
          <button
            onClick={() => setCollapsed(c => !c)}
            aria-label={collapsed ? '展开分组' : '折叠分组'}
            data-name="repo-group-card-collapse-button">
            <ChevronDown className={`w-4 h-4 text-[var(--text-muted)] transition-transform duration-300 ${collapsed ? '' : 'rotate-180'}`}/>
          </button>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div initial={{opacity: 0, height: 0}} animate={{opacity: 1, height: 'auto'}} exit={{opacity: 0, height: 0}}
            transition={{duration: 0.2, ease: 'easeInOut'}} style={{overflow: 'hidden'}}>
            <div className="p-2 space-y-1.5 border-t border-[var(--border-muted)]">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
