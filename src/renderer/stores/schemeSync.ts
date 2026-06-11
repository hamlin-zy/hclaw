/**
 * schemeSync.ts
 *
 * 提供 scheme 相关的数据同步功能。
 * 独立成模块以避免循环依赖：
 *   - llmStore 依赖 sqliteStorage (通过 persist middleware)
 *   - sqliteStorage 需要调用 llmStore.getState()
 *
 * 这个模块只被 sqliteStorage 动态导入，不被 llmStore 依赖，
 * 所以不会形成循环。
 */

// 使用动态 import 避免循环依赖：
//   llmStore → sqliteStorage → schemeSync → llmStore
//   toolStore → sqliteStorage → schemeSync → toolStore
// 这两个 store 只在函数体内部被调用（运行时才解析），不会阻塞模块初始化

/**
 * 同步 runtimeConfigManager 并更新 scheme
 */
export async function syncSchemeToBackend(schemeId: string, scheme: any): Promise<void> {
    const {useLLMStore} = await import('./llmStore')
    const providers = await useLLMStore.getState().getAllDecryptedProviders()
    await window.electronAPI?.updateModelScheme?.({
        schemeId,
        scheme,
        providers,
    })
}

/**
 * 刷新工具列表（analyze_image 启用状态可能已同步改变）
 */
export function refreshToolStore(): void {
    import('./toolStore').then(({useToolStore}) => {
        try {
            (useToolStore.getState() as any).loadTools()
        } catch {
            // 安全兜底
        }
    }).catch(() => {
        // 安全兜底
    })
}
