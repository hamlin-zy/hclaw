import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'
import {isLlmCallRecord, type LlmCallRecord} from '@shared/types/llmTrace'

/**
 * llmCallLogStore.pushToLogsWindow 通道分发契约。
 *
 * 根因（Task 5 接线回归）：pushToLogsWindow 无条件把消息发到 'llm-trace-event' 通道，
 * 而 Worker 线程转发的实时 LlmCallRecord 需要走 'llm-trace-record' 通道
 * （preload onLlmTraceRecord 监听该通道、LlmLogsWindow 时间线实时上屏）；
 * 发到 event 通道后被 onLlmTraceEvent 的 paused-only 分支丢弃 → 录制中窗口看不到实时记录，
 * 重开窗口（走磁盘投影加载）才能看到 —— 与用户「开启录制后无任何记录，重开窗口即加载」完全吻合。
 *
 * 修复：pushToLogsWindow 按消息形状分发 —— LlmCallRecord → 'llm-trace-record'，
 * 其余事件（{type:'paused'} 等）→ 'llm-trace-event'。
 */

const STORE_TS = path.resolve(process.cwd(), 'src/main/utils/llmCallLogStore.ts')
const PRELOAD_TS = path.resolve(process.cwd(), 'src/preload/index.ts')
const WINDOW_TS = path.resolve(process.cwd(), 'src/renderer/components/LlmLogsWindow.tsx')

describe('isLlmCallRecord — 形状判定', () => {
    const record: LlmCallRecord = {
        id: 'r1', ts: 1, conversationId: 'c1', turn: 1, step: 1, attempt: 1,
        context: 'main', provider: 'p', model: 'm', apiStyle: 'openai',
        status: 'ok', firstByteMs: 1, totalMs: 1, reqFile: 'r1.req.json',
    }

    it('LlmCallRecord → true', () => {
        expect(isLlmCallRecord(record)).toBe(true)
    })

    it('paused 事件（type 非 ok/error/aborted 且无 id/ts）→ false', () => {
        expect(isLlmCallRecord({type: 'paused', reason: 'disk full'})).toBe(false)
    })

    it('null / 非对象 / 残缺形状 → false', () => {
        expect(isLlmCallRecord(null)).toBe(false)
        expect(isLlmCallRecord(undefined)).toBe(false)
        expect(isLlmCallRecord('x')).toBe(false)
        expect(isLlmCallRecord({id: 'r1'})).toBe(false)
        expect(isLlmCallRecord({id: 'r1', ts: 1})).toBe(false)
    })
})

describe('llmCallLogStore.pushToLogsWindow — record/event 通道分发', () => {
    it('按消息形状分发：LlmCallRecord 走 llm-trace-record，其余走 llm-trace-event', () => {
        const src = fs.readFileSync(STORE_TS, 'utf-8')
        expect(src).toContain("w.webContents.send(isLlmCallRecord(msg) ? 'llm-trace-record' : 'llm-trace-event', msg)")
    })
})

describe('跨通道订阅链路完整性', () => {
    it('preload 的 onLlmTraceRecord 监听 llm-trace-record（record 实时上屏通道）', () => {
        const src = fs.readFileSync(PRELOAD_TS, 'utf-8')
        expect(src).toContain("ipcRenderer.on('llm-trace-record'")
    })

    it('LlmLogsWindow 通过 onLlmTraceRecord 实时插记录到时间线', () => {
        const src = fs.readFileSync(WINDOW_TS, 'utf-8')
        expect(src).toContain('onLlmTraceRecord?.((record) =>')
        expect(src).toContain('insertRecord(prev.timeline, record)')
    })
})
