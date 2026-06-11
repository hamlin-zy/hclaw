import {ipcMain} from 'electron'
import {modelSchemeRepo} from './repositories/sqlite/modelSchemeRepository'
import {createLogger} from './agent/logger'

const logger = createLogger('ModelSchemeIPC')

export function initModelSchemeIPC(): void {
  ipcMain.handle('model-scheme:list', async () => {
    try {
      const schemes = modelSchemeRepo.list()
      return { success: true, data: schemes }
    } catch (err) {
      console.error('[ModelSchemeIPC] list failed:', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('model-scheme:get', async (_, id: string) => {
    try {
      const scheme = modelSchemeRepo.getById(id)
      return { success: true, data: scheme }
    } catch (err) {
      console.error('[ModelSchemeIPC] get failed:', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('model-scheme:save', async (_, scheme: any) => {
    try {
      const success = modelSchemeRepo.save(scheme)
      return { success }
    } catch (err) {
      console.error('[ModelSchemeIPC] save failed:', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('model-scheme:delete', async (_, id: string) => {
    try {
      const success = modelSchemeRepo.delete(id)
      return { success }
    } catch (err) {
      console.error('[ModelSchemeIPC] delete failed:', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('model-scheme:set-active', async (_, schemeId: string) => {
    try {
      // Store active scheme ID in system_settings table
      const { systemSettingsRepo } = await import('./repositories/sqlite/systemSettingsRepository')
      systemSettingsRepo.set('activeSchemeId', schemeId)

        // 同步 analyze_image 和 speech_to_text 工具的启用状态（与角色联动）
        try {
            const scheme = modelSchemeRepo.getById(schemeId)
            if (scheme) {
                const visionRole = scheme.roles.find(r => r.role === 'image_understanding')
                const visionEnabled = !!(visionRole?.enabled && visionRole.endpointId && visionRole.modelId)
                const {toolRepo} = await import('./repositories/sqlite/toolRepository')
                toolRepo.setEnabled('analyze_image', visionEnabled)

                const audioRole = scheme.roles.find(r => r.role === 'audio_understanding')
                const audioEnabled = !!(audioRole?.enabled && audioRole.endpointId && audioRole.modelId)
                toolRepo.setEnabled('speech_to_text', audioEnabled)
            }
        } catch (syncErr) {
            console.error('[ModelSchemeIPC] 同步工具状态失败:', syncErr)
        }

      return { success: true }
    } catch (err) {
      console.error('[ModelSchemeIPC] setActive failed:', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('model-scheme:get-active-id', async () => {
    try {
      const { systemSettingsRepo } = await import('./repositories/sqlite/systemSettingsRepository')
      const id = systemSettingsRepo.get('activeSchemeId')
      return { success: true, data: id }
    } catch (err) {
      console.error('[ModelSchemeIPC] getActiveId failed:', err)
      return { success: false, error: String(err) }
    }
  })

  logger.info('init', {module: 'model-scheme-ipc'})
}
