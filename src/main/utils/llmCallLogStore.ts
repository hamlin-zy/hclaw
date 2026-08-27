/**
 * LLM 调用轨迹 IPC（llm-trace:*）
 *
 * 取代旧 llm-calls.jsonl 管线的 IPC 面：
 * - toggle/get-projection/get-file/clear/list-conversations
 * - llm-logs 窗口打开时打标记（recorder 据此推送实时 record），
 *   窗口关闭自动停录并广播 Worker。
 */

import {ipcMain} from 'electron'
import fs from 'fs'
import path from 'path'
import type {BrowserWindow} from 'electron'
import {openConfigWindow} from './configWindow'
import {
    setRecordingEnabled,
    clearTraceLogs,
    isRecordingEnabled,
    onTracePaused,
    getTraceIndexLines,
    getLlmTraceRootDir,
    sanitizeConvId,
} from './llmTraceRecorder'
import {foldRecords, computeTokens} from './llmLogProjection'
import {agentManager} from '../agent/manager.impl'
import {isLlmCallRecord, type LlmCallRecord} from '@shared/types/llmTrace'

/** trace 落盘文件名白名单：<uuid>.req.json / <uuid>.res.raw */
const TRACE_FILE_RE = /^[0-9a-f-]{36}\.(req\.json|res\.raw)$/

/** LLM 日志窗口类型：主进程侧打标（__isLlmLogsWindow）用于定向推送 */
type LlmLogsWindow = BrowserWindow & {__isLlmLogsWindow?: boolean}

export function initLlmTraceIPC(): void {
    ipcMain.handle('llm-trace:toggle', (_e, enabled: boolean) => {
        setRecordingEnabled(enabled)
        agentManager.broadcastToWorkers({type: 'llm-trace-recording', enabled})
        return isRecordingEnabled()
    })

    ipcMain.handle('llm-trace:get-projection', async (_e, conversationIds?: string[]) => {
        // 未指定会话（或空数组）时投影全部会话目录；目录名是清洗后 safeId，getTraceIndexLines 可直接接受
        const ids = conversationIds && conversationIds.length > 0 ? conversationIds : listConversationDirs()
        const records: LlmCallRecord[] = []
        for (const id of ids) records.push(...await getTraceIndexLines(id))
        const {timeline, summary} = foldRecords(records)
        const summaryTokens = await computeTokens(records, loadResRaw)
        return {timeline, summary, summaryTokens}
    })

    ipcMain.handle('llm-trace:get-file', (_e, convId: string, file: string) => {
        return readTraceFile(convId, file)
    })

    ipcMain.handle('llm-trace:clear', async () => {
        // 安全顺序：先停录（主线程 + 所有 Worker），等在途写排空后再删目录
        setRecordingEnabled(false)
        agentManager.broadcastToWorkers({type: 'llm-trace-recording', enabled: false})
        await clearTraceLogs()
        return true
    })

    ipcMain.handle('llm-trace:list-conversations', async () => {
        // 目录 safeId 列表 + 会话库标题映射（sanitize(id) → title，规则同 getTraceIndexLines）
        const dirs = listConversationDirs()
        try {
            const {createConversationRepository} = await import('../repositories')
            const titleById = new Map<string, string>()
            for (const meta of createConversationRepository().list()) {
                titleById.set(sanitizeConvId(meta.id), meta.title)
            }
            return dirs.map(id => ({id, title: titleById.get(id) ?? id}))
        } catch {
            return dirs.map(id => ({id, title: id}))
        }
    })

    // 暂停事件（磁盘失败 failPause 等）推送到日志窗口
    onTracePaused(reason => pushToLogsWindow({type: 'paused', reason}))

    // 打开日志窗口（renderer 经 preload openLlmLogsWindow 调用；Task 7 前保持可用）
    ipcMain.handle('open-llm-logs-window', () => {
        openConfigWindow('llm-logs', (win) => {
            markLlmLogsWindow(win)
        })
    })
}

/** 窗口标记 + 关闭自动停录（窗口单例复用时回调重复执行，标记幂等、closed 监听防累积） */
function markLlmLogsWindow(win: BrowserWindow): void {
    ;(win as LlmLogsWindow).__isLlmLogsWindow = true
    if (win.listenerCount('closed') === 0) {
        win.once('closed', () => {
            setRecordingEnabled(false)
            agentManager.broadcastToWorkers({type: 'llm-trace-recording', enabled: false})
        })
    }
}

/** 按 conversationId + resFile 在 logs/llm-calls/<safeConv>/<day>/ 下读取 res.raw 文本 */
function loadResRaw(record: LlmCallRecord): Promise<string | null> {
    if (!record.resFile) return Promise.resolve(null)
    return Promise.resolve(readTraceFile(record.conversationId, record.resFile))
}

/** 白名单校验后遍历日期目录取文件（文件名含 uuid 全局唯一，取第一个命中） */
function readTraceFile(convId: string, file: string): string | null {
    if (!TRACE_FILE_RE.test(file)) return null
    const safeConv = convId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown'
    const root = path.join(getLlmTraceRootDir(), safeConv)
    if (!fs.existsSync(root)) return null
    for (const day of fs.readdirSync(root)) {
        const p = path.join(root, day, file)
        if (fs.existsSync(p)) {
            try {
                return fs.readFileSync(p, 'utf8')
            } catch {
                return null
            }
        }
    }
    return null
}

function listConversationDirs(): string[] {
    const root = getLlmTraceRootDir()
    return fs.existsSync(root) ? fs.readdirSync(root) : []
}

/** 推送消息到 LLM 日志窗口（主线程专用：Worker 侧经 parentPort 转发后由这里落窗）
 *  - LlmCallRecord → 'llm-trace-record' 通道：时间线实时上屏（preload onLlmTraceRecord）
 *  - 其余事件（{type:'paused'} 等）→ 'llm-trace-event' 通道：状态事件处理（preload onLlmTraceEvent）
 *  修复说明：此前一律发 'llm-trace-event'，Worker 转发的实时 record 被 paused-only 分支
 *  静默丢弃 → 录制中窗口看不到记录，重开窗口（磁盘投影）才能看到。 */
export function pushToLogsWindow(msg: unknown): void {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- 单测/无 electron 环境需防御式 require
        const {BrowserWindow} = require('electron')
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed() && (w as LlmLogsWindow).__isLlmLogsWindow) {
                w.webContents.send(isLlmCallRecord(msg) ? 'llm-trace-record' : 'llm-trace-event', msg)
            }
        }
    } catch { /* electron 不可用（单测环境）时忽略 */ }
}
