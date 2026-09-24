// @vitest-environment jsdom
//
// 选区策略的「渲染锚点」测试：与 selectionPolicy.test.ts 的源码文本断言互补。
// 这里真实挂载组件，断言渲染结果里确实带上了挂点类名——即挂点在运行时生效，
// 而不只是源码里写了字符串。
//
// jsdom 无布局、无 UA 选区行为，「能不能选中」只能由真机验收单兜底
// （见 .superpowers/sdd/2026-09-23-selection-suppression/manual-acceptance.md）。
import {describe, it, expect, vi, afterEach} from 'vitest'
import {render, screen, waitFor} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {Modal} from '../../src/renderer/components/common/Modal'
import ConfigDialogWindow from '../../src/renderer/components/ConfigDialogWindow'

/** 独立配置窗口最小 API 桩：仅补齐挂载即调用的非可选链调用 */
function stubApi(dialogType: string) {
    vi.stubGlobal('electronAPI', {
        initialTheme: 'dark',
        windowId: dialogType,
        dialogType,
        windowControls: {
            minimize: vi.fn(),
            maximize: vi.fn(),
            close: vi.fn(),
            isMaximized: vi.fn().mockResolvedValue(false),
            onMaximizedChange: vi.fn().mockReturnValue(() => {}),
        },
        configGetHclawDir: vi.fn().mockResolvedValue(''),
        getAppVersion: vi.fn().mockResolvedValue('0.0.0'),
        // llmStore 持久化重水化调用（缺失会打印存储失败噪声）
        provider: {
            listWithModels: vi.fn().mockResolvedValue({success: true, data: []}),
        },
    })
}

describe('选区策略：渲染锚点 / Modal', () => {
    it('Modal 面板带上 select-text（弹窗正文可选中）', () => {
        render(<Modal open onClose={() => {}} ariaLabel="测试弹窗">正文</Modal>)
        const panel = screen.getByRole('dialog')
        expect(panel).toHaveClass('select-text')
    })

    it('Modal 关闭时不渲染任何节点', () => {
        const {container} = render(<Modal open={false} onClose={() => {}} ariaLabel="测试弹窗">正文</Modal>)
        expect(container).toBeEmptyDOMElement()
    })
})

describe('选区策略：渲染锚点 / ConfigDialogWindow', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('未知类型分支：内容容器带 select-text，且该容器确实包住内容', () => {
        stubApi('unknown-type')
        const {container} = render(<ConfigDialogWindow/>)
        // 内容容器无 data-* 锚点，用类名定位（与源码 class 列表一致）
        const content = container.querySelector<HTMLElement>('.flex-1.min-h-0.overflow-hidden.select-text')
        expect(content).not.toBeNull()
        // 该容器确实承载内容（而不是被挂到空壳上）
        expect(content!.contains(screen.getByText(/未知配置类型/))).toBe(true)
    })

    it('懒加载内容分支：chunk 落地后内容容器仍带 select-text', async () => {
        stubApi('llm-config')
        const {container} = render(<ConfigDialogWindow/>)
        await waitFor(
            () => expect(screen.queryByTestId('dialog-loading-fallback')).toBeNull(),
            {timeout: 5000},
        )
        expect(screen.queryByText('窗口资源加载失败')).toBeNull()
        const content = container.querySelector<HTMLElement>('.flex-1.min-h-0.overflow-hidden.select-text')
        expect(content).not.toBeNull()
        expect(content!.childElementCount).toBeGreaterThan(0)
    })
})
