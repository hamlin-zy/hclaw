import {ipcMain} from 'electron'
import {
  type LLMProvider,
  SqliteProviderModelRepository,
  SqliteProviderRepository,
  type SqlProviderModel,
} from './repositories/sqlite/llmProviderRepository'
import {encryptSecret} from './utils/crypto'
import {createLogger} from './agent/logger'
import {broadcastToOtherWindows} from './utils/windowBroadcast'
import {fetchProviderModels, testProviderModel} from './providerModelFetcher'
import {modelMetaRegistry} from './modelMetaRegistry'
import {exchangeRateRegistry} from './exchangeRateRegistry'
import {createModelAdapter} from './agent/model'
import {GoogleAuthService} from './auth/googleAuth'

const logger = createLogger('ProviderIPC')
const providerRepo = new SqliteProviderRepository()
const providerModelRepo = new SqliteProviderModelRepository()

/**
 * 初始化 Provider IPC handlers
 */
export function initProviderIPC(): void {
  // ==================== Provider ====================

  // 获取所有 Providers
  ipcMain.handle('provider:list', async () => {
    try {
      const providers = providerRepo.list()
      return { success: true, data: providers }
    } catch (err) {
      console.error('[ProviderIPC] list failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 根据 ID 获取 Provider
  ipcMain.handle('provider:get', async (_, id: string) => {
    try {
      const provider = providerRepo.getById(id)
      return { success: true, data: provider }
    } catch (err) {
      console.error('[ProviderIPC] get failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 保存 Provider（新增或更新）
  ipcMain.handle('provider:save', async (event, provider: LLMProvider) => {
    try {
      // 如果有 apiKey，需要加密（检查是否已加密，避免重复加密）
      let processedProvider = { ...provider }
      if (processedProvider.credentials?.apiKey) {
        const apiKey = processedProvider.credentials.apiKey
        // enc: 前缀表示已加密，跳过重复加密
        if (!apiKey.startsWith('enc:')) {
          processedProvider = {
            ...processedProvider,
            credentials: {
              ...processedProvider.credentials,
              apiKey: await encryptSecret(apiKey),
            },
          }
        }
      }
      const success = providerRepo.save(processedProvider)
      broadcastToOtherWindows(event, 'llm-config-changed')
      return { success }
    } catch (err) {
      console.error('[ProviderIPC] save failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 批量保存 Providers（替换全部）
  ipcMain.handle('provider:save-all', async (event, providers: LLMProvider[]) => {
    try {
      if (!providers || providers.length === 0) {
        const success = providerRepo.saveAll([])
        broadcastToOtherWindows(event, 'llm-config-changed')
        return { success }
      }

      // 如果有 apiKey，需要加密（检查是否已加密，避免重复加密）
      const processedProviders = await Promise.all(
        providers.map(async (provider) => {
          let processedProvider = { ...provider }
          if (processedProvider.credentials?.apiKey) {
            const apiKey = processedProvider.credentials.apiKey
            // enc: 前缀表示已加密，跳过重复加密
            if (!apiKey.startsWith('enc:')) {
              processedProvider = {
                ...processedProvider,
                credentials: {
                  ...processedProvider.credentials,
                  apiKey: await encryptSecret(apiKey),
                },
              }
            }
          }
          return processedProvider
        })
      )
      logger.info('save-all', {count: processedProviders.length})
      const success = providerRepo.saveAll(processedProviders)
      logger.info('save-all:result', {success})
      broadcastToOtherWindows(event, 'llm-config-changed')
      return { success }
    } catch (err) {
      console.error('[ProviderIPC] saveAll failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 删除 Provider
  ipcMain.handle('provider:delete', async (event, id: string) => {
    try {
      const success = providerRepo.delete(id)
      broadcastToOtherWindows(event, 'llm-config-changed')
      return { success }
    } catch (err) {
      console.error('[ProviderIPC] delete failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 更新 Provider enabled 状态
  ipcMain.handle('provider:set-enabled', async (event, id: string, enabled: boolean) => {
    try {
      const success = providerRepo.setEnabled(id, enabled)
      broadcastToOtherWindows(event, 'llm-config-changed')
      return { success }
    } catch (err) {
      console.error('[ProviderIPC] setEnabled failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // ==================== Provider Model ====================

  // 获取所有模型
  ipcMain.handle('provider-model:list', async () => {
    try {
      const models = providerModelRepo.list()
      return { success: true, data: models }
    } catch (err) {
      console.error('[ProviderIPC] model list failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 根据 Provider ID 获取模型
  ipcMain.handle('provider-model:list-by-provider', async (_, providerId: string) => {
    try {
      const models = providerModelRepo.listByProviderId(providerId)
      return { success: true, data: models }
    } catch (err) {
      console.error('[ProviderIPC] listByProviderId failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 保存模型
    ipcMain.handle('provider-model:save', async (event, model: SqlProviderModel) => {
    try {
      const success = providerModelRepo.save(model)
      broadcastToOtherWindows(event, 'llm-config-changed')
      return { success }
    } catch (err) {
      console.error('[ProviderIPC] model save failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 批量保存模型（替换某 Provider 的全部）
    ipcMain.handle('provider-model:save-by-provider', async (event, providerId: string, models: SqlProviderModel[]) => {
    try {
      const success = providerModelRepo.saveByProviderId(providerId, models)
      broadcastToOtherWindows(event, 'llm-config-changed')
      return { success }
    } catch (err) {
      console.error('[ProviderIPC] saveByProviderId failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 删除模型
  ipcMain.handle('provider-model:delete', async (event, id: string) => {
    try {
      const success = providerModelRepo.delete(id)
      broadcastToOtherWindows(event, 'llm-config-changed')
      return { success }
    } catch (err) {
      console.error('[ProviderIPC] model delete failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 删除某 Provider 的所有模型
  ipcMain.handle('provider-model:delete-by-provider', async (event, providerId: string) => {
    try {
      const success = providerModelRepo.deleteByProviderId(providerId)
      broadcastToOtherWindows(event, 'llm-config-changed')
      return { success }
    } catch (err) {
      console.error('[ProviderIPC] deleteByProviderId failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 更新模型 enabled 状态
  ipcMain.handle('provider-model:set-enabled', async (event, id: string, enabled: boolean) => {
    try {
      const success = providerModelRepo.setEnabled(id, enabled)
      broadcastToOtherWindows(event, 'llm-config-changed')
      return { success }
    } catch (err) {
      console.error('[ProviderIPC] model setEnabled failed:', err)
      return { success: false, error: String(err) }
    }
  })

    // 获取所有 Providers 及其模型
    ipcMain.handle('provider:list-with-models', async () => {
        try {
            const providers = providerRepo.list()
            const providersWithModels = providers.map(provider => {
                const models = providerModelRepo.listByProviderId(provider.id)
                return {...provider, models}
            })
            return {success: true, data: providersWithModels}
        } catch (err) {
            console.error('[ProviderIPC] listWithModels failed:', err)
            return {success: false, error: String(err)}
        }
    })

  // ==================== 模型拉取 / 测试（无副作用，不写库、不产生会话） ====================

  // 拉取模型列表（复用真实 key 调服务商 /models 接口，绕 CORS 由主进程执行）
  ipcMain.handle('provider:fetch-models', (_, params) =>
    fetchProviderModels(params, {
      refreshGoogleToken: (refreshToken: string) => GoogleAuthService.refreshAccessToken(refreshToken),
    }))

  // 模型连通性测试（复用 createModelAdapter，仅发最小 'ping' 请求）
  ipcMain.handle('provider:test-model', (_, params) =>
    testProviderModel(params, {
      createAdapter: createModelAdapter,
      refreshGoogleToken: (refreshToken: string) => GoogleAuthService.refreshAccessToken(refreshToken),
    }))

  // 模型元数据：查询窗口大小（OpenRouter 补全；0 = 未知）
  // ensureLoaded：首次无缓存时等待后台 refresh 完成，避免查询竞态返回 0
  ipcMain.handle('model-meta:get-window', async (_, params: {model: string}) => {
    await modelMetaRegistry.ensureLoaded()
    return { contextLength: modelMetaRegistry.getContextLength(params.model) }
  })

  // 汇率查询：USD→CNY 实时汇率（启动时同步；未同步/离线回退默认 7.2）
  // ensureLoaded：首次无缓存时等待后台 refresh 完成，避免查询竞态拿到默认值
  ipcMain.handle('exchange-rate:get', async () => {
    await exchangeRateRegistry.ensureLoaded()
    return {
      rate: exchangeRateRegistry.getUsdCnyRate(),
      date: exchangeRateRegistry.getDate(),
    }
  })

  // 汇率刷新：手动触发拉取最新汇率（返回更新后的汇率和日期）
  ipcMain.handle('exchange-rate:refresh', async () => {
    await exchangeRateRegistry.refresh()
    return {
      rate: exchangeRateRegistry.getUsdCnyRate(),
      date: exchangeRateRegistry.getDate(),
    }
  })

  // 模型价目表刷新：手动触发拉取 OpenRouter 模型元数据（返回模型数量和获取时间）
  ipcMain.handle('model-meta:refresh', async () => {
    await modelMetaRegistry.refresh()
    return {
      count: modelMetaRegistry.getModels().length,
      fetchedAt: modelMetaRegistry.getFetchedAt(),
    }
  })

  logger.info('init', {module: 'provider-ipc'})
}
