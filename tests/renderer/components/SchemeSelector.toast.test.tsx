// @vitest-environment jsdom
/**
 * 模型方案切换 Toast 回归测试
 *
 * 覆盖：
 * 1. 切换成功 → 顶部居中提示出现在 document.body 下（portal），
 *    不再被祖先 .app-surface-card（bg-enabled 下 backdrop-filter 创建包含块）困住
 * 2. 切换失败 → 提示"方案切换失败"，同样挂在 body 上
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, fireEvent, waitFor, act} from '@testing-library/react'
import SchemeSelector from '../../../src/renderer/components/SchemeSelector'

const {mockSwitchActiveScheme} = vi.hoisted(() => ({
    mockSwitchActiveScheme: vi.fn(async () => ({switched: true, schemeName: '方案B'})),
}))

vi.mock('../../../src/renderer/stores/modelSchemeStore', () => {
    const state = {
        schemes: [
            {id: 'a', name: '方案A', enabled: true},
            {id: 'b', name: '方案B', enabled: true},
        ],
        activeSchemeId: 'a',
    }
    return {
        // 兼容两种调用形式：带 selector（订阅片段）与无参（取整个 state）
        useModelSchemeStore: (selector?: any) => (selector ? selector(state) : state),
        switchActiveScheme: mockSwitchActiveScheme,
    }
})

beforeEach(() => {
    mockSwitchActiveScheme.mockResolvedValue({switched: true, schemeName: '方案B'})
})

afterEach(() => {
    vi.clearAllMocks()
})

/** 打开下拉并点击"方案B"（异步切换，用 act 包裹以冲刷状态更新） */
async function switchToSchemeB() {
    fireEvent.click(document.querySelector('[data-name="scheme-selector-select-button"]') as HTMLButtonElement)
    const buttons = Array.from(document.querySelectorAll('[data-name="scheme-selector-button"]'))
    const target = buttons.find((b) => b.textContent?.includes('方案B')) as HTMLButtonElement
    await act(async () => {
        fireEvent.click(target)
    })
}

describe('SchemeSelector Toast', () => {
    it('切换成功提示挂载到 body 且视口顶部居中定位', async () => {
        const {container} = render(<SchemeSelector/>)
        await switchToSchemeB()

        await waitFor(() => {
            const toast = document.querySelector('[role="status"]') as HTMLElement | null
            expect(toast).not.toBeNull()
            expect(toast!.textContent).toContain('已切换至「方案B」')
            // portal 到 body，脱离 sidebar 卡片包含块
            expect(toast!.parentElement).toBe(document.body)
            // 视口顶部居中定位
            expect(toast!.className).toContain('fixed')
            expect(toast!.className).toContain('left-1/2')
            // 不在组件子树内
            expect(container.querySelector('[role="status"]')).toBeNull()
        })
    })

    it('切换失败提示"方案切换失败"且挂载到 body', async () => {
        mockSwitchActiveScheme.mockRejectedValueOnce(new Error('boom'))
        render(<SchemeSelector/>)
        await switchToSchemeB()

        await waitFor(() => {
            const toast = document.querySelector('[role="status"]') as HTMLElement | null
            expect(toast).not.toBeNull()
            expect(toast!.textContent).toContain('方案切换失败')
            expect(toast!.parentElement).toBe(document.body)
        })
    })
})
