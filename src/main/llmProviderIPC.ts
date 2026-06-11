import {ipcMain} from 'electron'
import {
  type LLMProvider,
  SqliteProviderModelRepository,
  SqliteProviderRepository,
  type SqlProviderModel,
} from './repositories/sqlite/llmProviderRepository'
import {encryptSecret} from './utils/crypto'
import {createLogger} from './agent/logger'

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
  ipcMain.handle('provider:save', async (_, provider: LLMProvider) => {
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
      return { success }
    } catch (err) {
      console.error('[ProviderIPC] save failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 批量保存 Providers（替换全部）
  ipcMain.handle('provider:save-all', async (_, providers: LLMProvider[]) => {
    try {
      if (!providers || providers.length === 0) {
        const success = providerRepo.saveAll([])
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
      return { success }
    } catch (err) {
      console.error('[ProviderIPC] saveAll failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 删除 Provider
  ipcMain.handle('provider:delete', async (_, id: string) => {
    try {
      const success = providerRepo.delete(id)
      return { success }
    } catch (err) {
      console.error('[ProviderIPC] delete failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 更新 Provider enabled 状态
  ipcMain.handle('provider:set-enabled', async (_, id: string, enabled: boolean) => {
    try {
      const success = providerRepo.setEnabled(id, enabled)
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
    ipcMain.handle('provider-model:save', async (_, model: SqlProviderModel) => {
    try {
      const success = providerModelRepo.save(model)
      return { success }
    } catch (err) {
      console.error('[ProviderIPC] model save failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 批量保存模型（替换某 Provider 的全部）
    ipcMain.handle('provider-model:save-by-provider', async (_, providerId: string, models: SqlProviderModel[]) => {
    try {
      const success = providerModelRepo.saveByProviderId(providerId, models)
      return { success }
    } catch (err) {
      console.error('[ProviderIPC] saveByProviderId failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 删除模型
  ipcMain.handle('provider-model:delete', async (_, id: string) => {
    try {
      const success = providerModelRepo.delete(id)
      return { success }
    } catch (err) {
      console.error('[ProviderIPC] model delete failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 删除某 Provider 的所有模型
  ipcMain.handle('provider-model:delete-by-provider', async (_, providerId: string) => {
    try {
      const success = providerModelRepo.deleteByProviderId(providerId)
      return { success }
    } catch (err) {
      console.error('[ProviderIPC] deleteByProviderId failed:', err)
      return { success: false, error: String(err) }
    }
  })

  // 更新模型 enabled 状态
  ipcMain.handle('provider-model:set-enabled', async (_, id: string, enabled: boolean) => {
    try {
      const success = providerModelRepo.setEnabled(id, enabled)
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

  logger.info('init', {module: 'provider-ipc'})
}
