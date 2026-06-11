/**
 * Plan 模块导出
 *
 * 提供 PLAN.md 文件管理功能
 */

export {
  PlanFileManager,
  createPlanFileManager,
  readPlan,
  writePlan,
  planExists,
  openPlanInEditor,
  deletePlan,
} from './planFileManager'

export type {
  EditorType,
  PlanReadResult,
  PlanReadError,
  PlanWriteResult,
  PlanWriteError,
  EditorOpenResult,
  EditorOpenError,
} from './planFileManager'
