import type {FieldPath} from '../../../stores/settingsStore'

/** 各页面「恢复本页默认」的字段集（spec §5.1；跨页字段归属见各 Tab 任务） */
export const PAGE_FIELD_SETS = {
    general: [
        'linkOpening.mode', 'fullSkillDescriptions', 'agent.defaultPermissionMode', 'agent.defaultDisplayMode',
        // ★ 不含 language.nativeLocale：它由系统语言兜底写入，不是"用户设置"；
        //   入集会让"恢复本页默认"把 nativeLocale 清成 undefined → 语言守卫静默失效到下次启动
        // ★ 含 language.nativeLocaleMode：它是真"用户选择"，恢复默认 = 回到「跟随系统」
        'language.nativeLocaleMode', 'language.strategy', 'language.correctionLimit',
    ],
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
