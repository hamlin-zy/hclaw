// @vitest-environment jsdom
import {describe, it, expect} from 'vitest'
import {render, screen} from '@testing-library/react'
import FormRow from '../../../../../src/renderer/components/settings/primitives/FormRow'

describe('FormRow', () => {
    it('渲染标签 / 提示 / 说明与右侧控件', () => {
        render(
            <FormRow label="默认温度" tip="范围 0-2" description="留空使用默认">
                <input data-testid="ctl"/>
            </FormRow>,
        )
        expect(screen.getByText('默认温度')).toBeTruthy()
        expect(document.querySelector('[data-tooltip]')!.getAttribute('data-tooltip')).toBe('范围 0-2')
        expect(screen.getByText('留空使用默认')).toBeTruthy()
        expect(screen.getByTestId('ctl')).toBeTruthy()
    })
})
