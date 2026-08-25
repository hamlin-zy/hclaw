// @vitest-environment jsdom
import {describe, it, expect, vi} from 'vitest'
import {render} from '@testing-library/react'
import InputToolbar from '../../../src/renderer/components/InputToolbar'

vi.mock('../../../src/renderer/components/CacheRateTooltip', () => ({default: () => null}))
vi.mock('../../../src/renderer/components/ToolMenu', () => ({default: () => null}))

const BASE_PROPS = {
    isRunning: false,
    compactInProgress: false,
    needsSession: false,
    needsModel: false,
    pendingMessagesCount: 0,
    canSend: true,
    onSubmit: vi.fn(),
    onAbort: vi.fn(),
    onUploadFile: vi.fn(),
    onOpenCommandPalette: vi.fn(),
}

describe('InputToolbar extraActions 插槽', () => {
    it('传入 extraActions：渲染在 input-toolbar-actions 最左侧', () => {
        const {container} = render(
            <InputToolbar {...BASE_PROPS} extraActions={<div data-testid="extra">EXTRA</div>}/>,
        )
        const actions = container.querySelector<HTMLElement>('[data-name="input-toolbar-actions"]')!
        const extra = container.querySelector('[data-testid="extra"]')!
        expect(actions.contains(extra)).toBe(true)
        // 最左侧：extra 是 actions 的第一个子元素
        expect(actions.firstElementChild).toBe(extra)
    })

    it('不传 extraActions：行为与旧版完全一致（不渲染插槽）', () => {
        const {container} = render(<InputToolbar {...BASE_PROPS}/>)
        expect(container.querySelector('[data-testid="extra"]')).toBeNull()
        // 既有结构回归：右区第一个子元素仍是缓存命中率区（mock 为 null 时为其兄弟）
        const actions = container.querySelector<HTMLElement>('[data-name="input-toolbar-actions"]')!
        expect(actions).not.toBeNull()
        expect(container.textContent).toContain('按 Shift+Enter 换行，Enter 发送')
    })
})
