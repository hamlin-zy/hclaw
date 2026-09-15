// @vitest-environment jsdom
/**
 * StatusBadge — 启用/禁用状态徽章测试
 *
 * 覆盖：启用/禁用两态文案、关键类名（基准样式令牌）、自定义 label、
 * data-name 钩子与 className 透传。
 */
import {describe, it, expect, afterEach} from 'vitest'
import {render, screen, cleanup} from '@testing-library/react'
import {StatusBadge} from '@/renderer/components/common/StatusBadge'

afterEach(() => cleanup())

describe('StatusBadge', () => {
    it('启用态：显示「已启用」并使用 tag-dev 令牌', () => {
        render(<StatusBadge enabled/>)
        const el = screen.getByText('已启用')
        expect(el).toBeTruthy()
        expect(el.className).toContain('inline-flex')
        expect(el.className).toContain('items-center')
        expect(el.className).toContain('rounded')
        expect(el.className).toContain('px-2')
        expect(el.className).toContain('py-1')
        expect(el.className).toContain('text-[10px]')
        expect(el.className).toContain('font-medium')
        expect(el.className).toContain('bg-[var(--tag-dev-bg)]')
        expect(el.className).toContain('text-[var(--tag-dev-text)]')
        expect(el.className).toContain('border-[var(--tag-dev-border)]')
    })

    it('禁用态：显示「已禁用」并使用中性 surface-muted 令牌', () => {
        render(<StatusBadge enabled={false}/>)
        const el = screen.getByText('已禁用')
        expect(el).toBeTruthy()
        expect(el.className).toContain('bg-[var(--surface-muted)]')
        expect(el.className).toContain('text-[var(--text-muted)]')
        expect(el.className).toContain('border-[var(--border)]')
        // 不再是错误/警告色
        expect(el.className).not.toContain('var(--error)')
        expect(el.className).not.toContain('var(--warning)')
    })

    it('data-name 钩子可用', () => {
        render(<StatusBadge enabled/>)
        expect(document.querySelector('[data-name="status-badge"]')).toBeTruthy()
    })

    it('自定义 label 覆盖缺省文案', () => {
        render(<StatusBadge enabled enabledLabel="开启中" disabledLabel="已关闭"/>)
        expect(screen.getByText('开启中')).toBeTruthy()
        cleanup()
        render(<StatusBadge enabled={false} enabledLabel="开启中" disabledLabel="已关闭"/>)
        expect(screen.getByText('已关闭')).toBeTruthy()
    })

    it('className 透传到容器（布局由调用方决定）', () => {
        render(<StatusBadge enabled className="ml-2 shrink-0"/>)
        const el = screen.getByText('已启用')
        expect(el.className).toContain('ml-2')
        expect(el.className).toContain('shrink-0')
    })
})
