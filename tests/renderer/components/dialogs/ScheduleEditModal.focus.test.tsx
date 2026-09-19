// @vitest-environment jsdom
/**
 * ScheduleEditModal — 初始焦点（2026-09-19 用户反馈）
 *
 * 钉住：弹窗打开时焦点落在「描述」输入框上。
 * 背景：名称输入框与 CapabilityPicker 搜索框原先都带 autoFocus，两个焦点竞争由
 * DOM 顺序后者（picker）赢——系统任务下 picker 被禁用，焦点落在禁用控件上。
 * 现口径：弹窗内唯一 autoFocus 落在描述框（最通用的可编辑字段），
 * CapabilityPicker 的 autoFocus 由宿主显式关闭。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render} from '@testing-library/react'
import {ScheduleEditModal} from '../../../../src/renderer/components/dialogs/ScheduleEditModal'

function stubElectron() {
    vi.stubGlobal('electronAPI', {
        getPlatform: vi.fn().mockResolvedValue('win32'),
        workspace: {
            getCurrent: vi.fn().mockResolvedValue(null),
            list: vi.fn().mockResolvedValue([{id: 'ws-1', name: '主工作区', path: 'E:/ws1'}]),
        },
        capability: {query: vi.fn().mockResolvedValue([]), onCapabilityChanged: vi.fn(() => () => {})},
    })
}

beforeEach(stubElectron)
afterEach(() => vi.unstubAllGlobals())

const base = {
    id: 's1',
    name: '每日构建',
    taskType: 'agent' as const,
    taskTarget: 'code-reviewer',
    cronExpression: '0 9 * * *',
    enabled: true,
    workspaceId: 'ws-1',
}

describe('初始焦点落在描述输入框', () => {
    it('普通任务：打开弹窗焦点在描述框', async () => {
        render(<ScheduleEditModal initial={base} onSave={vi.fn()} onClose={vi.fn()}/>)
        await vi.waitFor(() => {
            expect(document.activeElement).toBeInstanceOf(HTMLInputElement)
            expect((document.activeElement as HTMLInputElement).dataset.name).toBe('schedule-edit-modal-description-input')
        })
    })

    it('系统任务：picker 已禁用，焦点仍在描述框，不落在任何禁用控件上', async () => {
        render(<ScheduleEditModal initial={base} onSave={vi.fn()} onClose={vi.fn()} isSystem={true}/>)
        await vi.waitFor(() => {
            expect((document.activeElement as HTMLInputElement).dataset.name).toBe('schedule-edit-modal-description-input')
            expect((document.activeElement as HTMLElement).hasAttribute('disabled')).toBe(false)
        })
    })
})
