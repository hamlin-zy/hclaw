/**
 * 配置桥接层 - 无依赖的纯接口
 *
 * 打破 runtimeConfigManager ↔ modelSchemeManager 循环依赖
 */

import type {LLMProvider, ModelScheme} from '@shared/types'

export interface ConfigBridge {
    /** 获取当前 scheme */
    getScheme(): ModelScheme | null
    /** 获取当前 providers */
    getProviders(): LLMProvider[]
    /** 订阅配置变更 */
    onConfigChange(callback: (config: ConfigBridge) => void): () => void
}

// 全局实例
let _bridge: ConfigBridge | null = null

export function setConfigBridge(bridge: ConfigBridge): void {
    _bridge = bridge
}

export function getConfigBridge(): ConfigBridge {
    if (!_bridge) {
        throw new Error('ConfigBridge not initialized')
    }
    return _bridge
}