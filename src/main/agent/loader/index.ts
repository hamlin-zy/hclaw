/**
 * Agent 加载器主模块
 * 加载 User Agents
 */

import type {AgentLoadResult} from '@shared/agent'
import {loadUserAgents} from './user'

/**
 * 加载所有 Agent 定义
 */
export async function loadAgents(): Promise<AgentLoadResult> {
  try {
    // 加载 User Agents
    const { agents: userAgents, failedFiles } = await loadUserAgents()

    return {
        allAgents: userAgents,
        activeAgents: userAgents,
      failedFiles: failedFiles.length > 0 ? failedFiles : undefined,
    }
  } catch (error) {
    return {
        allAgents: [],
        activeAgents: [],
      failedFiles: [{ path: 'unknown', error: String(error) }],
    }
  }
}

/**
 * 清除 Agent 加载缓存（如果使用了 memoize）
 */
export function clearAgentCache(): void {
  // 如果使用了 memoize，在这里清除缓存
}
