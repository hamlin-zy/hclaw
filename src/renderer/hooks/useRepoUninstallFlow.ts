import {useCallback} from 'react'
import {confirm} from '../components/ConfirmDialog'
import {useRepoUpdateStore} from '../stores/repoUpdateStore'

/** 仓库安装/卸载消息 toast 的统一形态 */
export type RepoMessage = {type: 'success' | 'error'; text: string}

/**
 * 自动隐藏定时器记账 helper：先清旧定时器，再起一个 ms 后把 message 置空的定时器，
 * 并把 timer ref 指向新定时器。覆盖所有 `if (xxx.current) clearTimeout(xxx.current);
 * xxx.current = setTimeout(() => { xxx.current = null; setXxx(null) }, 3000)` 同形调用点。
 */
export function scheduleAutoHide(
  timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
  setMessage: (msg: null) => void,
  ms: number = 3000,
): void {
  if (timerRef.current) clearTimeout(timerRef.current)
  timerRef.current = setTimeout(() => {
    timerRef.current = null
    setMessage(null)
  }, ms)
}

/**
 * 卸载仓库的统一流程 hook：二次确认 → IPC → toast → 三重刷新。
 *
 * 两对话框（AgentsDialog / SkillsDialog）的 `handleUninstallRepo` 逻辑同构，差异仅在：
 * 1. 确认弹窗的 message 文案 / 计数参数（调用方通过 `buildConfirmMessage(repo, ...extra)` 注入，
 *    extra 透传调用方在 onUninstall 处封装的计数，如 AgentsDialog 的 `(agentCount, skillCount)`、
 *    SkillsDialog 的 `(skillCount)`）
 * 2. 成功后第一重刷新方法（`syncFromDisk` vs `refreshSkills`，通过 `onSuccess` 注入）
 * 3. message state / ref 命名（`repoMessage` vs `installMessage`，调用方仍持有，本 hook 接收 setter + ref）
 *
 * 失败语义与原两份实现一致：confirm 之外的任何失败都收敛为 toast 并正常 resolve，
 * 绝不外抛（外抛会变成 unhandled rejection）；三重刷新每步独立 try/catch 兜底。
 */
export interface UseRepoUninstallFlowArgs<TExtra extends unknown[] = []> {
  /** message toast 的 setter（与 timer ref 配套，由调用方持有 state） */
  setMessage: (msg: RepoMessage | null) => void
  /** message 自动隐藏定时器 ref（与 setMessage 配套，由调用方持有 ref） */
  timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
  /** 构造确认弹窗的 message 文案（含仓库路径与计数说明）；extra 透传调用方传入的计数 */
  buildConfirmMessage: (repo: any, ...extra: TExtra) => string
  /** 成功后第一重刷新（代理列表 syncFromDisk / 技能列表 refreshSkills） */
  onSuccess: () => unknown | Promise<unknown>
  /** 第二重刷新：仓库分组与徽标（repo:list） */
  refreshRepoList: () => unknown | Promise<unknown>
}

export function useRepoUninstallFlow<TExtra extends unknown[] = []>(
  args: UseRepoUninstallFlowArgs<TExtra>,
): (repo: any, ...extra: TExtra) => Promise<void> {
  const {setMessage, timerRef, buildConfirmMessage, onSuccess, refreshRepoList} = args
  return useCallback(async (repo: any, ...extra: TExtra) => {
    const confirmed = await confirm({
      title: '确认卸载仓库',
      message: buildConfirmMessage(repo, ...extra),
      confirmText: '卸载',
      cancelText: '取消',
      confirmVariant: 'danger',
    })
    if (!confirmed) return
    try {
      const result = await (window.electronAPI as any)?.repo?.uninstall?.(repo.id)
      if (!result?.success) {
        // 错误消息不清除，避免用户尚未读完即消失（对齐安装失败的处理）
        setMessage({type: 'error', text: `卸载失败: ${result?.error || '未知错误'}`})
        return
      }
      const warnings: string[] = Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : []
      if (warnings.length > 0) {
        setMessage({type: 'error', text: `已卸载，但存在告警：${warnings.join('；')}`})
      } else {
        setMessage({type: 'success', text: `仓库已卸载: ${repo.id}`})
        scheduleAutoHide(timerRef, setMessage, 3000)
      }
    } catch (e: any) {
      setMessage({type: 'error', text: `卸载失败: ${e?.message || '未知错误'}`})
      return
    }
    // 三重刷新：本窗口列表 + 仓库分组/「已禁用」徽标（repo:list）+ 红点元数据（版本 meta）。
    // 每步独立兜住失败：既不因一步异常吞掉后续刷新，也保证本函数永不外抛（含同步抛错）。
    try { await onSuccess() } catch { /* 刷新失败不影响已完成的卸载 */ }
    try { await refreshRepoList() } catch { /* 同上 */ }
    void useRepoUpdateStore.getState().refreshFromCache()
  }, [setMessage, timerRef, buildConfirmMessage, onSuccess, refreshRepoList])
}
