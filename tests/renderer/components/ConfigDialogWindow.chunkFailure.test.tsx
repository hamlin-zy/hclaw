// @vitest-environment jsdom
/**
 * lazy chunk 加载失败 → DialogChunkErrorBoundary 兜底（T19）。
 * 通过让 AboutDialog 模块工厂抛错模拟 chunk 加载失败。
 */
import {describe, it, expect, vi, afterEach} from 'vitest'
import {render, screen} from '@testing-library/react'

vi.mock('../../../src/renderer/components/dialogs/AboutDialog', () => {
    throw new Error('chunk load failed')
})

import ConfigDialogWindow from '../../../src/renderer/components/ConfigDialogWindow'

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('ConfigDialogWindow chunk 失败边界', () => {
    it('chunk 加载失败：显示「窗口资源加载失败」与「重新加载」按钮', async () => {
        vi.stubGlobal('electronAPI', {
            initialTheme: 'dark',
            windowId: 'about',
            dialogType: 'about',
            windowControls: {
                minimize: vi.fn(), maximize: vi.fn(), close: vi.fn(),
                isMaximized: vi.fn().mockResolvedValue(false),
                onMaximizedChange: vi.fn().mockReturnValue(() => {}),
            },
            getAppVersion: vi.fn().mockResolvedValue('0.0.0'),
        })
        render(<ConfigDialogWindow/>)
        expect(await screen.findByText('窗口资源加载失败')).toBeTruthy()
        expect(screen.getByText('重新加载')).toBeTruthy()
    })
})
