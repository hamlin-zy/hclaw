// @vitest-environment jsdom
/**
 * InputToolbar — 窄窗口下统计信息溢出隐藏回归测试
 *
 * 修复前：窗口宽度不足时，左区状态文案与右区统计徽章（缓存命中率/窗口占用/吞吐）
 * 作为 flex 项目被默认压缩（flex-shrink: 1），且内部文字无 nowrap/truncate 保护，
 * 导致徽章文字折行、整体被挤压变形。
 *
 * 修复方案（契约）：
 * - 左区 input-toolbar-status：flex-1 min-w-0（可收缩），内部文案 span 加 truncate + min-w-0（溢出省略号截断）
 * - 右区 input-toolbar-actions：shrink-0（统计徽章/按钮绝不压缩）
 * - pendingMessages 徽章：shrink-0 whitespace-nowrap（不被压缩换行）
 * - MetricBadge：shrink-0 whitespace-nowrap（胶囊内文字永不被压折行）
 * - CacheRateTooltip 徽章容器与真实渲染：见 CacheRateTooltip.overflow.test.tsx
 *
 * jsdom 无布局引擎，无法测真实换行，采用契约断言锁定 class 保护，防止回归。
 */
import {describe, it, expect, vi} from 'vitest'
import {render, screen} from '@testing-library/react'
import InputToolbar from '../../../src/renderer/components/InputToolbar'
import MetricBadge from '../../../src/renderer/components/MetricBadge'

vi.mock('../../../src/renderer/components/CacheRateTooltip', () => ({
    default: () => null,
}))
vi.mock('../../../src/renderer/components/ToolMenu', () => ({
    default: () => null,
}))

const BASE_PROPS = {
    isRunning: false,
    compactInProgress: false,
    needsSession: false,
    needsModel: false,
    pendingMessagesCount: 2,
    canSend: true,
    onSubmit: vi.fn(),
    onAbort: vi.fn(),
    onUploadFile: vi.fn(),
    onOpenDialog: vi.fn(),
    onOpenCommandPalette: vi.fn(),
}

describe('InputToolbar 窄窗口溢出保护契约', () => {
    it('右区操作区 shrink-0：统计徽章/按钮不被 flex 压缩', () => {
        const {container} = render(<InputToolbar {...BASE_PROPS}/>)
        const actions = container.querySelector<HTMLElement>('[data-name="input-toolbar-actions"]')
        expect(actions).not.toBeNull()
        expect(actions!.className).toContain('shrink-0')
    })

    it('左区状态区 flex-1 min-w-0：允许收缩且内容可截断', () => {
        const {container} = render(<InputToolbar {...BASE_PROPS}/>)
        const status = container.querySelector<HTMLElement>('[data-name="input-toolbar-status"]')
        expect(status).not.toBeNull()
        expect(status!.className).toContain('flex-1')
        expect(status!.className).toContain('min-w-0')
    })

    it('运行态模型文案已合并至气泡：isRunning 时不渲染运行文案', () => {
        const {container} = render(<InputToolbar {...BASE_PROPS} isRunning/>)
        expect(screen.queryByText(/运行中/)).toBeNull()
        expect(screen.queryByText(/思考中/)).toBeNull()
        // 不包含模型名文案（"服务商/模型"字样）
        expect(container.textContent).not.toContain('OpenRouter/deepseek-v3')
    })

    it('pendingMessages 待处理徽章 shrink-0 whitespace-nowrap：不被压缩换行', () => {
        const {container} = render(<InputToolbar {...BASE_PROPS}/>)
        const pending = [...container.querySelectorAll<HTMLElement>('span')].find((el) =>
            el.textContent?.includes('条消息待处理'),
        )
        expect(pending).not.toBeNull()
        expect(pending!.className).toContain('shrink-0')
        expect(pending!.className).toContain('whitespace-nowrap')
    })

    it('各状态文案均有 truncate 保护（非运行态分支不遗漏）', () => {
        const cases = [
            {props: {needsSession: true}, text: '请先选择工作目录和会话'},
            {props: {needsModel: true}, text: '请先在右上角选择 LLM 服务商'},
            {props: {}, text: '按 Shift+Enter 换行，Enter 发送'},
        ]
        for (const {props, text} of cases) {
            const {container, unmount} = render(<InputToolbar {...BASE_PROPS} {...props}/>)
            const status = container.querySelector<HTMLElement>('[data-name="input-toolbar-status"]')
            const el = [...(status?.querySelectorAll('span') ?? [])].find((s) => s.textContent === text)
            expect(el, `文案「${text}」缺少 truncate 保护`).toBeTruthy()
            expect(el!.className).toContain('truncate')
            unmount()
        }
    })
})

describe('MetricBadge 窄窗口保护契约', () => {
    it('shrink-0 whitespace-nowrap：胶囊文字永不被压折行', () => {
        const {container} = render(<MetricBadge pct={85}>缓存 85%</MetricBadge>)
        const badge = container.firstChild as HTMLElement
        expect(badge.className).toContain('shrink-0')
        expect(badge.className).toContain('whitespace-nowrap')
    })

    it('文字层保留可读内容（不因保护类导致文字丢失）', () => {
        const {container} = render(<MetricBadge pct={85}>缓存 85%</MetricBadge>)
        expect(container.textContent).toContain('缓存 85%')
        expect(screen.getByText('缓存 85%')).toBeTruthy()
    })
})
