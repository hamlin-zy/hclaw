/**
 * Hook 系统 - 旧系统兼容导出
 *
 * @deprecated 旧系统已弃用，请使用 src/main/plugin/hooks/ 中的新系统。
 *
 * 迁移说明：
 * - 审计日志：移至 plugin/hooks/builtin/index.ts -> getAuditLog/clearAuditLog
 * - 用户脚本：plugin/hooks/compat.ts 提供兼容层，自动注册到新系统
 * - 事件触发：统一由 plugin/hooks/executor.ts 处理
 *
 * 保留此文件是为了避免破坏现有导入。所有功能已重定向到新系统。
 */

// 重新导出审计日志（已迁移到新系统）
export { getAuditLog, clearAuditLog } from '../../plugin/hooks/builtin'

// 保留加载器导出（兼容层版本）
export { loadHooksFromDirectory } from './loader'
