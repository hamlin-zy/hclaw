// 仓库版本控件：版本下拉 + 更新红点 + 同步按钮，切换前 confirm 二次确认
import {useEffect, useState} from 'react'
import ThemedSelect from '../ThemedSelect'
import {confirm} from '../ConfirmDialog'
import {RefreshCw} from 'lucide-react'
import {useRepoUpdateStore} from '../../stores/repoUpdateStore'

interface VersionData {
  tags: string[]
  branches: string[]
  current: string
  latest: string
  loading: boolean
}

export default function RepoVersionControl({repoId, current, loading, onVersionSwitched}: {
  repoId: string
  current: string
  loading: boolean
  onVersionSwitched?: () => void
}) {
  const [versionData, setVersionData] = useState<VersionData | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [switching, setSwitching] = useState(false)
  const updateMap = useRepoUpdateStore(s => s.updateMap)

  // 挂载时自动加载版本信息，保证下拉框默认显示当前版本（而非空白）
  useEffect(() => {
    void loadVersionInfo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId])

  const loadVersionInfo = async () => {
    const api = window.electronAPI as any
    const info = await api?.repo?.getVersions?.(repoId)
    if (info) setVersionData({tags: info.tags || [], branches: info.branches || [], current: info.current || '', latest: info.latest || '', loading: false})
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      const api = window.electronAPI as any
      const info = await api?.repo?.syncVersions?.(repoId)
      if (info) setVersionData({tags: info.tags || [], branches: info.branches || [], current: info.current || '', latest: info.latest || '', loading: false})
    } finally {
      setSyncing(false)
    }
  }

  const handleSwitch = async (targetRef: string) => {
    if (!targetRef) return
    const cur = versionData?.current || current
    const confirmed = await confirm({
      title: '确认切换版本',
      message: `确定将仓库 "${repoId}" 的版本从 "${cur}" 切换为 "${targetRef}"？\n\n该操作会重新加载该仓库的所有能力。`,
      confirmText: '确定切换',
      cancelText: '取消',
      confirmVariant: 'warning',
    })
    if (!confirmed) return
    setSwitching(true)
    try {
      const api = window.electronAPI as any
      const result = await api?.repo?.switchVersion?.(repoId, targetRef)
      if (result?.success && result.versionInfo) {
        setVersionData({tags: result.versionInfo.tags || [], branches: result.versionInfo.branches || [], current: result.versionInfo.current || '', latest: result.versionInfo.latest || '', loading: false})
      }
      // 切换版本已由主进程重新加载注册能力（git checkout + powerManager.refresh）。
      // 渲染进程无技能/代理刷新推送事件，由调用方通过 onVersionSwitched 回调决定刷新内容，
      // 避免共享组件硬编码依赖某个具体 store（否则切换后其它管理页会残留旧版本数据）。
      if (result?.success) {
        onVersionSwitched?.()
      }
    } finally {
      setSwitching(false)
    }
  }

  const sel = versionData?.current || current
  const allOpts = [...(versionData?.tags || []), ...(versionData?.branches || [])]
  const selInList = allOpts.includes(sel)

  return (
    <span className="relative inline-flex items-center gap-1">
      <ThemedSelect
        value={sel}
        onChange={handleSwitch}
        disabled={switching || loading}
        ariaLabel="仓库版本"
        options={[
          ...(selInList || !sel ? [] : [{value: sel, label: sel}]),
          ...(versionData?.tags || []).map(t => ({value: t, label: t})),
          ...(versionData?.branches || []).map(b => ({value: b, label: b})),
        ]}
      />
      {updateMap[repoId] && <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-red-500" />}
      <button
        onClick={handleSync}
        disabled={syncing}
        className="px-1.5 py-1.5 text-xs font-medium rounded-md bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        data-name="repo-sync-versions-button">
        <RefreshCw className={`w-3 h-3 ${syncing ? 'animate-spin' : ''}`} />
      </button>
    </span>
  )
}
