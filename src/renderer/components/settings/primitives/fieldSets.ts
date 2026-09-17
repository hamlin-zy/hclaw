import type {FieldPath} from '../../../stores/settingsStore'

/** 各页面「恢复本页默认」的字段集（spec §5.1；跨页字段归属见各 Tab 任务） */
export const PAGE_FIELD_SETS = {
    general: ['linkOpening.mode', 'fullSkillDescriptions', 'agent.defaultPermissionMode', 'agent.defaultDisplayMode'],
    appearance: ['ui.theme', 'ui.background'],
    agent: [
        'agent.maxTurns', 'agent.retryCount', 'agent.initialRetryDelay', 'agent.maxRetryDelay', 'agent.llmTimeout',
        'agent.handoffThresholdRatio', 'agent.handoffThresholdMode', 'agent.handoffThresholdTokens',
        'agent.midLoopOverflowMode', 'agent.loopDetection',
        'subagent.maxConcurrency', 'subagent.maxDepth',
    ],
    model: ['model.defaultMaxTokens', 'model.defaultTemperature', 'model.imageCompressQuality'],
    channels: ['channels.sendGreeting', 'channels.connectionTimeout'],
    shortcuts: ['shortcuts.overrides'],
} as const satisfies Record<string, readonly FieldPath[]>
