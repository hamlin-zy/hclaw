// @vitest-environment jsdom
import {describe, it, expect} from 'vitest'
import {render, screen} from '@testing-library/react'
import SectionHeader from '../../../../../src/renderer/components/settings/primitives/SectionHeader'

describe('SectionHeader', () => {
    it('渲染为 h3 分节标题', () => {
        render(<SectionHeader>上下文交接</SectionHeader>)
        expect(screen.getByText('上下文交接').tagName).toBe('H3')
    })
})
