import {useEffect, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useAgentStore, type HookResultItem} from '../stores/agentStore'

const HOOK_RESULT_TTL = 3_000 // 3 秒后自动销毁

/** 单个 Hook 结果通知 */
function HookNotification({item, onComplete}: { item: HookResultItem; onComplete: (id: string) => void }) {
  const isPinned = item.pinned ?? false

  // 固定通知不设自动关闭定时器，需用户手动关闭
  useEffect(() => {
    if (isPinned) return
    const timer = setTimeout(() => onComplete(item.id), HOOK_RESULT_TTL)
    return () => clearTimeout(timer)
  }, [item.id, isPinned, onComplete])

  return (
    <motion.div
      initial={{opacity: 0, x: 50, scale: 0.9}}
      animate={{opacity: 1, x: 0, scale: 1}}
      exit={{opacity: 0, x: 50, scale: 0.9, transition: {duration: 0.2}}}
      className={`flex items-center gap-2 px-2 py-1 rounded-lg border shadow-lg backdrop-blur-sm ${
        item.success
          ? 'bg-emerald-500/90 border-emerald-400 text-white'
          : 'bg-red-500/90 border-red-400 text-white'
      }`}
    >
      {/* 状态图标 —— 成功用 ✓，失败用 ⚠️（避免与右侧关闭按钮的 × 视觉混淆） */}
      {item.success ? (
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      ) : (
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      )}

      {/* 通用通知消息（如 max_tokens 截断提示）；无 message 时回退为 hookName | 状态 */}
      {item.message ? (
        <span className="text-sm leading-snug max-w-[300px] whitespace-pre-wrap">{item.message}</span>
      ) : (
        <>
          {/* 钩子名称 */}
          <span className="font-medium text-sm">{item.hookName}</span>

          {/* 分隔符 */}
          <span className="text-white/60">|</span>

          {/* 状态文字 */}
          <span className="text-sm">{item.success ? '成功' : '失败'}</span>
        </>
      )}

      {/* 手动关闭按钮（仅固定通知显示）。
          - 显式 pointer-events-auto：外层容器 pointer-events-none 不会屏蔽按钮点击
          - 带圆底 + hover 高亮，视觉上明显可点击，区别于左侧状态图标
      */}
      {isPinned && (
        <button
          onClick={() => onComplete(item.id)}
          title="关闭并取消固定"
          className="shrink-0 ml-1 p-1 rounded-full bg-black/20 hover:bg-black/40 hover:scale-110 transition-all pointer-events-auto"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      )}
    </motion.div>
  )
}

/**
 * Hook 执行结果悬浮通知 - 显示在消息列表右上角
 * 格式：{hookName} | 成功|失败
 * 多个hook垂直堆叠显示。
 * - 普通通知：3 秒后自动消失
 * - 固定通知（pinned: true，如 max_tokens 截断提示）：常驻显示，需用户手动关闭
 */
export default function HookResultsBar() {
  const allHookResults = useAgentStore((s) => s.hookResults)
  const [visible, setVisible] = useState<HookResultItem[]>([])

  // 显示全部 hook 结果：
  //   - pinned 项：始终显示（不随 TTL 过期）
  //   - 非 pinned 项：仅 TTL 内的显示
  useEffect(() => {
    const updateVisible = () => {
      const now = Date.now()
      const recent = allHookResults.filter(
        (r) => (r.pinned ?? false) || now - r.timestamp < HOOK_RESULT_TTL
      )
      setVisible(recent)
    }

    updateVisible()
    const interval = setInterval(updateVisible, 1000)
    return () => clearInterval(interval)
  }, [allHookResults])

  const handleRemove = (id: string) => {
    // 从 store 中彻底删除该通知（同时清除 pinned 标记），
    // 否则仅从 visible 过滤后，store 里仍保留该条且 pinned 标记仍在，
    // 下次刷新会再次显示 → 关闭后又弹回。删除后上面的 effect 会同步重算 visible。
    useAgentStore.getState().removeHookResult(id)
  }

  if (visible.length === 0) return null

  return (
    <div className="fixed top-16 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence mode="popLayout">
        {visible.map((item) => (
          <HookNotification key={item.id} item={item} onComplete={handleRemove}/>
        ))}
      </AnimatePresence>
    </div>
  )
}
