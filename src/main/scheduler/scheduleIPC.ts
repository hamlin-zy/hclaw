// src/main/scheduler/scheduleIPC.ts
/**
 * 定时任务 IPC — 通道注册
 * 返回约定：{ok: true, data} | {ok: false, error}（渲染层 toast），与 memo / phrase 模块一致。
 * 操作本身走 scheduleOps（与智能体工具同一出口，两条路径同形状）。
 * 变更通知走 scheduleBroadcast（全应用唯一出口，工具路径同样汇入那里）。
 */
import {ipcMain} from 'electron'
import path from 'path'
import fs from 'fs'
import {
    createSchedule, deleteSchedule, fail, listSchedules, pauseSchedule, resumeSchedule,
    runNowSchedule, stopSchedule, updateSchedule, workspaceHealthMap,
} from './scheduleOps'
import {broadcastSchedulesChanged} from './scheduleBroadcast'
import {schedulerManager} from './index'
import {createConversationRepository} from '../repositories'
import {getScriptLogDir} from './scriptLogPath'

/**
 * `scheduler-read-script-log` 单次经 IPC 回传的日志上限（**字节**）。
 *
 * 256KB ≈ 25 万 ASCII 字符，与渲染层的显示上限（`CONTENT_LIMIT` = 20 万字符）同量级：
 * 常规日志整份返回，超限日志只回前一段并带上文件真实总大小，界面照旧给出「仅显示前…」的提示。
 */
export const SCRIPT_LOG_READ_LIMIT_BYTES = 256 * 1024

export function initScheduleIPC() {
  // 运行状态变化的广播出口 —— 注入给 manager（它自己不能静态 import scheduleBroadcast：
  // 本模块在 Agent Worker 的静态依赖闭包内，见 scheduler/index.ts 的 onRecordUpdated 注释）。
  // 「立即执行 → 运行中 → 成功/失败」与「停止」都经 `updateRunStatusSafe` 走这一条。
  schedulerManager.onRecordUpdated = (record) => broadcastSchedulesChanged({type: 'updated', record})

  ipcMain.handle('scheduler-list', () => listSchedules())

  // 工作目录健康度：只读派生查询，单一出口（判定权在主进程，见 ./scheduleWorkspace）。
  // 渲染层不重算，只消费；列表刷新与广播触发的刷新各自拉一次，不新增轮询。
  ipcMain.handle('scheduler-workspace-health', () => workspaceHealthMap())

  ipcMain.handle('scheduler-create', (_e, data: any) => {
    const result = createSchedule({
      name: data?.name,
      description: data?.description,
      cronExpression: data?.cronExpression,
      taskType: data?.taskType,
      taskTarget: data?.taskTarget,
      taskArgs: data?.taskArgs || [],
      enabled: data?.enabled !== false,
      workspaceId: data?.workspaceId || null,
    })
    if (result.ok) broadcastSchedulesChanged({type: 'created', record: result.data})
    return result
  })

  ipcMain.handle('scheduler-update', (_e, data: any) => {
    const {id, ...updates} = data || {}
    const result = updateSchedule(id, updates)
    if (result.ok) broadcastSchedulesChanged({type: 'updated', record: result.data})
    return result
  })

  ipcMain.handle('scheduler-delete', (_e, id: string) => {
    const result = deleteSchedule(id)
    if (result.ok) broadcastSchedulesChanged({type: 'deleted', id})
    return result
  })

  // 暂停/恢复是「更新一条记录」之外的真动作，单独成通道（本票唯一允许新增的通道）
  ipcMain.handle('scheduler-pause', (_e, id: string) => {
    const result = pauseSchedule(id)
    if (result.ok) broadcastSchedulesChanged({type: 'updated', record: result.data})
    return result
  })

  ipcMain.handle('scheduler-resume', (_e, id: string) => {
    const result = resumeSchedule(id)
    if (result.ok) broadcastSchedulesChanged({type: 'updated', record: result.data})
    return result
  })

  ipcMain.handle('scheduler-stop', (_e, scheduleId: string) => stopSchedule(scheduleId))

  ipcMain.handle('scheduler-run-now', (_e, id: string) => runNowSchedule(id))

  ipcMain.handle('scheduler-get-conversations', (_e, scheduleId: string) => {
    try {
      const data = createConversationRepository().list()
        .filter((c: any) => c.scheduleId === scheduleId)
        .sort((a: any, b: any) => b.updatedAt - a.updatedAt)
      return {ok: true, data}
    } catch (err) { return fail(err, undefined, String) }
  })

  // ── 脚本任务日志查询 ──

  /** 获取脚本任务的所有日志文件列表（按时间倒序）；无日志目录时返回空列表 */
  ipcMain.handle('scheduler-script-logs', (_e, scheduleId: string) => {
    try {
      // 与写入方（SchedulerManager.writeScriptLog）共用同一份目录拼接
      const logDir = getScriptLogDir()
      if (!fs.existsSync(logDir)) return {ok: true, data: []}
      const files = fs.readdirSync(logDir)
      const pattern = `${scheduleId}-`
      const data = files
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
      return {ok: true, data}
    } catch (err) { return fail(err, '读取脚本日志列表失败', String) }
  })

  /**
   * 读取指定日志文件的内容。
   *
   * 出口形状不变（`{ok:true,data}` | `{ok:false,error}`），`data` 由裸字符串改为
   * `{content, totalSize}`：
   * - **读取上限**：只回前 `SCRIPT_LOG_READ_LIMIT_BYTES` 字节。渲染层原先只做「仅显示前 X /
   *   共 Y」的**显示**标注，读的却是整份日志、过的也是整串 IPC —— MB 级日志的内存与 IPC
   *   代价完全不受约束。截断改到入口处，IPC 载荷有上界。
   * - **真实总大小**：`totalSize` 是文件的真实字节数（非字符数）。渲染层据此判断「收到的不是
   *   全部」，不再自己数收到的字符串长度（那样只会量到已被截断的副本）。
   * - **目录归属**：只接受调度日志目录（`getScriptLogDir()`）内的文件。该路径虽只能由授权
   *   渲染层传入、且来源是本模块自己列出的集合，仍在入口再钉一道。
   */
  ipcMain.handle('scheduler-read-script-log', (_e, logPath: string) => {
    try {
      const logDir = path.resolve(getScriptLogDir())
      const resolved = path.resolve(String(logPath ?? ''))
      if (resolved !== logDir && !resolved.startsWith(logDir + path.sep)) {
        throw new Error('日志文件不在调度日志目录内')
      }
      if (!fs.existsSync(resolved)) throw new Error('日志文件不存在')
      const totalSize = fs.statSync(resolved).size
      // 只读前 N 字节：open + read 定点读取，避免为截断而把整份文件读进内存
      const length = Math.min(totalSize, SCRIPT_LOG_READ_LIMIT_BYTES)
      const fd = fs.openSync(resolved, 'r')
      try {
        const buf = Buffer.alloc(length)
        fs.readSync(fd, buf, 0, length, 0)
        return {ok: true, data: {content: buf.toString('utf-8'), totalSize}}
      } finally {
        fs.closeSync(fd)
      }
    } catch (err) { return fail(err, '读取日志内容失败', String) }
  })
}
