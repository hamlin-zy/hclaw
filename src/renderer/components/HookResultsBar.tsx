import {useEffect, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useAgentStore, type HookResultItem} from '../stores/agentStore'

const HOOK_RESULT_TTL = 3_000 // 3 秒后自动销毁

/** 单个 Hook 结果通知 */
function HookNotification({item, onComplete}: { item: HookResultItem; onComplete: (id: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onComplete(item.id), HOOK_RESULT_TTL)
    return () => clearTimeout(timer)
  }, [item.id, onComplete])

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
      {/* 状态图标 */}
      {item.success ? (
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      ) : (
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      )}
      
      {/* 钩子名称 */}
      <span className="font-medium text-sm">{item.hookName}</span>
      
      {/* 分隔符 */}
      <span className="text-white/60">|</span>
      
      {/* 状态文字 */}
      <span className="text-sm">{item.success ? '成功' : '失败'}</span>
    </motion.div>
  )
}

/**
 * Hook 执行结果悬浮通知 - 显示在消息列表右上角
 * 格式：{hookName} | 成功|失败
 * 多个hook垂直堆叠显示，按会话隔离，每个通知5秒后自动销毁。
 */
export default function HookResultsBar() {
  const allHookResults = useAgentStore((s) => s.hookResults)
  const [visible, setVisible] = useState<HookResultItem[]>([])

  // 显示全部 hook 结果（不按会话过滤），只过滤最近 TTL 内的
  useEffect(() => {
    const updateVisible = () => {
      const now = Date.now()
      const recent = allHookResults.filter(
        (r) => now - r.timestamp < HOOK_RESULT_TTL
      )
      setVisible(recent)
    }

    // 立即刷新一次
    updateVisible()

    // 每秒刷新一次（清理过期项）
    const interval = setInterval(updateVisible, 1000)
    return () => clearInterval(interval)
  }, [allHookResults])

  const handleRemove = (id: string) => {
    setVisible((prev) => prev.filter((r) => r.id !== id))
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
