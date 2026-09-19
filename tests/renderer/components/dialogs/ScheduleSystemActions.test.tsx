// @vitest-environment jsdom
/**
 * ScheduleSystemActions — 「还原默认」按钮的禁用态（漂移检测联动）
 *
 * 钉住：disabled 时按钮 disabled、title=「配置与默认一致，无需还原」、点击不触发回调；
 * 启用时点击弹出通用确认弹窗（ConfirmDialog），确认后才执行还原。
 */
import {describe, it, expect, vi} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import {ScheduleSystemActions} from '../../../../src/renderer/components/dialogs/ScheduleSystemActions'
import ConfirmDialog from '../../../../src/renderer/components/ConfirmDialog'

describe('ScheduleSystemActions — disabled（未漂移）', () => {
    it('disabled 时按钮 disabled、title 正确、点击不触发 onRestoreDefault', () => {
        const onRestoreDefault = vi.fn()
        render(<ScheduleSystemActions scheduleId="sys-x" onRestoreDefault={onRestoreDefault} disabled={true}/>)
        const button = screen.getByLabelText('还原默认') as HTMLButtonElement
        expect(button.disabled).toBe(true)
        expect(button.title).toBe('配置与默认一致，无需还原')
        fireEvent.click(button)
        expect(onRestoreDefault).not.toHaveBeenCalled()
    })

    it('未禁用时点击弹通用确认弹窗，确认后才执行还原', async () => {
        const onRestoreDefault = vi.fn(async () => {})
        render(
            <>
                <ScheduleSystemActions scheduleId="sys-x" onRestoreDefault={onRestoreDefault}/>
                <ConfirmDialog/>
            </>
        )
        fireEvent.click(screen.getByLabelText('还原默认'))
        // 确认弹窗出现，还原尚未执行
        await waitFor(() => expect(screen.getByText('还原默认')).toBeTruthy())
        expect(onRestoreDefault).not.toHaveBeenCalled()
        fireEvent.click(screen.getByText('还原'))
        await waitFor(() => expect(onRestoreDefault).toHaveBeenCalledTimes(1))
    })

    it('未禁用时在确认弹窗点取消，不执行还原', async () => {
        const onRestoreDefault = vi.fn(async () => {})
        render(
            <>
                <ScheduleSystemActions scheduleId="sys-x" onRestoreDefault={onRestoreDefault}/>
                <ConfirmDialog/>
            </>
        )
        fireEvent.click(screen.getByLabelText('还原默认'))
        await waitFor(() => expect(screen.getByTestId('confirm-dialog-mask')).toBeTruthy())
        fireEvent.click(screen.getByTestId('confirm-dialog-mask'))
        await waitFor(() => expect(screen.queryByTestId('confirm-dialog-mask')).toBeNull())
        expect(onRestoreDefault).not.toHaveBeenCalled()
    })
})
