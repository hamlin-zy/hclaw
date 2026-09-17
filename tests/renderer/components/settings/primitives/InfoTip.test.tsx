// @vitest-environment jsdom
import {describe, it, expect} from 'vitest'
import {render} from '@testing-library/react'
import InfoTip from '../../../../../src/renderer/components/settings/primitives/InfoTip'

describe('InfoTip', () => {
    it('data-tooltip / aria-label / tabIndex 与 sr-only 关联', () => {
        render(<InfoTip text="下次任务生效" id="tip-1"/>)
        const icon = document.querySelector('[data-tooltip]') as HTMLElement
        expect(icon.getAttribute('data-tooltip')).toBe('下次任务生效')
        expect(icon.getAttribute('aria-label')).toBe('下次任务生效')
        expect(icon.getAttribute('tabindex')).toBe('0')
        const sr = document.getElementById('tip-1')!
        expect(sr.textContent).toBe('下次任务生效')
        expect(sr.className).toContain('sr-only')
    })
})
