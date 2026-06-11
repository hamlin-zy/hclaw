// src/main/scheduler/scheduleIPC.ts
import {ipcMain} from 'electron'
import path from 'path'
import fs from 'fs'
import {schedulerManager} from './index'
import {scheduleRepo} from './ScheduleRepository'
import {createConversationRepository} from '../repositories'
import crypto from 'crypto'
import {getHclawDir} from '../config'

export function initScheduleIPC() {
  ipcMain.handle('scheduler-list', () => scheduleRepo.list())

  ipcMain.handle('scheduler-create', (_e, data: any) => {
    const id = crypto.randomUUID()
    const success = scheduleRepo.create({
      id,
      name: data.name,
      description: data.description || '',
      cronExpression: data.cronExpression,
      taskType: data.taskType,
      taskTarget: data.taskTarget,
      taskArgs: data.taskArgs || [],
      enabled: data.enabled !== false,
      paused: false,
      pausedAt: null,
      workspaceId: data.workspaceId || null,
    })
    if (success) {
      const record = scheduleRepo.get(id)
      if (record) schedulerManager.upsertWorkerSchedule(record)
    }
    return {success, id}
  })

  ipcMain.handle('scheduler-update', (_e, data: any) => {
    const {id, ...updates} = data
    const success = scheduleRepo.update(id, updates)
    if (success) {
      const record = scheduleRepo.get(id)
      if (record && record.enabled) schedulerManager.upsertWorkerSchedule(record)
      else schedulerManager.deleteWorkerSchedule(id)
    }
    return {success}
  })

  ipcMain.handle('scheduler-delete', (_e, id: string) => {
    const existing = scheduleRepo.get(id)
    if (!existing) return {success: false, error: `未找到ID为 "${id}" 的定时任务。`}
    schedulerManager.stop(id)
    schedulerManager.deleteWorkerSchedule(id)
    return {success: scheduleRepo.delete(id)}
  })

  ipcMain.handle('scheduler-stop', (_e, scheduleId: string) => (schedulerManager.stop(scheduleId), {success: true}))
  ipcMain.handle('scheduler-run-now', async (_e, id: string) => {
    try {
      return await schedulerManager.runNow(id)
    } catch (err: any) {
      return {success: false, error: err.message}
    }
  })

  ipcMain.handle('scheduler-get-conversations', async (_e, scheduleId: string) => {
    const convRepo = createConversationRepository()
    return convRepo.list()
      .filter((c: any) => c.scheduleId === scheduleId)
      .sort((a: any, b: any) => b.updatedAt - a.updatedAt)
  })

  ipcMain.handle('scheduler-conversation-detail', async (_e, convId: string) => {
    return createConversationRepository().readMessages(convId)
  })

  // ── 脚本任务日志查询 ──

  /**
   * 获取脚本任务的所有日志文件列表（按时间倒序）
   * 返回: [{path, fileName, startTime, size}]
   */
  ipcMain.handle('scheduler-script-logs', async (_e, scheduleId: string) => {
    try {
      const logDir = path.join(getHclawDir(), 'logs', 'schedules')
      if (!fs.existsSync(logDir)) return []

      const files = fs.readdirSync(logDir)
      const pattern = `${scheduleId}-`
      const logs = files
        .filter(f => f.startsWith(pattern) && f.endsWith('.log'))
        .map(f => {
          const fullPath = path.join(logDir, f)
          const startTime = parseInt(f.slice(pattern.length, -'.log'.length), 10)
          return {
            path: fullPath,
            fileName: f,
            startTime: isNaN(startTime) ? 0 : startTime,
            size: fs.statSync(fullPath).size,
          }
        })
        .sort((a, b) => b.startTime - a.startTime)
      return logs
    } catch {
      return []
    }
  })

  /**
   * 读取指定日志文件的内容
   */
  ipcMain.handle('scheduler-read-script-log', async (_e, logPath: string) => {
    try {
      if (!fs.existsSync(logPath)) return ''
      return fs.readFileSync(logPath, 'utf-8')
    } catch {
      return ''
    }
  })
}
