/**
 * propagateSystemSettings 测试（spec §6.2）：
 * 依赖注入版（SCC 约束见实现文件头）——全局权威键 / 运行中会话广播 / 其余窗口通知 + 快捷键同步。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {DEFAULT_SETTINGS} from '@shared/settingsDefaults'

const {mockWindows, mockSetJson, mockSyncShortcuts, mockWarn} = vi.hoisted(() => ({
    mockWindows: [] as Array<{isDestroyed: () => boolean; webContents: {id: number; send: ReturnType<typeof vi.fn>}}>,
    mockSetJson: vi.fn(),
    mockSyncShortcuts: vi.fn(() => ({}) as Record<string, string>),
    mockWarn: vi.fn(),
}))

vi.mock('electron', () => ({BrowserWindow: {getAllWindows: () => mockWindows}}))
vi.mock('@/main/repositories/sqlite/systemSettingsRepository', () => ({systemSettingsRepo: {setJson: mockSetJson}}))
vi.mock('@/main/agent/logger', () => ({logger: {warn: mockWarn, info: vi.fn(), error: vi.fn()}}))
// 必须能拦截实现内 `await import('../shortcuts')`（二者解析为同一文件 src/main/shortcuts.ts）
vi.mock('@/main/shortcuts', () => ({syncGlobalShortcuts: mockSyncShortcuts}))

import {propagateSystemSettings} from '@/main/settings/propagateSettings'

function fakeWin(id: number, destroyed = false) {
    return {isDestroyed: () => destroyed, webContents: {id, send: vi.fn()}}
}

const SETTINGS = {...DEFAULT_SETTINGS, agent: {...DEFAULT_SETTINGS.agent, defaultPermissionMode: 'auto' as const}}

beforeEach(() => {
    mockWindows.length = 0
    // 逐个 clear（保留 mock 实现），避免测试间串扰
    mockSetJson.mockClear()
    mockSyncShortcuts.mockClear()
    mockWarn.mockClear()
})

describe('propagateSystemSettings', () => {
    it('全局权威键：存在才写；权限同步失败仅告警不抛出', async () => {
        const failing = vi.fn(async () => { throw new Error('boom') })
        await expect(propagateSystemSettings(SETTINGS, {
            getRunningConversations: () => [],
            broadcastSettings: vi.fn(),
            applyGlobalPermissionMode: failing,
        })).resolves.toBeUndefined()
        expect(failing).toHaveBeenCalledWith('auto')
        expect(mockWarn).toHaveBeenCalled()
        expect(mockSetJson).toHaveBeenCalledWith('message-display-mode', {mode: 'detailed'})
    })

    it('缺省（无 defaultPermissionMode/defaultDisplayMode）时不触碰全局键', async () => {
        const apply = vi.fn(async () => {})
        const settings = {...SETTINGS, agent: {...SETTINGS.agent, defaultPermissionMode: undefined, defaultDisplayMode: undefined}}
        await propagateSystemSettings(settings, {
            getRunningConversations: () => [],
            broadcastSettings: vi.fn(),
            applyGlobalPermissionMode: apply,
        })
        expect(apply).not.toHaveBeenCalled()
        expect(mockSetJson).not.toHaveBeenCalled()
    })

    it('运行中会话逐一广播完整 settings', async () => {
        const broadcast = vi.fn()
        await propagateSystemSettings(SETTINGS, {
            getRunningConversations: () => ['conv-a', 'conv-b'],
            broadcastSettings: broadcast,
            applyGlobalPermissionMode: vi.fn(async () => {}),
        })
        expect(broadcast).toHaveBeenCalledTimes(2)
        expect(broadcast).toHaveBeenCalledWith('conv-a', SETTINGS)
        expect(broadcast).toHaveBeenCalledWith('conv-b', SETTINGS)
    })

    it('settings-changed 跳过排除窗口与已销毁窗口；快捷键失败广播到全部存活窗口', async () => {
        const w1 = fakeWin(1); const w2 = fakeWin(2); const dead = fakeWin(3, true)
        mockWindows.push(w1, w2, dead)
        mockSyncShortcuts.mockReturnValueOnce({'Ctrl+Shift+J': 'taken'})
        await propagateSystemSettings(SETTINGS, {
            getRunningConversations: () => [],
            broadcastSettings: vi.fn(),
            applyGlobalPermissionMode: vi.fn(async () => {}),
        }, {excludeWebContentsId: 1})
        // 排除发起窗口仅作用于 settings-changed：快捷键失败结果按原行为推给全部存活窗口（含发起窗口），
        // 故此处必须针对 settings-changed 断言，不能用 toHaveBeenCalled() 全量断言
        expect(w1.webContents.send).not.toHaveBeenCalledWith('settings-changed', SETTINGS)
        expect(w2.webContents.send).toHaveBeenCalledWith('settings-changed', SETTINGS)
        expect(dead.webContents.send).not.toHaveBeenCalled()      // 已销毁跳过
        expect(mockSyncShortcuts).toHaveBeenCalledWith(SETTINGS.shortcuts?.overrides)
        expect(w1.webContents.send).toHaveBeenCalledWith('shortcuts-global-failures', {'Ctrl+Shift+J': 'taken'})
        expect(w2.webContents.send).toHaveBeenCalledWith('shortcuts-global-failures', {'Ctrl+Shift+J': 'taken'})
    })
})
