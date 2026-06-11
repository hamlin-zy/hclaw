import {useEffect} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useFileChangeStore} from '../stores/fileChangeStore'

export default function DiffModal() {
  const { diffModalOpen, selectedFileChange, closeDiffModal } = useFileChangeStore()

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDiffModal()
    }
    if (diffModalOpen) document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [diffModalOpen, closeDiffModal])

  return (
    <AnimatePresence>
      {diffModalOpen && selectedFileChange && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[var(--z-overlay)]"
            onClick={closeDiffModal}
          />
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="fixed inset-6 bg-[var(--surface)] rounded-xl shadow-elevated flex flex-col overflow-hidden z-[var(--z-modal)]"
          >
            {/* Header */}
              <div className="h-11 px-4 flex items-center justify-between border-b border-[var(--border)] shrink-0">
              <div className="flex items-center gap-2">
                <StatusBadge status={selectedFileChange.status} />
                  <span className="text-sm font-mono text-[var(--text-primary)]">{selectedFileChange.filePath}</span>
                  <span className="text-xs text-[var(--success)]">+{selectedFileChange.additions}</span>
                  <span className="text-xs text-[var(--error)]">-{selectedFileChange.deletions}</span>
              </div>
                  <button onClick={closeDiffModal}
                          className="w-7 h-7 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]"
                          aria-label="关闭">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>

            {/* Diff content */}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
      added: {label: '新增', className: 'bg-[var(--success)]/10 text-[var(--success)]'},
      modified: {label: '修改', className: 'bg-[var(--warning)]/10 text-[var(--warning)]'},
      deleted: {label: '删除', className: 'bg-[var(--error)]/10 text-[var(--error)]'},
      renamed: {label: '重命名', className: 'bg-[var(--info)]/10 text-[var(--info)]'},
  }
  const { label, className } = config[status] || config.modified
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${className}`}>{label}</span>
}
