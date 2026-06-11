/**
 * Agent 加载错误收集器
 *
 * 在 Agent 扫描过程中捕获并累积解析错误，
 * 通过 IPC 传递给前端展示给用户。
 */

import {createLoadErrorCollector} from './loadErrorCollector'

// ─── 类型 ─────────────────────────────────────────────

export interface AgentLoadError {
  /** 文件路径 */
  filePath: string
  /** Agent 名称（如果能从文件名推断） */
  agentName?: string
  /** 错误描述 */
  error: string
  /** 错误发生时间戳 */
  timestamp: number
}

// ─── 收集器 ─────────────────────────────────────────

const collector = createLoadErrorCollector<AgentLoadError>()

/** 添加一个 Agent 加载错误 */
export const addAgentLoadError = (filePath: string, error: string, agentName?: string): void =>
    collector.add({filePath, error, agentName})

/** 获取并清空所有累积的错误 */
export const getAndClearAgentLoadErrors = collector.getAndClear

/** 清空旧错误数据 */
export const resetAgentLoadErrors = collector.reset
