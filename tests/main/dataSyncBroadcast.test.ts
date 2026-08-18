import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * 跨窗口数据同步广播静态契约。
 *
 * 根因（与 model-schemes 同类）：llm providers / tools / prompt-schemes 的配置窗口
 * 独立化后，变更发生在独立 JS 堆，主窗口对应 store 无刷新机制（stale UI）。
 * 修复：主进程各写路径成功后广播事件给除发起窗口外的所有窗口；窗口订阅后刷新 store。
 * mcp：registerMCPEventForwarding 原只发 mainWindow，独立 mcp 窗口收不到实时推送，改为广播所有窗口。
 * 广播模式统一走 utils/windowBroadcast.ts 的 broadcastToOtherWindows。
 */

const HELPER_TS = path.resolve(process.cwd(), 'src/main/utils/windowBroadcast.ts')
const LLM_IPC_TS = path.resolve(process.cwd(), 'src/main/llmProviderIPC.ts')
const TOOL_IPC_TS = path.resolve(process.cwd(), 'src/main/toolIPC.ts')
const PROMPT_IPC_TS = path.resolve(process.cwd(), 'src/main/promptSchemeIPC.ts')
const MCP_IPC_TS = path.resolve(process.cwd(), 'src/main/agent/mcp/ipc.ts')
const PRELOAD_TS = path.resolve(process.cwd(), 'src/preload/index.ts')
const APP_TS = path.resolve(process.cwd(), 'src/renderer/App.tsx')

describe('windowBroadcast.ts — 公共广播 helper', () => {
    it('broadcastToOtherWindows：遍历 getAllWindows、跳过 sender、send 指定 channel', () => {
        const src = fs.readFileSync(HELPER_TS, 'utf-8')
        expect(src).toContain('export function broadcastToOtherWindows')
        expect(src).toContain('BrowserWindow.getAllWindows()')
        expect(src).toContain('event.sender')
        expect(src).toContain('webContents.send(channel, payload)')
    })
})

describe('llmProviderIPC.ts — llm-config-changed 广播', () => {
    it('9 个写 handler 成功后均调用 broadcastToOtherWindows(event, llm-config-changed)', () => {
        const src = fs.readFileSync(LLM_IPC_TS, 'utf-8')
        const count = src.split("broadcastToOtherWindows(event, 'llm-config-changed')").length - 1
        expect(count).toBeGreaterThanOrEqual(9)
    })
})

describe('toolIPC.ts — tools-changed 广播', () => {
    it('3 个写 handler（setEnabled/setEnabledBatch/setTimeout）成功后均广播', () => {
        const src = fs.readFileSync(TOOL_IPC_TS, 'utf-8')
        const count = src.split("broadcastToOtherWindows(event, 'tools-changed')").length - 1
        expect(count).toBeGreaterThanOrEqual(3)
    })
})

describe('promptSchemeIPC.ts — prompt-schemes-changed 广播', () => {
    it('3 个写 handler（save/delete/update-prompt-scheme）成功后均广播', () => {
        const src = fs.readFileSync(PROMPT_IPC_TS, 'utf-8')
        const count = src.split("broadcastToOtherWindows(event, 'prompt-schemes-changed')").length - 1
        expect(count).toBeGreaterThanOrEqual(3)
    })
})

describe('mcp ipc.ts — 状态推送广播所有窗口', () => {
    it('registerMCPEventForwarding 用 BrowserWindow.getAllWindows() 而非仅 mainWindow', () => {
        const src = fs.readFileSync(MCP_IPC_TS, 'utf-8')
        expect(src).toContain('BrowserWindow.getAllWindows()')
        // 不允许再出现仅发 mainWindow 的 mcp 推送
        expect(src).not.toContain("mainWindow.webContents.send('mcp:status-changed'")
        expect(src).not.toContain("mainWindow.webContents.send('mcp:list-changed'")
    })
})

describe('跨窗口订阅链路', () => {
    it('preload 暴露 onLlmConfigChanged / onToolsChanged / onPromptSchemesChanged 订阅', () => {
        const src = fs.readFileSync(PRELOAD_TS, 'utf-8')
        expect(src).toContain('onLlmConfigChanged')
        expect(src).toContain("'llm-config-changed'")
        expect(src).toContain('onToolsChanged')
        expect(src).toContain("'tools-changed'")
        expect(src).toContain('onPromptSchemesChanged')
        expect(src).toContain("'prompt-schemes-changed'")
    })

    it('App.tsx 订阅三个事件并触发对应 store 刷新', () => {
        const src = fs.readFileSync(APP_TS, 'utf-8')
        expect(src).toContain('onLlmConfigChanged')
        expect(src).toContain('useLLMStore.persist.rehydrate')
        expect(src).toContain('onToolsChanged')
        expect(src).toContain('useToolStore.getState().loadTools')
        expect(src).toContain('onPromptSchemesChanged')
        expect(src).toContain('usePromptSchemeStore.persist.rehydrate')
    })
})
