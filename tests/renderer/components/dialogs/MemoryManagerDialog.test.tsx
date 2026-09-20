// @vitest-environment jsdom
/**
 * MemoryManagerDialog 组件测试（memory-manager Task 4）
 *
 * 覆盖：
 * 1. 窗口标题渲染 + 树加载（用户偏好 / 记忆索引 / 项目分组）
 * 2. 空树空态文案
 * 3. 语义 label 树渲染
 * 4. 点击文件节点加载内容 → 默认 Markdown 预览
 * 5. 状态栏字节数
 * 6. 编辑按钮切换到编辑态（MemoryEditor）
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {useMemoryManagerStore} from '@/renderer/stores/memoryManagerStore'
import {confirm} from '@/renderer/components/ConfirmDialog'

vi.mock('@/renderer/components/ConfirmDialog', () => ({
    confirm: vi.fn(async () => true),
    default: () => null,
}))

vi.mock('@/renderer/project-manager/components/MarkdownPreview', () => ({
    MarkdownPreview: ({content}: {content: string}) => (
        <div data-testid="markdown-preview">{content}</div>
    ),
}))

vi.mock('@/renderer/components/dialogs/MemoryEditor', () => ({
    default: ({content, onChange}: {content: string; onChange?: (v: string) => void}) => (
        <textarea
            data-testid="code-editor"
            defaultValue={content}
            onChange={(e) => onChange?.(e.target.value)}
        />
    ),
}))

import MemoryManagerDialog from '@/renderer/components/dialogs/MemoryManagerDialog'

const listResult = {
    globalFiles: [
        {path: '/ref/_user/preferences.md', label: '跨项目偏好', sizeLimit: 4096},
    ],
    projects: [
        {
            dir: 'hclaw',
            projectName: 'hclaw',
            workspacePath: 'E:\\hclaw',
            memoryFile: {path: '/ref/hclaw/memory.md', label: '项目记忆', sizeLimit: 8192},
            archiveFiles: [],
        },
    ],
}

function stubMemoryApi(overrides?: Partial<Record<string, ReturnType<typeof vi.fn>>>) {
    const memory = {
        list: vi.fn(async () => listResult),
        read: vi.fn(async () => ({content: '# Project Memory\n\nContent here'})),
        write: vi.fn(async () => ({success: true})),
        delete: vi.fn(async () => ({success: true})),
        ...overrides,
    }
    ;(window as any).electronAPI = {memory}
    return memory
}

/** 默认全折叠：先展开「用户偏好」根节点再访问其子文件 */
async function expandUserPrefs() {
    await waitFor(() => {
        expect(screen.getByText('用户偏好')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('用户偏好'))
    await waitFor(() => {
        expect(screen.getByText('跨项目偏好')).toBeInTheDocument()
    })
}

const gualiListResult = {
    globalFiles: [],
    projects: [
        {
            dir: 'guali',
            projectName: 'guali',
            workspacePath: 'E:\\guali',
            // F-2 反例：归档卷文件名内含目录名子串，且无 memoryFile
            memoryFile: undefined,
            archiveFiles: [
                {path: '/ref/guali/archive/guali-2026-09.md', label: 'guali-2026-09', sizeLimit: 0},
            ],
        },
    ],
}

const gualiWinListResult = {
    globalFiles: [],
    projects: [
        {
            dir: 'guali',
            projectName: 'guali',
            workspacePath: 'E:\\guali',
            memoryFile: undefined,
            archiveFiles: [
                {path: 'E:\\hclaw\\ref\\guali\\archive\\guali-2026-09.md', label: 'guali-2026-09', sizeLimit: 0},
            ],
        },
    ],
}

const orphanListResult = {
    globalFiles: [],
    projects: [
        {
            dir: 'orphan',
            projectName: 'orphan',
            workspacePath: 'E:\\orphan',
            memoryFile: {path: '/other/x.md', label: '项目记忆', sizeLimit: 0},
            archiveFiles: [],
        },
    ],
}

describe('MemoryManagerDialog', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        stubMemoryApi()
        useMemoryManagerStore.getState().reset()
    })

    it('loads tree without duplicate body title (Trivial: 外壳 WindowTitleBar 已有标题)', async () => {
        render(<MemoryManagerDialog />)
        expect(screen.queryByText('记忆管理')).not.toBeInTheDocument()
        await waitFor(() => {
            expect(screen.getByText('用户偏好')).toBeInTheDocument()
            expect(screen.getByText('项目记忆')).toBeInTheDocument()
        })
    })

    it('shows empty state when tree is empty', async () => {
        stubMemoryApi({list: vi.fn(async () => ({globalFiles: [], projects: []}))})
        render(<MemoryManagerDialog />)
        await waitFor(() => {
            expect(screen.getByText(/暂无记忆文件/)).toBeInTheDocument()
        })
    })

    it('renders tree with semantic labels', async () => {
        render(<MemoryManagerDialog />)
        // 默认全折叠：初始仅根节点可见
        await waitFor(() => {
            expect(screen.getByText('用户偏好')).toBeInTheDocument()
            expect(screen.queryByText('跨项目偏好')).not.toBeInTheDocument()
        })
        fireEvent.click(screen.getByRole('button', {name: '展开全部'}))
        await waitFor(() => {
            expect(screen.getByText('跨项目偏好')).toBeInTheDocument()
            expect(screen.getByText('hclaw')).toBeInTheDocument()
            // 虚拟分组节点 + 项目文件同名，均为「项目记忆」
            expect(screen.getAllByText('项目记忆').length).toBeGreaterThanOrEqual(2)
        })
    })

    it('converges top level to 用户偏好/记忆索引/项目记忆; 记忆索引 collapsed by default with 自动生成', async () => {
        stubMemoryApi({list: vi.fn(async () => memListResult)})
        render(<MemoryManagerDialog />)
        await waitFor(() => {
            expect(screen.getByText('用户偏好')).toBeInTheDocument()
            expect(screen.getByText('项目记忆')).toBeInTheDocument()
            expect(screen.getByText('自动生成')).toBeInTheDocument()
            // 默认折叠：SKILL.md 文件节点（label 记忆索引）不可见，仅虚拟分组节点可见
            expect(screen.getAllByText('记忆索引')).toHaveLength(1)
        })
    })

    it('loads file content when clicking a file node', async () => {
        render(<MemoryManagerDialog />)
        await expandUserPrefs()
        fireEvent.click(screen.getByText('跨项目偏好'))
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
    })

    it('shows byte count in status bar', async () => {
        render(<MemoryManagerDialog />)
        await expandUserPrefs()
        fireEvent.click(screen.getByText('跨项目偏好'))
        await waitFor(() => {
            // '# Project Memory\n\nContent here' = 29 bytes UTF-8
            expect(screen.getByText(/bytes/)).toBeInTheDocument()
        })
    })

    it('switches to edit mode when clicking edit button', async () => {
        render(<MemoryManagerDialog />)
        await expandUserPrefs()
        fireEvent.click(screen.getByText('跨项目偏好'))
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        fireEvent.click(screen.getByText('编辑'))
        await waitFor(() => {
            expect(screen.getByTestId('code-editor')).toBeInTheDocument()
        })
    })

    // --- Fix round 1: F-2 / F-3 / F-4 / F-6 ---

    it('F-2: deletes project dir by segment reassembly, not substring (POSIX)', async () => {
        stubMemoryApi({list: vi.fn(async () => gualiListResult)})
        const {memory} = (window as any).electronAPI
        render(<MemoryManagerDialog />)
        await waitFor(() => {
            expect(screen.getByText('项目记忆')).toBeInTheDocument()
        })
        // 默认全折叠：先展开「项目记忆」根节点露出项目节点
        fireEvent.click(screen.getByText('项目记忆'))
        await waitFor(() => {
            expect(screen.getByText('guali')).toBeInTheDocument()
        })
        fireEvent.contextMenu(screen.getByText('guali'))
        await waitFor(() => {
            expect(memory.delete).toHaveBeenCalledWith('/ref/guali', true)
        })
    })

    it('F-2: deletes project dir by segment reassembly (Windows separators)', async () => {
        stubMemoryApi({list: vi.fn(async () => gualiWinListResult)})
        const {memory} = (window as any).electronAPI
        render(<MemoryManagerDialog />)
        await waitFor(() => {
            expect(screen.getByText('项目记忆')).toBeInTheDocument()
        })
        fireEvent.click(screen.getByText('项目记忆'))
        await waitFor(() => {
            expect(screen.getByText('guali')).toBeInTheDocument()
        })
        fireEvent.contextMenu(screen.getByText('guali'))
        await waitFor(() => {
            expect(memory.delete).toHaveBeenCalledWith('E:\\hclaw\\ref\\guali', true)
        })
    })

    it('F-3: edit mode dirty content triggers memory.write on mode switch back', async () => {
        const {memory} = (window as any).electronAPI
        render(<MemoryManagerDialog />)
        await expandUserPrefs()
        fireEvent.click(screen.getByText('跨项目偏好'))
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        fireEvent.click(screen.getByText('编辑'))
        await waitFor(() => {
            expect(screen.getByTestId('code-editor')).toBeInTheDocument()
        })
        fireEvent.change(screen.getByTestId('code-editor'), {target: {value: 'new content'}})
        // 切回预览 → 确认保存 → 应触发 memory.write
        fireEvent.click(screen.getByText('预览'))
        await waitFor(() => {
            expect(memory.write).toHaveBeenCalledWith('/ref/_user/preferences.md', 'new content')
        })
    })

    it('F-4: shows user-visible feedback when delete fails', async () => {
        stubMemoryApi({
            delete: vi.fn(async () => ({success: false, error: 'rm-failed', message: '删除失败'})),
        })
        render(<MemoryManagerDialog />)
        await expandUserPrefs()
        fireEvent.contextMenu(screen.getByText('跨项目偏好'))
        await waitFor(() => {
            expect(screen.getByRole('alert')).toBeInTheDocument()
        })
    })

    // --- Task 5: 边界用例（brief 缺口盘点后补充） ---

    it('edge: shows error state when read returns not-found (file deleted while selected)', async () => {
        stubMemoryApi({read: vi.fn(async () => ({error: 'not-found'}))})
        render(<MemoryManagerDialog />)
        await expandUserPrefs()
        fireEvent.click(screen.getByText('跨项目偏好'))
        await waitFor(() => {
            // 实现文案：store contentLoadError 非 save-failed → 「文件已被删除或无法读取」
            expect(screen.getByText(/文件已被删除/)).toBeInTheDocument()
        })
    })

    it('edge: shows empty content for empty file', async () => {
        stubMemoryApi({read: vi.fn(async () => ({content: ''}))})
        render(<MemoryManagerDialog />)
        await expandUserPrefs()
        fireEvent.click(screen.getByText('跨项目偏好'))
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toHaveTextContent('')
        })
    })

    it('edge: shows over-limit warning when content exceeds size limit', async () => {
        stubMemoryApi({read: vi.fn(async () => ({content: 'a'.repeat(5000)}))})
        render(<MemoryManagerDialog />)
        await expandUserPrefs()
        fireEvent.click(screen.getByText('跨项目偏好'))
        // preferences.md sizeLimit=4096，5000 字节内容 → 状态栏超限警示
        await waitFor(() => {
            expect(screen.getByText(/超限/)).toBeInTheDocument()
        })
    })

    it('edge: archive folder collapses by default and expands to show archive files', async () => {
        stubMemoryApi({
            list: vi.fn(async () => ({
                globalFiles: [],
                projects: [
                    {
                        dir: 'hclaw',
                        projectName: 'hclaw',
                        workspacePath: 'E:\\hclaw',
                        memoryFile: {path: '/ref/hclaw/memory.md', label: '项目记忆', sizeLimit: 8192},
                        archiveFiles: [
                            {path: '/ref/hclaw/archive/openrouter.md', label: 'OpenRouter 专项', sizeLimit: 0},
                        ],
                    },
                ],
            })),
        })
        render(<MemoryManagerDialog />)
        await waitFor(() => {
            expect(screen.getByText('项目记忆')).toBeInTheDocument()
        })
        // 默认全折叠：逐级展开「项目记忆」根 → hclaw 项目 → 归档卷可见；归档卷自身默认折叠
        fireEvent.click(screen.getByText('项目记忆'))
        await waitFor(() => {
            expect(screen.getByText('hclaw')).toBeInTheDocument()
        })
        fireEvent.click(screen.getByText('hclaw'))
        await waitFor(() => {
            expect(screen.getByText('归档卷')).toBeInTheDocument()
            expect(screen.queryByText('OpenRouter 专项')).not.toBeInTheDocument()
        })
        fireEvent.click(screen.getByText('归档卷'))
        await waitFor(() => {
            expect(screen.getByText('OpenRouter 专项')).toBeInTheDocument()
        })
    })

    it('edge: preserves edited content when switching edit→preview→edit', async () => {
        const {memory} = (window as any).electronAPI
        render(<MemoryManagerDialog />)
        await expandUserPrefs()
        fireEvent.click(screen.getByText('跨项目偏好'))
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        fireEvent.click(screen.getByText('编辑'))
        await waitFor(() => {
            expect(screen.getByTestId('code-editor')).toBeInTheDocument()
        })
        fireEvent.change(screen.getByTestId('code-editor'), {target: {value: 'modified content'}})
        fireEvent.click(screen.getByText('预览'))
        await waitFor(() => {
            expect(memory.write).toHaveBeenCalledWith('/ref/_user/preferences.md', 'modified content')
        })
        fireEvent.click(screen.getByText('编辑'))
        await waitFor(() => {
            expect(screen.getByTestId('code-editor')).toBeInTheDocument()
        })
        expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe('modified content')
    })

    it('F-6: shows feedback instead of silent no-op when project dir cannot be located', async () => {
        stubMemoryApi({list: vi.fn(async () => orphanListResult)})
        const {memory} = (window as any).electronAPI
        render(<MemoryManagerDialog />)
        await waitFor(() => {
            expect(screen.getByText('项目记忆')).toBeInTheDocument()
        })
        // 默认全折叠：先展开「项目记忆」根节点露出 orphan 项目节点
        fireEvent.click(screen.getByText('项目记忆'))
        await waitFor(() => {
            expect(screen.getByText('orphan')).toBeInTheDocument()
        })
        fireEvent.contextMenu(screen.getByText('orphan'))
        await waitFor(() => {
            expect(screen.getByRole('alert')).toBeInTheDocument()
        })
        expect(memory.delete).not.toHaveBeenCalled()
    })

    // --- Final review: F-B（mem 子树只读：禁删禁编） ---

    const memListResult = {
        globalFiles: [
            {path: '/ref/_user/preferences.md', label: '跨项目偏好', sizeLimit: 4096},
            {path: '/mem/SKILL.md', label: '记忆索引', sizeLimit: 2048},
        ],
        projects: [
            {
                dir: 'hclaw',
                projectName: 'hclaw',
                workspacePath: 'E:\\hclaw',
                memoryFile: {path: '/ref/hclaw/memory.md', label: '项目记忆', sizeLimit: 8192},
                archiveFiles: [],
            },
        ],
    }

    it('expands and collapses all via toolbar buttons', async () => {
        stubMemoryApi({list: vi.fn(async () => memListResult)})
        render(<MemoryManagerDialog />)
        await waitFor(() => {
            expect(screen.getByText('用户偏好')).toBeInTheDocument()
        })
        // 初始：记忆索引折叠 → SKILL.md 不可见
        expect(screen.getAllByText('记忆索引')).toHaveLength(1)
        fireEvent.click(screen.getByRole('button', {name: '展开全部'}))
        await waitFor(() => {
            // 展开全部 → SKILL.md 文件节点出现（与虚拟分组节点同名）
            expect(screen.getAllByText('记忆索引')).toHaveLength(2)
        })
        fireEvent.click(screen.getByRole('button', {name: '折叠全部'}))
        await waitFor(() => {
            expect(screen.getAllByText('记忆索引')).toHaveLength(1)
        })
    })

    it('F-B: mem 子树节点右键无删除入口（不触发 confirm/delete）', async () => {
        stubMemoryApi({list: vi.fn(async () => memListResult)})
        const {memory} = (window as any).electronAPI
        render(<MemoryManagerDialog />)
        await waitFor(() => {
            expect(screen.getAllByText('记忆索引').length).toBeGreaterThan(0)
        })
        // 记忆索引默认折叠：先展开虚拟分组节点露出 SKILL.md 文件节点
        fireEvent.click(screen.getAllByText('记忆索引')[0]!)
        await waitFor(() => {
            expect(screen.getAllByText('记忆索引').length).toBe(2)
        })
        fireEvent.contextMenu(screen.getAllByText('记忆索引')[1]!)
        await waitFor(() => {
            expect(memory.delete).not.toHaveBeenCalled()
        })
        expect(confirm).not.toHaveBeenCalled()
    })

    it('F-B: mem 子树文件选中后无编辑按钮（只读预览保留）', async () => {
        stubMemoryApi({list: vi.fn(async () => memListResult)})
        render(<MemoryManagerDialog />)
        await waitFor(() => {
            expect(screen.getAllByText('记忆索引').length).toBeGreaterThan(0)
        })
        fireEvent.click(screen.getAllByText('记忆索引')[0]!)
        await waitFor(() => {
            expect(screen.getAllByText('记忆索引').length).toBe(2)
        })
        fireEvent.click(screen.getAllByText('记忆索引')[1]!)
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        expect(screen.queryByText('编辑')).not.toBeInTheDocument()
    })

    it('F-B: ref 子树文件仍可删除（行为不回退）', async () => {
        stubMemoryApi({list: vi.fn(async () => memListResult)})
        const {memory} = (window as any).electronAPI
        render(<MemoryManagerDialog />)
        await waitFor(() => {
            expect(screen.getByText('项目记忆')).toBeInTheDocument()
        })
        // 默认全折叠：逐级展开「项目记忆」根 → hclaw 项目，露出项目文件
        fireEvent.click(screen.getByText('项目记忆'))
        await waitFor(() => {
            expect(screen.getByText('hclaw')).toBeInTheDocument()
        })
        fireEvent.click(screen.getByText('hclaw'))
        await waitFor(() => {
            expect(screen.getAllByText('项目记忆').length).toBeGreaterThanOrEqual(2)
        })
        fireEvent.contextMenu(screen.getAllByText('项目记忆')[1]!)
        await waitFor(() => {
            expect(memory.delete).toHaveBeenCalledWith('/ref/hclaw/memory.md', false)
        })
    })

    // --- Final review: F-A（关窗结算未保存内容，Spec §4.5） ---

    function stubWindowControls() {
        let closeRequestHandler: (() => void) | null = null
        const wc = {
            setCloseIntercept: vi.fn(async () => {}),
            onCloseRequest: vi.fn((cb: () => void) => {
                closeRequestHandler = cb
                return () => { closeRequestHandler = null }
            }),
            confirmClose: vi.fn(async () => {}),
            cancelClose: vi.fn(async () => {}),
        }
        ;(window as any).electronAPI = {
            ...(window as any).electronAPI,
            windowControls: wc,
        }
        return {
            wc,
            fireCloseRequest: () => closeRequestHandler?.(),
        }
    }

    it('F-A: 无 dirtyContent 时不武装 close 拦截（X 立即关窗，不发 close-request）', async () => {
        const {wc} = stubWindowControls()
        render(<MemoryManagerDialog />)
        await expandUserPrefs()
        expect(wc.setCloseIntercept).toHaveBeenCalledWith(false)
        expect(wc.setCloseIntercept).not.toHaveBeenCalledWith(true)
    })

    it('F-A: dirty 时武装拦截；收到 close-request → 确认保存 → 写入并 confirmClose', async () => {
        const memory = stubMemoryApi()
        const {wc, fireCloseRequest} = stubWindowControls()
        render(<MemoryManagerDialog />)
        await expandUserPrefs()
        fireEvent.click(screen.getByText('跨项目偏好'))
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        fireEvent.click(screen.getByText('编辑'))
        fireEvent.change(screen.getByTestId('code-editor'), {target: {value: 'unsaved edits'}})
        await waitFor(() => {
            expect(wc.setCloseIntercept).toHaveBeenCalledWith(true)
        })
        fireCloseRequest()
        await waitFor(() => {
            expect(memory.write).toHaveBeenCalledWith('/ref/_user/preferences.md', 'unsaved edits')
            expect(wc.confirmClose).toHaveBeenCalled()
        })
    })

    it('F-A: close-request → 用户取消 → cancelClose 且不关窗', async () => {
        const {confirm: confirmMock} = await import('@/renderer/components/ConfirmDialog')
        const memory = stubMemoryApi()
        const {wc, fireCloseRequest} = stubWindowControls()
        ;(confirmMock as any)
            .mockResolvedValueOnce(false) // 第一问：不保存
            .mockResolvedValueOnce(false) // 第二问：取消
        render(<MemoryManagerDialog />)
        await expandUserPrefs()
        fireEvent.click(screen.getByText('跨项目偏好'))
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        fireEvent.click(screen.getByText('编辑'))
        fireEvent.change(screen.getByTestId('code-editor'), {target: {value: 'unsaved edits'}})
        fireCloseRequest()
        await waitFor(() => {
            expect(wc.cancelClose).toHaveBeenCalled()
        })
        expect(wc.confirmClose).not.toHaveBeenCalled()
        expect(memory.write).not.toHaveBeenCalled()
    })
})
