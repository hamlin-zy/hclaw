// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent, waitFor, type RenderResult} from '@testing-library/react'
import {FilePicker} from '../../../src/renderer/components/FilePicker'

// ── 依赖 mock ──
const {mockConversationState, workspaceReadDirMock} = vi.hoisted(() => ({
    mockConversationState: {
        currentWorkspacePath: 'E:/workspace/demo',
    },
    workspaceReadDirMock: vi.fn(),
}))

vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (selector: (s: typeof mockConversationState) => unknown) =>
        selector(mockConversationState),
}))

// loadDir 依赖 window.electronAPI.workspaceReadDir
beforeEach(() => {
    vi.stubGlobal('electronAPI', {
        workspaceReadDir: workspaceReadDirMock,
    })
    // jsdom 未实现 Element.scrollIntoView（FilePicker 选中项滚动定位）
    Element.prototype.scrollIntoView = vi.fn()
    workspaceReadDirMock.mockReset()
    // loadDir 排序：目录优先，同类型按名称升序 → filtered = [docs, app.ts, readme.md]
    workspaceReadDirMock.mockResolvedValue([
        {name: 'docs', path: 'E:/workspace/demo/docs', isDirectory: true},
        {name: 'readme.md', path: 'E:/workspace/demo/readme.md', isDirectory: false},
        {name: 'app.ts', path: 'E:/workspace/demo/app.ts', isDirectory: false},
    ])
})

/** 渲染并等待目录加载完成 */
async function renderPicker(handlers: {
    onNavigate?: (subdir: string) => void
    onClose?: () => void
    onGoBack?: () => void
    onConfirm?: (badgeText: string) => void
} = {}): Promise<RenderResult> {
    const result = render(
        <FilePicker
            query=""
            currentNav=""
            onClose={handlers.onClose ?? vi.fn()}
            onNavigate={handlers.onNavigate ?? vi.fn()}
            onGoBack={handlers.onGoBack ?? vi.fn()}
            onConfirm={handlers.onConfirm ?? vi.fn()}
        />,
    )
    await waitFor(() => expect(screen.getByText('readme.md')).toBeTruthy())
    return result
}

/** 触发容器级 keyDown（onKeyDown 挂在根 motion.div 上） */
function pressKey(result: RenderResult, key: string): void {
    fireEvent.keyDown(result.container.firstChild as HTMLElement, {key})
}

/** 移动到第 i 个条目（ArrowDown 从 0 递增） */
function selectIndex(result: RenderResult, index: number): void {
    for (let i = 0; i < index; i++) pressKey(result, 'ArrowDown')
}

describe('FilePicker toggle 逻辑（Task 4 改写的目录/文件分支）', () => {
    it('文件项 Enter → toggleBadge（选中/取消切换）', async () => {
        const result = await renderPicker()
        // filtered = [docs, app.ts, readme.md] → sel=2 为文件
        selectIndex(result, 2)
        expect(screen.getByText('Tab 选中')).toBeTruthy()

        // 首次 Enter → 选中（出现"已选"标记）
        pressKey(result, 'Enter')
        expect(screen.getByText(/已选/)).toBeTruthy()

        // 再次 Enter → 取消选中（"已选"标记消失）
        pressKey(result, 'Enter')
        expect(screen.queryByText(/已选/)).toBeNull()
    })

    it('目录项 Enter → onNavigate + 清空 badges（确认按钮消失）', async () => {
        const onNavigate = vi.fn()
        const onConfirm = vi.fn()
        const result = await renderPicker({onNavigate, onConfirm})

        // 先选中 readme.md（sel=2）Enter 产生 badge
        selectIndex(result, 2)
        pressKey(result, 'Enter')
        expect(screen.getByText(/已选/)).toBeTruthy()

        // 回到目录 docs（sel=0）Enter → 目录分支：onNavigate + setBadges([])
        pressKey(result, 'ArrowUp')
        pressKey(result, 'ArrowUp')
        expect(screen.getByText('Tab 进入')).toBeTruthy()
        pressKey(result, 'Enter')

        expect(onNavigate).toHaveBeenCalledWith('docs')
        // badges 被清空 → 确认按钮与"已选"标记均消失
        expect(screen.queryByText(/确认/)).toBeNull()
        expect(screen.queryByText(/已选/)).toBeNull()
    })
})
