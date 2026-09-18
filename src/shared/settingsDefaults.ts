/**
 * 系统设置默认值 — 单一真源（spec §6.4）
 *
 * 渲染端 settingsStore、主进程 manager.impl / worker 兜底统一引用本模块；
 * 不再各自维护副本（三副本漂移是本文件存在的理由）。
 * 注意：不含 fullSkillDescriptions（缺省 = 关闭，与历史行为一致）。
 */
import {DEFAULT_MAX_TOKENS, type SystemSettings} from './types'

export const DEFAULT_SETTINGS: SystemSettings = {
    agent: {
        maxTurns: 500,
        retryCount: 10,
        initialRetryDelay: 5000,
        maxRetryDelay: 120000,
        llmTimeout: 600000,
        handoffThresholdRatio: 0.5,
        handoffThresholdMode: 'ratio',
        handoffThresholdTokens: 200_000,
        midLoopOverflowMode: 'auto-handoff',
        loopDetection: {mode: 'notify', threshold: 3},
        defaultPermissionMode: 'safe',
        defaultDisplayMode: 'detailed',
    },
    model: {
        defaultMaxTokens: DEFAULT_MAX_TOKENS,
        defaultTemperature: 0,
        imageCompressQuality: 85,
    },
    ui: {
        theme: 'system',
        background: {enabled: false, imagePath: '', overlay: 50, blur: 16},
    },
    subagent: {
        maxConcurrency: 3,
        maxDepth: 3,
    },
    channels: {
        sendGreeting: true,
        connectionTimeout: 30,
    },
    linkOpening: {
        mode: 'ask',
    },
    shortcuts: {overrides: {}},
}
