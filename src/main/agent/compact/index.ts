/**
 * Compact 模块导出
 */

export {
    compactWarningStore,
    suppressCompactWarning,
    clearCompactWarningSuppression,
    shouldShowCompactWarning,
    getTimeSinceLastCompact,
    type CompactResult,
} from './compactManager'

export {
    getCompactPrompt,
    getCompactUserSummaryMessage,
    createCompactBoundaryMessage,
    type CompactBoundaryMetadata,
} from './compactPrompt'

export {
    executeCompactCommand,
    createCompactedMessages,
    type CompactCommandResult,
} from './compactCommand'
