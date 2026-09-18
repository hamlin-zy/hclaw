// @vitest-environment jsdom
import {describe, it, expect, vi} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import NumberField from '../../../../../src/renderer/components/settings/primitives/NumberField'

describe('NumberField', () => {
    it('unit 后缀渲染', () => {
        render(<NumberField label="最大并发数" value={3} onChange={() => {}} fallback={3} unit="个"/>)
        expect(screen.getByText('个')).toBeTruthy()
    })

    it('低于 min：危险态提示 + 回退文案', () => {
        render(<NumberField label="最大尝试次数" value={0} onChange={() => {}} fallback={10} min={1}/>)
        expect(screen.getByText('值无效，已还原为 10')).toBeTruthy()
    })

    it('onChange 解析（decimals=1 走 parseFloat）', () => {
        const onChange = vi.fn()
        render(<NumberField label="首次重试延迟" value={5} onChange={onChange} fallback={5} decimals={1} unit="秒"/>)
        fireEvent.change(screen.getByRole('spinbutton'), {target: {value: '2.5'}})
        expect(onChange).toHaveBeenCalledWith(2.5)
    })
})
