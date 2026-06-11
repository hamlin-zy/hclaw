/**
 * AgentManager — 重导出模块
 *
 * 将实现拆分到多个文件以保持单文件行数可控：
 * - manager.impl.ts: 核心实现
 * - manager.types.ts: 类型定义
 * - manager.constants.ts: 常量定义
 * - manager.accumulator.ts: 流事件累积器
 * - manager.persister.ts: 消息持久化器
 * - manager.backup.ts: 消息备份工具
 * - manager.pluginAgents.ts: 插件 Agent 加载器
 */

export {agentManager, AgentManager} from './manager.impl'
export type {AgentStartParams} from './manager.types'