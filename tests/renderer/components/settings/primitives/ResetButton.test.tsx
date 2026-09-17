// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, cleanup, act} from '@testing-library/react'
import ResetButton from '../../../../../src/renderer/components/settings/primitives/ResetButton'
import {useSettingsStore} from '../../../../../src/renderer/stores/settingsStore'

describe('ResetButton', () => {
    beforeEach(() => cleanup())
    afterEach(() => cleanup())

    it('点击调用 resetFieldsToDefault(paths)，完成文案 1.5s 后复原', () => {
        vi.useFakeTimers()
        try {
            const spy = vi.fn()
            useSettingsStore.setState({resetFieldsToDefault: spy} as any)
            render(<ResetButton paths={['ui.theme', 'ui.background']}/>)
            fireEvent.click(screen.getByText('恢复本页默认'))
            expect(spy).toHaveBeenCalledWith(['ui.theme', 'ui.background'])
            expect(screen.getByText('已恢复默认')).toBeTruthy()
            act(() => { vi.advanceTimersByTime(1500) })
            expect(screen.getByText('恢复本页默认')).toBeTruthy()
        } finally {
            vi.useRealTimers()
        }
    })
})
