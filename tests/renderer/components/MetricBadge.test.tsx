// @vitest-environment jsdom
import {describe, it, expect} from 'vitest'
import {render, screen} from '@testing-library/react'
import MetricBadge from '../../../src/renderer/components/MetricBadge'

describe('MetricBadge 指标徽章', () => {
    it('渲染文字内容 + 进度环层（pct 提供时）', () => {
        const {container} = render(<MetricBadge pct={42}>缓存 42%</MetricBadge>)
        expect(screen.getByText('缓存 42%')).toBeTruthy()
        // 环层：absolute inset-0 rounded-full（conic-gradient 进度环）
        const ring = container.querySelector('span.absolute.inset-0')
        expect(ring).toBeTruthy()
        expect(ring!.getAttribute('style')).toContain('conic-gradient')
    })

    it('无 pct → 纯色静态边框环（100% 填充）', () => {
        const {container} = render(<MetricBadge accent="var(--warning)">12.5 t/s</MetricBadge>)
        const ring = container.querySelector('span.absolute.inset-0')
        expect(ring!.getAttribute('style')).toContain('conic-gradient(var(--warning) 100%')
        // 无 pct 时文字着色为 accent
        const txt = screen.getByText('12.5 t/s')
        expect(txt.getAttribute('style')).toContain('color: var(--warning)')
    })

    it('内置分级：pct <50 绿 / 50-80 黄 / >=80 红（未显式传 accent）', () => {
        const {container, rerender} = render(<MetricBadge pct={20}>a</MetricBadge>)
        let ring = container.querySelector('span.absolute.inset-0')
        expect(ring!.getAttribute('style')).toContain('var(--success)')
        rerender(<MetricBadge pct={60}>b</MetricBadge>)
        ring = container.querySelector('span.absolute.inset-0')
        expect(ring!.getAttribute('style')).toContain('var(--warning)')
        rerender(<MetricBadge pct={90}>c</MetricBadge>)
        ring = container.querySelector('span.absolute.inset-0')
        expect(ring!.getAttribute('style')).toContain('var(--error)')
    })

    it('显式 accent 覆盖内置分级', () => {
        const {container} = render(<MetricBadge pct={95} accent="var(--info)">x</MetricBadge>)
        const ring = container.querySelector('span.absolute.inset-0')
        expect(ring!.getAttribute('style')).toContain('var(--info)')
    })

    it('icon 渲染在文字前，且颜色与语义色一致', () => {
        const {container} = render(
            <MetricBadge pct={80} accent="var(--success)" icon={<svg data-testid="badge-icon"/>}>缓存 80%</MetricBadge>
        )
        const icon = container.querySelector('svg[data-testid="badge-icon"]')
        expect(icon).toBeTruthy()
        // 图标包裹层着色 = resolvedAccent
        const iconWrap = icon!.closest('span')!
        expect(iconWrap.getAttribute('style')).toContain('color: var(--success)')
        // 图标在文字之前：文字层 span 的第一个子元素即图标包裹层
        const txt = screen.getByText('缓存 80%')
        expect(txt.firstElementChild).toBe(iconWrap)
    })

    it('无 pct + icon → 图标与文字同为 accent 色', () => {
        const {container} = render(
            <MetricBadge accent="var(--warning)" icon={<svg data-testid="badge-icon2"/>}>12 t/s</MetricBadge>
        )
        const iconWrap = container.querySelector('svg[data-testid="badge-icon2"]')!.closest('span')!
        expect(iconWrap.getAttribute('style')).toContain('color: var(--warning)')
        expect(screen.getByText('12 t/s').getAttribute('style')).toContain('color: var(--warning)')
    })
})
