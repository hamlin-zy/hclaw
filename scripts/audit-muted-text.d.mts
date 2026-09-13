/**
 * 为 JS 审计脚本提供最小类型声明，供 TS 侧（tests/eslint-rules/auditMutedTextSync.test.ts）
 * 导入时解析，避免 TS7016（隐式 any）。仅声明被测试引用的导出。
 */
export declare const SMALL_SIZES: Set<string>
