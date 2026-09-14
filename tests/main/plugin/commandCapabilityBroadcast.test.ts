import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * 能力变更广播静态契约 — command:* / plugin-command:* 写 handler 必须刷新 CapabilityHub。
 *
 * 根因：capability:changed 由 powerManager.refresh() → syncToCapabilityHub → CapabilityHub.replaceAll
 * 发射。命令/命令覆盖的写入会改变能力集合，但部分 IPC handler 不触发 refresh，
 * 导致能力变更后 Hub 不更新、不广播，独立窗口状态陈旧。
 *
 * 本测试锁定：
 *   1. 所有会改变能力数据的写 handler 均包含一次 refresh（powerManager.refresh 或封装）；
 *   2. 只读 handler 不得触发全量刷新（避免无谓开销）。
 */

const PLUGIN_IPC_TS = path.resolve(process.cwd(), 'src/main/plugin/ipc.ts')

const REFRESH_RE = /await (?:powerManager\.refresh\(\)|refreshPowerManagerAndGetCapabilities\(\))/

/** 提取顶层 async function 正文（函数体以行首 `}` 结束）。 */
function extractFunction(src: string, name: string): string {
    const start = src.indexOf(`async function ${name}(`)
    if (start < 0) throw new Error(`handler not found: ${name}`)
    const end = src.indexOf('\n}', start)
    if (end < 0) throw new Error(`handler body not terminated: ${name}`)
    return src.slice(start, end)
}

function countRefresh(body: string): number {
    return body.match(new RegExp(REFRESH_RE.source, 'g'))?.length ?? 0
}

const src = fs.readFileSync(PLUGIN_IPC_TS, 'utf-8')

// 会改变能力数据的写 handler —— 必须刷新
const MUTATING_HANDLERS = [
    'handleCreateCommand',
    'handleUpdateCommand',
    'handleDeleteCommand',
    'handleToggleCommand',
    'handleImportCommands',
    'handleResetPresets',
    'handleUpsertPluginCommandOverride',
    'handleDeletePluginCommandOverride',
] as const

// 只读 handler —— 不得触发全量刷新
const READONLY_HANDLERS = [
    'handlePrepareMessage',
    'handleResolveByName',
    'handleGetAllCommands',
    'handleGetUserCommands',
    'handleGetDefaultTemplate',
    'handleExportCommands',
    'handleGetCommandOverrides',
    'handleGetPluginCommandOverrides',
    'handleGetSkillCommands',
    'handleGetAgentCommands',
    'handleGetCommands',
    'handleGetCapabilityDetails',
] as const

describe('plugin/ipc.ts — 能力变更写 handler 刷新契约', () => {
    it.each(MUTATING_HANDLERS)('%s 触发一次 refresh（无重复全量刷新）', (name) => {
        const body = extractFunction(src, name)
        expect(countRefresh(body)).toBe(1)
    })
})

describe('plugin/ipc.ts — 只读 handler 不触发全量刷新', () => {
    it.each(READONLY_HANDLERS)('%s 不含 powerManager.refresh', (name) => {
        const body = extractFunction(src, name)
        expect(body).not.toContain('powerManager.refresh')
        expect(body).not.toContain('refreshPowerManagerAndGetCapabilities')
    })
})
