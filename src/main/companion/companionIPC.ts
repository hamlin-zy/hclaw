import {ipcMain, dialog, app} from 'electron'
import path from 'path'
import {logger} from '../agent/logger'
import {safeHandle} from '../lib/safeHandle'
import {readCompanionConfig, upsertCompanionApp, removeCompanionApp} from './companionConfig'
import {enumerateApps} from './appEnumerator'
import type {CompanionApp} from '../../shared/types/companion'

export function initCompanionIPC(): void {
    safeHandle('companion:list', async () => readCompanionConfig())

    safeHandle('companion:save', async (_event, input: CompanionApp) => {
        try {
            const isNew = !input.id
            const id = upsertCompanionApp(input)
            return isNew ? {success: true, id} : {success: true}
        } catch (err) {
            logger.warn('companion-save-failed', {error: String(err)})
            return {success: false, error: String(err)}
        }
    })

    safeHandle('companion:remove', async (_event, id: string) => {
        try {
            removeCompanionApp(id)
            return {success: true}
        } catch (err) {
            logger.warn('companion-remove-failed', {id, error: String(err)})
            return {success: false, error: String(err)}
        }
    })

    safeHandle('companion:enumerate', async () => {
        try {
            return await enumerateApps()
        } catch (err) {
            logger.warn('companion-enumerate-ipc-failed', {error: String(err)})
            return []
        }
    })

    safeHandle('companion:browse', async () => {
        // dialog 无父窗口（有意为之）
        const result = await dialog.showOpenDialog({
            title: '选择可执行文件',
            filters: [{name: '应用程序', extensions: ['exe', 'bat', 'cmd']}],
            properties: ['openFile'],
        })
        if (result.canceled || result.filePaths.length === 0) return null
        const filePath = result.filePaths[0]
        return {
            name: path.basename(filePath, path.extname(filePath)),
            exePath: filePath,
            args: '',
            shortcutPath: '',
        }
    })

    safeHandle('companion:get-icon', async (_event, exePath: string) => {
        try {
            if (!exePath) return null
            const icon = await app.getFileIcon(exePath, {size: 'normal'})
            return {iconDataUrl: icon.toDataURL()}
        } catch (err) {
            logger.warn('companion-get-icon-failed', {exePath, error: String(err)})
            return null
        }
    })
}
