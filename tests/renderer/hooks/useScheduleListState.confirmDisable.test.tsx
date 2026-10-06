// @vitest-environment jsdom
/**
 * 回归测试：handleConfirmDisable 仅对「记忆沉淀」任务才联动关闭记忆功能
 *
 * 修复前：handleConfirmDisable 对所有 isSystem 任务禁用都调
 *   updateSettings({memory:{enabled:false}})，导致禁用日报等非记忆系统任务时
 *   误关记忆功能。
 * 修复后：仅 schedule.id === MEMORY_ACCUMULATION_SCHEDULE_ID 才联动关记忆。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {renderHook, act} from '@testing-library/react'

// ── mock scheduleStore：update 返回 ok:true，使 handleConfirmDisable 走到记忆联动分支 ──
const updateMock = vi.fn(async () => ({ok: true, data: {}}))
vi.mock('../../../src/renderer/stores/scheduleStore', () => ({
    useScheduleStore: () => ({
        schedules: [],
        loading: false,
        error: null,
        loadSchedules: vi.fn(),
        create: vi.fn(),
        update: updateMock,
        delete: vi.fn(),
        stop: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        runNow: vi.fn(),
        restoreDefault: vi.fn(),
        workspaceHealth: {},
        driftMap: {},
    }),
}))

// ── mock settingsStore：捕获 updateSettings 调用 ──
const updateSettingsMock = vi.fn(async () => {})
vi.mock('../../../src/renderer/stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({updateSettings: updateSettingsMock}),
    },
}))

// ── mock ConfirmDialog（useScheduleListState 顶层 import 了 confirm，但本测试不触发它）──
vi.mock('../../../src/renderer/components/ConfirmDialog', () => ({
    confirm: vi.fn(),
}))

import {useScheduleListState} from '../../../src/renderer/hooks/useScheduleListState'
import {MEMORY_ACCUMULATION_SCHEDULE_ID} from '../../../src/main/agent/defaults/systemSchedules'

describe('handleConfirmDisable 记忆联动仅限记忆沉淀任务', () => {
    beforeEach(() => {
        updateMock.mockClear()
        updateSettingsMock.mockClear()
    })

    it('禁用记忆沉淀任务 → updateSettings 被调用关记忆', async () => {
        const {result} = renderHook(() => useScheduleListState())

        await act(async () => {
            await result.current.handleConfirmDisable({
                id: MEMORY_ACCUMULATION_SCHEDULE_ID,
                isSystem: true,
                enabled: true,
            } as any)
        })

        expect(updateMock).toHaveBeenCalledWith(MEMORY_ACCUMULATION_SCHEDULE_ID, {enabled: false})
        expect(updateSettingsMock).toHaveBeenCalledWith({memory: {enabled: false}})
    })

    it('禁用非记忆系统任务 → 不调 updateSettings（不误关记忆）', async () => {
        const {result} = renderHook(() => useScheduleListState())

        await act(async () => {
            await result.current.handleConfirmDisable({
                id: 'sys-daily-report',
                isSystem: true,
                enabled: true,
            } as any)
        })

        expect(updateMock).toHaveBeenCalledWith('sys-daily-report', {enabled: false})
        expect(updateSettingsMock).not.toHaveBeenCalled()
    })
})
