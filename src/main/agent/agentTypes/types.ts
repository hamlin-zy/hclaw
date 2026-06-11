/**
 * Agent 类型系统
 *
 * 参考 cc_src 的 built-in agents 设计
 * 引入 Agent 类型以支持：
 * - 专门的提示词模板
 * - 工具限制
 * - Token 优化
 * - 按类型选择模型
 */

export {type HClawAgentType, type AgentTypeConfig} from '@shared/types'
