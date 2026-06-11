/**
 * Compact 管理器
 * 负责手动压缩的状态管理和警告控制
 *
 * 借鉴 Claude Code 的 compactWarningState 设计
 */

/** 压缩警告状态 */
interface CompactWarningState {
  suppressed: boolean
  lastCompactAt?: number
}

/**
 * 压缩警告状态 Store
 * 使用简单的内存存储，与 CC 的 createStore 模式兼容
 */
class CompactWarningStore {
  private state: CompactWarningState = {
    suppressed: false,
    lastCompactAt: undefined,
  }

  private listeners: Set<(state: CompactWarningState) => void> = new Set()

  getState(): CompactWarningState {
    return { ...this.state }
  }

  setState(updater: (state: CompactWarningState) => CompactWarningState): void {
    this.state = updater(this.state)
    this.notifyListeners()
  }

  subscribe(listener: (state: CompactWarningState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }
}

export const compactWarningStore = new CompactWarningStore()

/** 压缩结果信息 */
export interface CompactResult {
  boundaryMarker?: Message
  summary: string
  beforeTokens: number
  afterTokens: number
  savedTokens: number
  compactedMessages: number
  preservedInfo: string[]
}

/**
 * 抑制压缩警告（压缩成功后调用）
 * 在压缩成功后调用，防止立即显示阈值警告
 */
export function suppressCompactWarning(): void {
  compactWarningStore.setState(() => ({
    suppressed: true,
    lastCompactAt: Date.now(),
  }))
}

/**
 * 清除压缩警告抑制（开始新的压缩时调用）
 */
export function clearCompactWarningSuppression(): void {
  compactWarningStore.setState(() => ({
    suppressed: false,
  }))
}

/**
 * 检查是否应该显示压缩警告
 */
export function shouldShowCompactWarning(): boolean {
  return !compactWarningStore.getState().suppressed
}

/**
 * 获取距上次压缩的时间（毫秒）
 */
export function getTimeSinceLastCompact(): number | undefined {
  const state = compactWarningStore.getState()
  return state.lastCompactAt ? Date.now() - state.lastCompactAt : undefined
}

// 类型声明 - 简化版 Message
interface Message {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string
  timestamp: number
  metadata?: Record<string, unknown>
}
