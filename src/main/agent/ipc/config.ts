/**
 * 配置/模型方案 IPC handlers
 *
 * 处理系统设置、模型方案切换、客户端预热等
 */

import {ipcMain} from 'electron'
import {agentManager} from '../manager'
import {runtimeConfigManager} from '../runtimeConfigManager'
import {toolRepo as sqliteToolRepo} from '../../repositories/sqlite/toolRepository'
import {logger} from '../logger'
import {broadcastToOtherWindows} from '../../utils/windowBroadcast'
import type {ModelConfig} from '../model/types'

export function registerHandlers(): void {
    // 获取会话级模型 override（含全局 lastSelected）
    ipcMain.handle('model-override-get', async (_event, convId: string) => {
        const override = runtimeConfigManager.getOverride(convId)
        const lastSelected = runtimeConfigManager.getLastSelected()
        return {success: true, data: {override, lastSelected}}
    })

    // 设置会话级模型 override（切回 auto 传 null）；广播多窗口 + 运行中 Worker（动态同步）
    ipcMain.handle('model-override-set', async (event, convId: string, override: import('@shared/types').ModelOverride | null) => {
        runtimeConfigManager.setOverride(convId, override)
        broadcastToOtherWindows(event, 'model-override-changed', {convId, override})
        // ★ 主进程 → 运行中 Worker 广播：UI 会话 agentLoop 跑在 worker 线程，
        //   不广播则 worker 内存 override 不更新，动态同步失效（复用原 broadcastWorkModeUpdate 机制）
        agentManager.broadcastModelOverride(convId, override)
        return {success: true}
    })

    // 更新所有运行中 Agent 的配置
    ipcMain.on('agent:update-active-config', (_event, modelConfig: ModelConfig) => {
        const runningIds = agentManager.getRunningConversations()
        runningIds.forEach(id => {
            agentManager.updateConfig(id, modelConfig)
        })
    })

    // 更新全局系统设置并同步到所有运行中的 Agent
    ipcMain.handle('settings-update', async (event, settings: import('@shared/types').SystemSettings) => {
        const runningIds = agentManager.getRunningConversations()
        runningIds.forEach(id => {
            agentManager.broadcastSettings(id, settings)
        })
        // 广播给除发起窗口外的所有渲染窗口（跨窗口数据一致性）：
        // 设置窗口写库后主窗口经 'settings-changed' 刷新 settingsStore（含 ui.background 背景/遮罩/模糊）。
        broadcastToOtherWindows(event, 'settings-changed', settings)
        return {success: true}
    })

    // 更新全局模型方案（支持运行时动态切换）
    ipcMain.handle('model-scheme-update', async (_event, data: {
        schemeId: string
        scheme: import('@shared/types').ModelScheme
        providers: Array<{
            id: string
            name: string
            type: 'anthropic' | 'openai' | 'google' | 'ollama' | 'custom'
            authType?: 'api-key' | 'google-oauth2'
            credentialId?: string
            apiKey?: string
            baseUrl?: string
            enabled: boolean
            models: Array<{id: string; name: string; enabled: boolean}>
        }>
    }) => {
        try {
            logger.debug('[IPC]', {action: 'model-scheme-update received'})
            logger.debug('[IPC]', {action: 'scheme-update', schemeId: data.schemeId, schemeName: data.scheme.name})
            logger.debug('[IPC]', {action: 'providers-count', count: data.providers.length})

            if (data.providers.length === 0) {
                logger.error('[IPC]', {action: 'empty-providers', message: '接收到空的 providers 数组！无法初始化模型方案'})
                return {success: false, error: 'No providers available'}
            }

            // 确保 credentials 中的 key 提升到顶层 apiKey
            const processedProviders = data.providers.map((p: any) => {
                logger.debug('[IPC]', {
                    action: 'model-scheme-process',
                    provider: p.name,
                    hasApiKey: !!p.apiKey,
                    apiKeyPrefix: p.apiKey ? String(p.apiKey).substring(0, 10) : 'none',
                    hasCredApiKey: !!p.credentials?.apiKey,
                    credApiKeyPrefix: p.credentials?.apiKey ? String(p.credentials.apiKey).substring(0, 10) : 'none',
                })
                if (p.apiKey && !String(p.apiKey).startsWith('enc:')) return p // 顶层已有明文，直接返回
                // OAuth2：从 credentials.accessToken 提升
                if (p.authType === 'google-oauth2' && p.credentials?.accessToken) {
                    logger.debug('[IPC]', {action: 'provider-credential', provider: p.name, authType: p.authType})
                    return {...p, apiKey: p.credentials.accessToken}
                }
                // API Key：从 credentials.apiKey 提升（兼容旧代码）
                if (p.credentials?.apiKey) {
                    logger.debug('[IPC]', {action: 'provider-credential', provider: p.name})
                    return {...p, apiKey: p.credentials.apiKey}
                }
                return p
            })

            processedProviders.forEach((p, index) => {
                logger.debug('[IPC]', {
                    action: 'provider-info',
                    index,
                    name: p.name,
                    type: p.type,
                    enabled: p.enabled,
                    hasApiKey: !!p.apiKey,
                })
                if (p.type === 'google') {
                    logger.debug('[IPC]', {
                        action: 'google-provider',
                        authType: p.authType,
                        credentialId: p.credentialId,
                        hasKey: !!p.apiKey,
                    })
                }
            })

            const {updateGlobalScheme} = await import('../model/index')
            updateGlobalScheme(data.schemeId, data.scheme, processedProviders)

            // 更新 RuntimeConfigManager（主进程）
            runtimeConfigManager.updateScheme(data.schemeId, data.scheme, processedProviders)

            // 同步内置工具的启用状态（与角色勾选联动）
            const visionRole = data.scheme.roles.find(r => r.role === 'image_understanding')
            const visionReady = !!(visionRole?.enabled && visionRole.endpointId && visionRole.modelId)
            if (visionReady) {
                try {
                    sqliteToolRepo.setEnabled('analyze_image', true)
                } catch (syncErr) {
                    logger.warn('[model-scheme-update] 同步 analyze_image 工具状态失败', {error: syncErr})
                }
            }

            const audioRole = data.scheme.roles.find(r => r.role === 'audio_understanding')
            const audioReady = !!(audioRole?.enabled && audioRole.endpointId && audioRole.modelId)
            if (audioReady) {
                try {
                    sqliteToolRepo.setEnabled('speech_to_text', true)
                } catch (syncErr) {
                    logger.warn('[model-scheme-update] 同步 speech_to_text 工具状态失败', {error: syncErr})
                }
            }

            // 广播到所有运行中的 Worker
            agentManager.broadcastSchemeUpdate({
                scheme: data.scheme,
                providers: processedProviders,
            })

            return {success: true, version: (await import('../model/modelSchemeManager')).getSchemeVersion().version}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    // 预热 Agent 客户端（与 model-scheme-update 配合使用）
    ipcMain.handle('agent-warmup-clients', async (_event, _data: {
        scheme: import('@shared/types').ModelScheme
        providers: Array<{
            id: string
            name: string
            type: 'anthropic' | 'openai' | 'google' | 'ollama' | 'custom'
            authType?: 'api-key' | 'google-oauth2'
            credentialId?: string
            apiKey?: string
            baseUrl?: string
            enabled: boolean
            models: Array<{id: string; name: string; enabled: boolean}>
        }>
    }) => {
        try {
            logger.debug('[IPC]', {action: 'agent-warmup-clients received'})
            // 预热逻辑：确保所有运行中的 Worker 都收到最新的 scheme 配置
            // 这确保 agent 客户端在首次使用时能立即工作
            const runningIds = agentManager.getRunningConversations()
            logger.debug('[IPC]', {action: 'warmup-workers', count: runningIds.length})
            // 注意：实际的 scheme 更新已在 model-scheme-update 中通过 broadcastSchemeUpdate 广播
            // 这里只需要确保状态一致即可
            return {success: true, warmedWorkers: runningIds.length}
        } catch (err: any) {
            logger.error('[IPC]', {action: 'agent-warmup-clients error', error: err.message})
            return {success: false, error: err.message}
        }
    })
}
