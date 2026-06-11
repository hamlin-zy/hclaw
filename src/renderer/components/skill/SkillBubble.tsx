/**
 * 技能气泡组件
 * 
 * 展示技能执行状态、进度、日志和结果。
 */

import React, {memo, useEffect, useRef, useState} from 'react'

// ─── 类型定义 ─────────────────────────────────────────

interface SkillLogEntry {
  timestamp: number
  type: 'info' | 'warn' | 'error' | 'output' | 'debug'
  message: string
  data?: unknown
}

interface SkillScriptState {
  name: string
  status: 'pending' | 'running' | 'done' | 'error'
  output?: string
  error?: string
}

interface SkillReferenceState {
  loaded: string[]
  pending?: string[]
}

interface SkillResult {
  type: 'inline' | 'script_output' | 'reference'
  content: string
}

interface SkillError {
  phase: string
  message: string
}

interface SkillBubbleProps {
  /** 技能名称 */
  skillName: string
  /** 执行状态 */
  status: 'matched' | 'loading' | 'executing' | 'done' | 'error'
  /** 当前阶段 */
  phase?: string
  /** 当前步骤描述 */
  currentStep?: string
  /** 进度信息 */
  progress?: { current: number; total: number; label?: string }
  /** 引用加载状态 */
  references?: SkillReferenceState
  /** 脚本执行状态 */
  script?: SkillScriptState
  /** 日志列表 */
  logs?: SkillLogEntry[]
  /** 执行结果 */
  result?: SkillResult
  /** 错误信息 */
  error?: SkillError
  /** 开始时间 */
  startTime?: number
  /** 结束时间 */
  endTime?: number
  /** 初始展开状态 */
  defaultExpanded?: boolean
  /** 展开状态变更回调 */
  onExpandToggle?: (expanded: boolean) => void
}

// ─── 样式 ──────────────────────────────────────────────

const STYLES = {
  container: {
    borderRadius: 12,
    overflow: 'hidden',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    marginBottom: 12,
  },
  statusColors: {
    matched: '#6366f1',
    loading: '#f59e0b',
    executing: '#3b82f6',
    done: '#10b981',
    error: '#ef4444',
  },
}

// ─── 主组件 ──────────────────────────────────────────────

export const SkillBubble = memo(function SkillBubble({
  skillName,
  status,
  phase,
  currentStep,
  progress,
  references,
  script,
  logs = [],
  result,
  error,
  startTime,
  endTime,
  defaultExpanded = true,
  onExpandToggle,
}: SkillBubbleProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [logsExpanded, setLogsExpanded] = useState(false)
  const logContainerRef = useRef<HTMLDivElement>(null)

  const handleToggle = () => {
    const newExpanded = !expanded
    setExpanded(newExpanded)
    onExpandToggle?.(newExpanded)
  }

  // 自动滚动日志
  useEffect(() => {
    if (logContainerRef.current && expanded && logsExpanded) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
    }
  }, [logs, expanded, logsExpanded])

  const statusConfig = getStatusConfig(status)
  const borderColor = STYLES.statusColors[status] || '#e2e8f0'

  return (
    <div style={{
      ...STYLES.container,
      border: `1px solid ${borderColor}`,
      boxShadow: status === 'executing' ? `0 0 0 2px ${borderColor}20` : 'none',
      background: '#f8fafc',
    }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 16px',
          background: '#f1f5f9',
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={handleToggle}
      >
        <span style={{fontSize: 18}}>🔧</span>
        <span style={{flex: 1, fontWeight: 600, color: '#1e293b'}}>
          {skillName}
        </span>
        <StatusBadge status={status} config={statusConfig} />
        <ChevronIcon expanded={expanded} />
      </div>

      {/* Content */}
      {expanded && (
        <div style={{padding: 16}}>
          {/* Phase & Progress */}
          <PhaseSection
            phase={phase}
            currentStep={currentStep}
            progress={progress}
            status={status}
          />

          {/* References */}
          {references && <ReferencesSection references={references} />}

          {/* Script Status */}
          {script && <ScriptSection script={script} />}

          {/* Logs */}
          {logs.length > 0 && (
            <LogsSection
              logs={logs}
              expanded={logsExpanded}
              onToggle={() => setLogsExpanded(!logsExpanded)}
              containerRef={logContainerRef}
            />
          )}

          {/* Result */}
          {result && <ResultSection result={result} />}

          {/* Error */}
          {error && <ErrorSection error={error} />}

          {/* Execution Time */}
          {startTime && (
            <ExecutionTime startTime={startTime} endTime={endTime} status={status} />
          )}
        </div>
      )}

      {/* Collapsed Summary */}
      {!expanded && (
        <CollapsedSummary
          status={status}
          progress={progress}
          result={result}
          error={error}
        />
      )}
    </div>
  )
})

// ─── 子组件 ──────────────────────────────────────────────

function StatusBadge({status, config}: {status: string; config: ReturnType<typeof getStatusConfig>}) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 8px',
      borderRadius: 12,
      fontSize: 12,
      fontWeight: 500,
      color: 'white',
      background: config.bgColor,
    }}>
      <span>{config.icon}</span>
      <span>{config.label}</span>
    </span>
  )
}

function ChevronIcon({expanded}: {expanded: boolean}) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      style={{transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s'}}
    >
      <path d="M4 6L8 10L12 6" stroke="#64748b" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function PhaseSection({
  phase,
  currentStep,
  progress,
  status,
}: {
  phase?: string
  currentStep?: string
  progress?: { current: number; total: number; label?: string }
  status: string
}) {
  if (!progress && !currentStep) return null

  return (
    <div style={{marginBottom: 12}}>
      {/* Current Step */}
      {currentStep && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
          fontSize: 14,
          color: '#475569',
        }}>
          {status === 'executing' && <Spinner />}
          <span>{currentStep}</span>
        </div>
      )}

      {/* Progress Bar */}
      {progress && (
        <div>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginBottom: 4,
            fontSize: 12,
            color: '#64748b',
          }}>
            <span>{progress.label || '进度'}</span>
            <span>{progress.current}/{progress.total}</span>
          </div>
          <div style={{
            height: 4,
            background: '#e2e8f0',
            borderRadius: 2,
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${(progress.current / progress.total) * 100}%`,
              background: 'linear-gradient(90deg, #3b82f6, #60a5fa)',
              borderRadius: 2,
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      )}
    </div>
  )
}

function ReferencesSection({references}: {references: SkillReferenceState}) {
  return (
    <div style={{marginBottom: 12}}>
      <div style={{fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 8}}>
        📚 参考文档
      </div>
      <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
        {references.loaded.map(ref => (
          <ReferenceTag key={ref} name={ref} status="loaded" />
        ))}
        {references.pending?.map(ref => (
          <ReferenceTag key={ref} name={ref} status="pending" />
        ))}
      </div>
    </div>
  )
}

function ReferenceTag({name, status}: {name: string; status: 'loaded' | 'pending'}) {
  const config = status === 'loaded'
    ? {bg: '#dcfce7', color: '#166534', icon: '✅'}
    : {bg: '#fef3c7', color: '#92400e', icon: '⏳'}

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 8px',
      borderRadius: 6,
      fontSize: 12,
      background: config.bg,
      color: config.color,
    }}>
      <span>{config.icon}</span>
      <span>{name}</span>
    </span>
  )
}

function ScriptSection({script}: {script: SkillScriptState}) {
  const statusIcon = script.status === 'running' ? '🔄'
    : script.status === 'done' ? '✅'
    : script.status === 'error' ? '❌' : '⏸️'

  return (
    <div style={{
      marginBottom: 12,
      padding: 12,
      background: '#1e293b',
      borderRadius: 8,
      fontFamily: 'monospace',
      fontSize: 12,
      color: '#e2e8f0',
    }}>
      <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
        <span>{statusIcon}</span>
        <span>执行: {script.name}</span>
        {script.status === 'running' && <Spinner />}
      </div>
      {script.output && (
        <pre style={{
          margin: '8px 0 0',
          padding: 8,
          background: '#0f172a',
          borderRadius: 4,
          overflow: 'auto',
          maxHeight: 200,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}>
          {script.output}
        </pre>
      )}
      {script.error && (
        <div style={{marginTop: 8, color: '#f87171'}}>
          错误: {script.error}
        </div>
      )}
    </div>
  )
}

function LogsSection({
  logs,
  expanded,
  onToggle,
  containerRef,
}: {
  logs: SkillLogEntry[]
  expanded: boolean
  onToggle: () => void
    containerRef: React.RefObject<HTMLDivElement | null>
}) {
  const iconMap: Record<string, string> = {info: 'ℹ️', warn: '⚠️', error: '❌', output: '📤', debug: '🔍'}
  const colorMap: Record<string, string> = {
    info: '#3b82f6',
    warn: '#f59e0b',
    error: '#ef4444',
    output: '#10b981',
    debug: '#64748b',
  }

  return (
    <div style={{marginBottom: 12}}>
      <button
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 0',
          border: 'none',
          background: 'none',
          fontSize: 13,
          fontWeight: 500,
          color: '#475569',
          cursor: 'pointer',
        }}
      >
        📋 执行日志 ({logs.length})
        <ChevronIcon expanded={expanded} />
      </button>

      {expanded && (
        <div
          ref={containerRef}
          style={{
            maxHeight: 200,
            overflow: 'auto',
            padding: 12,
            background: '#1e293b',
            borderRadius: 8,
            fontFamily: 'monospace',
            fontSize: 12,
          }}
        >
          {logs.map((log, i) => (
            <div key={i} style={{display: 'flex', gap: 8, marginBottom: 4}}>
              <span style={{color: '#64748b', flexShrink: 0}}>
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              <span style={{color: colorMap[log.type] || '#e2e8f0', flexShrink: 0}}>
                {iconMap[log.type] || '•'}
              </span>
              <span style={{color: '#e2e8f0', wordBreak: 'break-all'}}>
                {log.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ResultSection({result}: {result: SkillResult}) {
  return (
    <div style={{
      padding: 12,
      background: '#f0fdf4',
      borderRadius: 8,
      border: '1px solid #bbf7d0',
    }}>
      <div style={{fontSize: 13, fontWeight: 600, color: '#166534', marginBottom: 8}}>
        📊 执行结果
      </div>
      <div
        style={{fontSize: 14, color: '#1e293b', whiteSpace: 'pre-wrap'}}
        dangerouslySetInnerHTML={{__html: formatContent(result.content)}}
      />
    </div>
  )
}

function ErrorSection({error}: {error: SkillError}) {
  return (
    <div style={{
      padding: 12,
      background: '#fef2f2',
      borderRadius: 8,
      border: '1px solid #fecaca',
    }}>
      <div style={{display: 'flex', alignItems: 'center', gap: 8, color: '#dc2626'}}>
        <span>❌</span>
        <span style={{fontWeight: 600}}>{error.phase}</span>
      </div>
      <div style={{marginTop: 8, fontSize: 14, color: '#7f1d1d'}}>
        {error.message}
      </div>
    </div>
  )
}

function ExecutionTime({
  startTime,
  endTime,
  status,
}: {
  startTime: number
  endTime?: number
  status: string
}) {
  const duration = endTime ? endTime - startTime : Date.now() - startTime
  const seconds = Math.round(duration / 1000)
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60

  const timeStr = minutes > 0
    ? `${minutes}m ${remainingSeconds}s`
    : `${seconds}s`

  return (
    <div style={{
      marginTop: 12,
      padding: '8px 12px',
      background: '#f1f5f9',
      borderRadius: 6,
      fontSize: 12,
      color: '#64748b',
      display: 'flex',
      justifyContent: 'space-between',
    }}>
      <span>⏱️ 执行时间</span>
      <span style={{fontFamily: 'monospace'}}>
        {timeStr}
        {status === 'executing' && ' (进行中)'}
      </span>
    </div>
  )
}

function CollapsedSummary({
  status,
  progress,
  result,
  error,
}: {
  status: string
  progress?: { current: number; total: number; label?: string }
  result?: SkillResult
  error?: SkillError
}) {
  let text = ''

  if (status === 'done' && result) {
    text = `✅ ${result.type === 'script_output' ? '脚本执行完成' : '技能执行完成'}`
  } else if (status === 'error' && error) {
    text = `❌ ${error.message}`
  } else if (progress) {
    text = `⚡ ${progress.label || '执行中'}: ${progress.current}/${progress.total}`
  } else {
    text = `⏳ ${status}`
  }

  return (
    <div style={{
      padding: '8px 16px',
      fontSize: 13,
      color: '#64748b',
      background: '#f8fafc',
    }}>
      {text}
    </div>
  )
}

// ─── 辅助组件 ──────────────────────────────────────────────

function Spinner() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      style={{animation: 'spin 1s linear infinite', flexShrink: 0}}
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" opacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </svg>
  )
}

// ─── 辅助函数 ──────────────────────────────────────────────

const STATUS_CONFIGS: Record<string, {icon: string; label: string; bgColor: string}> = {
  matched:   {icon: '🎯', label: '已匹配',   bgColor: '#6366f1'},
  loading:   {icon: '⏳', label: '加载中',   bgColor: '#f59e0b'},
  executing: {icon: '⚡', label: '执行中',   bgColor: '#3b82f6'},
  done:      {icon: '✅', label: '完成',      bgColor: '#10b981'},
  error:     {icon: '❌', label: '错误',      bgColor: '#ef4444'},
}

function getStatusConfig(status: string): {icon: string; label: string; bgColor: string} {
  return STATUS_CONFIGS[status] || {icon: '•', label: status, bgColor: '#64748b'}
}

function formatContent(content: string): string {
  return content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

// ─── 导出类型 ──────────────────────────────────────────────

export type {SkillBubbleProps, SkillLogEntry, SkillScriptState, SkillReferenceState, SkillResult, SkillError}
