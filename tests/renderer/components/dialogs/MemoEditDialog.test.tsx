// @vitest-environment jsdom
/**
 * MemoEditDialog 组件测试（修订 2 Task B）
 *
 * 覆盖：
 * 1. 新建态渲染（--hclaw-memo-workspace 经 preload 暴露为 memoWorkspace）
 * 2. 编辑态经 memo.getById 回填表单
 * 3. 保存：新建调 memo.create / 编辑调 memo.update（含 workspacePath / id）
 * 4. 空 title 前端拦截，不发起 IPC
 * 5. 取消/放弃：本次新上传的暂存附件走 memo.discardPending 清理
 * 6. 附件上传走 memo.uploadAttachment，超 20 上限拦截
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, createEvent, waitFor, cleanup} from '@testing-library/react'
import type {MemoItem} from '@/shared/types/memo'
import type {ProjectGroupWithMembers} from '@/shared/types/projectGroup'

const h = vi.hoisted(() => {
    const memoApi = {
        list: vi.fn(async () => ({ok: true, data: []})),
        getById: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        uploadAttachment: vi.fn(async () => ({ok: true, data: {id: 'a-new', fileName: 'f.txt', storedPath: 'p', mime: 'text/plain', kind: 'file'}})),
        discardPending: vi.fn(async () => ({ok: true, data: true})),
    }
    const closeWindow = vi.fn()
    // 级联字段数据源（Task 19）：独立窗口自行拉取 project-group:list / workspace:list
    const groupList = vi.fn(async () => [] as ProjectGroupWithMembers[])
    const workspaceList = vi.fn(async () => [] as Array<{id: string; path: string; name: string; createdAt: number; updatedAt: number}>)
    return {memoApi, closeWindow, groupList, workspaceList}
})

vi.mock('@/renderer/components/common/CapabilityPicker', () => ({
    default: () => <input type="text" placeholder="搜索可用能力..."/>,
}))

import MemoEditDialog from '@/renderer/components/dialogs/MemoEditDialog'

const P = 'E:\\proj'
const editItem = (over: Partial<MemoItem> = {}): MemoItem => ({
    id: 'memo-1',
    workspacePath: P,
    title: '旧标题',
    content: '旧正文',
    createdAt: 1,
    updatedAt: 1,
    capability: undefined,
    attachments: [],
    status: 'active',
    ...over,
})

function stubWindow(opts: {
    memoId?: string
    workspace?: string
    /** project-group:list 返回值（默认空） */
    groups?: ProjectGroupWithMembers[]
    /** workspace:list 返回值（默认空） */
    workspaces?: Array<{id: string; path: string; name: string; createdAt: number; updatedAt: number}>
    /** 模拟 project-group:list 抛错（R-BV 降级用例） */
    groupsFail?: boolean
    /** 模拟 workspace:list 抛错（R-BV 降级用例） */
    workspacesFail?: boolean
}) {
    h.groupList.mockResolvedValue(opts.groups ?? [])
    h.workspaceList.mockResolvedValue(opts.workspaces ?? [])
    vi.stubGlobal('electronAPI', {
        memo: h.memoApi,
        closeWindow: h.closeWindow,
        // 上传链路：组件先把 File 落盘 temp（saveTempFile）再走 memo.uploadAttachment
        saveTempFile: vi.fn(async () => 'E:\\tmp\\memo-test.txt'),
        memoId: opts.memoId ?? '',
        memoWorkspace: opts.workspace ?? '',
        projectGroup: {
            list: opts.groupsFail ? vi.fn(async () => { throw new Error('project-group:list 失败') }) : h.groupList,
        },
        workspace: {
            list: opts.workspacesFail ? vi.fn(async () => { throw new Error('workspace:list 失败') }) : h.workspaceList,
        },
    })
}

beforeEach(() => {
    stubWindow({})
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
})

describe('MemoEditDialog', () => {
    it('新建态：按 memoWorkspace 渲染空白表单', () => {
        stubWindow({workspace: P})
        render(<MemoEditDialog/>)

        expect(screen.getByTestId('memo-edit-dialog')).toBeTruthy()
        expect(screen.getByPlaceholderText('备忘录标题')).toBeTruthy()
        expect(screen.getByPlaceholderText('记录备忘...')).toBeTruthy()
        expect(screen.getByText('保存')).toBeTruthy()
        expect(screen.getByText('取消')).toBeTruthy()
        expect(h.memoApi.getById).not.toHaveBeenCalled()
    })

    it('编辑态：经 getById 回填表单', async () => {
        stubWindow({memoId: 'memo-1'})
        h.memoApi.getById.mockResolvedValue({ok: true, data: editItem({title: '会议纪要', content: '待办事项'})})
        render(<MemoEditDialog/>)

        await waitFor(() => expect((screen.getByPlaceholderText('备忘录标题') as HTMLInputElement).value).toBe('会议纪要'))
        expect((screen.getByPlaceholderText('记录备忘...') as HTMLTextAreaElement).value).toBe('待办事项')
        expect(h.memoApi.getById).toHaveBeenCalledWith('memo-1')
    })

    it('编辑态：getById 失败（MEMO_NOT_FOUND）展示错误', async () => {
        stubWindow({memoId: 'memo-gone'})
        h.memoApi.getById.mockResolvedValue({ok: false, error: '备忘录不存在'})
        render(<MemoEditDialog/>)

        await waitFor(() => expect(screen.getByText('备忘录不存在')).toBeTruthy())
    })

    it('新建保存 → memo.create（含 workspacePath 与 title）', async () => {
        stubWindow({workspace: P})
        h.memoApi.create.mockResolvedValue({ok: true, data: null})
        render(<MemoEditDialog/>)

        fireEvent.change(screen.getByPlaceholderText('备忘录标题'), {target: {value: '新标题'}})
        fireEvent.change(screen.getByPlaceholderText('记录备忘...'), {target: {value: '正文内容'}})
        fireEvent.click(screen.getByText('保存'))

        await waitFor(() => expect(h.memoApi.create).toHaveBeenCalledTimes(1))
        expect(h.memoApi.create).toHaveBeenCalledWith(expect.objectContaining({workspacePath: P, title: '新标题', content: '正文内容'}))
        expect(h.memoApi.update).not.toHaveBeenCalled()
        // 保存成功 → 窗口关闭
        await waitFor(() => expect(h.closeWindow).toHaveBeenCalled())
    })

    it('编辑保存 → memo.update（memoId + patch，不含 workspacePath）', async () => {
        stubWindow({memoId: 'memo-1'})
        h.memoApi.getById.mockResolvedValue({ok: true, data: editItem()})
        h.memoApi.update.mockResolvedValue({ok: true, data: true})
        render(<MemoEditDialog/>)

        await waitFor(() => expect((screen.getByPlaceholderText('备忘录标题') as HTMLInputElement).value).toBe('旧标题'))
        fireEvent.change(screen.getByPlaceholderText('备忘录标题'), {target: {value: '改过的标题'}})
        fireEvent.click(screen.getByText('保存'))

        await waitFor(() => expect(h.memoApi.update).toHaveBeenCalledTimes(1))
        const [id, patch] = h.memoApi.update.mock.calls[0]
        expect(id).toBe('memo-1')
        expect(patch).toEqual(expect.objectContaining({title: '改过的标题', content: '旧正文'}))
        expect(patch).not.toHaveProperty('workspacePath')
        expect(h.memoApi.create).not.toHaveBeenCalled()
        await waitFor(() => expect(h.closeWindow).toHaveBeenCalled())
    })

    it('空 title → 前端拦截，不发起 create/update', async () => {
        stubWindow({workspace: P})
        render(<MemoEditDialog/>)

        fireEvent.change(screen.getByPlaceholderText('记录备忘...'), {target: {value: '只有正文'}})
        fireEvent.click(screen.getByText('保存'))

        expect(screen.getByText('标题不能为空')).toBeTruthy()
        expect(h.memoApi.create).not.toHaveBeenCalled()
        expect(h.memoApi.update).not.toHaveBeenCalled()
        expect(h.closeWindow).not.toHaveBeenCalled()
    })

    it('取消/放弃：新上传的暂存附件走 discardPending 清理后关窗', async () => {
        stubWindow({workspace: P})
        h.memoApi.uploadAttachment.mockResolvedValue({ok: true, data: {id: 'att-pending-1', fileName: 'p.txt', storedPath: 'pending', mime: 'text/plain', kind: 'file'}})
        render(<MemoEditDialog/>)

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
        fireEvent.change(fileInput, {target: {files: [new File(['x'], 'p.txt')]}})
        await waitFor(() => expect(h.memoApi.uploadAttachment).toHaveBeenCalled())

        fireEvent.click(screen.getByText('取消'))
        await waitFor(() => expect(h.memoApi.discardPending).toHaveBeenCalledWith(['att-pending-1']))
        expect(h.closeWindow).toHaveBeenCalled()
    })

    it('编辑取消：已有附件不入 discardPending（仅本次新上传的暂存）', async () => {
        stubWindow({memoId: 'memo-1'})
        h.memoApi.getById.mockResolvedValue({ok: true, data: editItem({attachments: [{id: 'att-kept', fileName: 'kept.txt', storedPath: 'p', mime: 'text/plain', kind: 'file'}]})})
        render(<MemoEditDialog/>)

        await waitFor(() => expect(screen.getByText(/kept\.txt/)).toBeTruthy())
        fireEvent.click(screen.getByText('取消'))

        expect(h.memoApi.discardPending).not.toHaveBeenCalled()
        expect(h.closeWindow).toHaveBeenCalled()
    })

    it('附件上传走 uploadAttachment；超 20 上限拦截并提示', async () => {
        stubWindow({workspace: P})
        const existing = Array.from({length: 20}, (_, i) => ({id: `a${i}`, fileName: `f${i}.txt`, storedPath: `p${i}`, mime: 'text/plain', kind: 'file' as const}))
        h.memoApi.uploadAttachment.mockResolvedValue({ok: true, data: existing[0]})
        render(<MemoEditDialog/>)

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
        // 先填入 20 个已有附件（经 uploadAttachment 逐个上传模拟既有状态）
        for (let i = 0; i < 20; i++) {
            h.memoApi.uploadAttachment.mockResolvedValueOnce({ok: true, data: existing[i]})
            fireEvent.change(fileInput, {target: {files: [new File(['x'], `f${i}.txt`)]}})
        }
        await waitFor(() => expect(screen.getAllByText(/f19\.txt/).length).toBeGreaterThan(0))
        h.memoApi.uploadAttachment.mockClear()

        fireEvent.change(fileInput, {target: {files: [new File(['x'], 'extra.txt')]}})
        await waitFor(() => expect(screen.getByText('最多 20 个附件')).toBeTruthy())
        expect(h.memoApi.uploadAttachment).not.toHaveBeenCalled()
    })

    it('编辑态 status=processed → 渲染「重新打开」，点击调 update({status:"active"}) 并刷新', async () => {
        stubWindow({memoId: 'memo-1'})
        h.memoApi.getById.mockResolvedValue({ok: true, data: editItem({status: 'processed'})})
        h.memoApi.update.mockResolvedValue({ok: true, data: true})
        render(<MemoEditDialog/>)

        await waitFor(() => expect(screen.getByTestId('memo-reopen')).toBeTruthy())
        fireEvent.click(screen.getByTestId('memo-reopen'))

        await waitFor(() => expect(h.memoApi.update).toHaveBeenCalledWith('memo-1', {status: 'active'}))
        // 成功后经 getById 刷新本窗状态（不关窗）
        await waitFor(() => expect(h.memoApi.getById).toHaveBeenCalledTimes(2))
        expect(h.closeWindow).not.toHaveBeenCalled()
        expect(screen.getByTestId('memo-reopen')).toBeTruthy()
    })

    it('编辑态 status=active → 不渲染「重新打开」', async () => {
        stubWindow({memoId: 'memo-1'})
        h.memoApi.getById.mockResolvedValue({ok: true, data: editItem({status: 'active'})})
        render(<MemoEditDialog/>)

        await waitFor(() => expect((screen.getByPlaceholderText('备忘录标题') as HTMLInputElement).value).toBe('旧标题'))
        expect(screen.queryByTestId('memo-reopen')).toBeNull()
    })

    it('reopen 失败（MEMO_NOT_FOUND）展示 tip 且不关窗', async () => {
        stubWindow({memoId: 'memo-1'})
        h.memoApi.getById.mockResolvedValue({ok: true, data: editItem({status: 'processed'})})
        h.memoApi.update.mockResolvedValue({ok: false, error: '备忘录不存在'})
        render(<MemoEditDialog/>)

        await waitFor(() => expect(screen.getByTestId('memo-reopen')).toBeTruthy())
        fireEvent.click(screen.getByTestId('memo-reopen'))
        await waitFor(() => expect(screen.getByText('备忘录不存在')).toBeTruthy())
        expect(h.closeWindow).not.toHaveBeenCalled()
    })

    it('拖拽上传：drop 事件复用 addFiles 走 uploadAttachment', async () => {
        stubWindow({workspace: P})
        h.memoApi.uploadAttachment.mockResolvedValue({ok: true, data: {id: 'att-drop', fileName: 'dropped.png', storedPath: 'p', mime: 'image/png', kind: 'image'}})
        render(<MemoEditDialog/>)

        const dialog = screen.getByTestId('memo-edit-dialog')
        const dropEvt = createEvent.drop(dialog)
        Object.defineProperty(dropEvt, 'dataTransfer', {value: {files: [new File(['x'], 'dropped.png')]}})
        fireEvent(dialog, dropEvt)
        await waitFor(() => expect(h.memoApi.uploadAttachment).toHaveBeenCalledTimes(1))
        await waitFor(() => expect(screen.getByText(/dropped\.png/)).toBeTruthy())
    })

    it('拖拽悬停 preventDefault 防浏览器打开文件', () => {
        stubWindow({workspace: P})
        render(<MemoEditDialog/>)

        const dialog = screen.getByTestId('memo-edit-dialog')
        const evt = createEvent.dragOver(dialog)
        const pd = vi.spyOn(evt, 'preventDefault')
        fireEvent(dialog, evt)
        expect(pd).toHaveBeenCalled()
    })

    it('移除未保存暂存附件 → 立即 discardPending([id]) 单条清理', async () => {
        stubWindow({workspace: P})
        h.memoApi.uploadAttachment.mockResolvedValue({ok: true, data: {id: 'att-pending-2', fileName: 'p2.txt', storedPath: 'pending', mime: 'text/plain', kind: 'file'}})
        render(<MemoEditDialog/>)

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
        fireEvent.change(fileInput, {target: {files: [new File(['x'], 'p2.txt')]}})
        await waitFor(() => expect(screen.getByText(/p2\.txt/)).toBeTruthy())
        h.memoApi.discardPending.mockClear()

        fireEvent.click(screen.getByTitle('移除附件'))
        await waitFor(() => expect(h.memoApi.discardPending).toHaveBeenCalledWith(['att-pending-2']))
        expect(screen.queryByText(/p2\.txt/)).toBeNull()
    })

    it('移除已保存附件 → 不触发 discardPending；discardPending 失败不阻断 UI', async () => {
        stubWindow({memoId: 'memo-1'})
        h.memoApi.getById.mockResolvedValue({ok: true, data: editItem({attachments: [{id: 'att-saved', fileName: 'saved.txt', storedPath: 'p', mime: 'text/plain', kind: 'file'}]})})
        render(<MemoEditDialog/>)

        await waitFor(() => expect(screen.getByText(/saved\.txt/)).toBeTruthy())
        fireEvent.click(screen.getByTitle('移除附件'))

        expect(h.memoApi.discardPending).not.toHaveBeenCalled()
        expect(screen.queryByText(/saved\.txt/)).toBeNull()
    })

    // ── 修订 2 Task D：附件缩略图区 + 添加附件按钮位置 ──

    it('附件缩略图区渲染在正文输入框之前（标题与正文之间）', async () => {
        stubWindow({memoId: 'memo-1'})
        h.memoApi.getById.mockResolvedValue({ok: true, data: editItem({attachments: [{id: 'att-x', fileName: 'x.txt', storedPath: 'p', mime: 'text/plain', kind: 'file'}]})})
        render(<MemoEditDialog/>)

        await waitFor(() => expect(screen.getByTestId('memo-attachment-area')).toBeTruthy())
        const area = screen.getByTestId('memo-attachment-area')
        const textarea = screen.getByPlaceholderText('记录备忘...')
        // DOM 顺序：附件区在 textarea 之前
        expect(area.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('图片附件渲染 <img> 预览（hclaw-media:// URL），非图片渲染附件图标 chip', async () => {
        stubWindow({memoId: 'memo-1'})
        h.memoApi.getById.mockResolvedValue({
            ok: true,
            data: editItem({
                attachments: [
                    {id: 'att-img', fileName: 'photo.PNG', storedPath: 'E:\\p\\photo.PNG', mime: 'image/png', kind: 'image'},
                    {id: 'att-doc', fileName: 'notes.pdf', storedPath: 'E:\\p\\notes.pdf', mime: 'application/pdf', kind: 'file'},
                ],
            }),
        })
        render(<MemoEditDialog/>)

        await waitFor(() => expect(screen.getByTestId('memo-attachment-image')).toBeTruthy())
        const img = screen.getByTestId('memo-attachment-image') as HTMLImageElement
        expect(img.getAttribute('src')).toBe('hclaw-media:///E:/p/photo.PNG')
        expect(screen.getByText('notes.pdf')).toBeTruthy()
        // 附件图标改为描边 SVG（AttachmentIcon），不再用 📎 emoji
        expect(screen.getByText('notes.pdf').parentElement!.querySelector('svg')).toBeTruthy()
    })

    it('点击附件卡片 × → removeAttachment；暂存附件触发 discardPending', async () => {
        stubWindow({workspace: P})
        h.memoApi.uploadAttachment.mockResolvedValue({ok: true, data: {id: 'att-thumb', fileName: 't.png', storedPath: 'pending', mime: 'image/png', kind: 'image'}})
        render(<MemoEditDialog/>)

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
        fireEvent.change(fileInput, {target: {files: [new File(['x'], 't.png')]}})
        await waitFor(() => expect(screen.getByText(/t\.png/)).toBeTruthy())
        h.memoApi.discardPending.mockClear()

        fireEvent.click(screen.getByTestId('memo-attachment-remove-att-thumb'))
        await waitFor(() => expect(h.memoApi.discardPending).toHaveBeenCalledWith(['att-thumb']))
        expect(screen.queryByTestId('memo-attachment-card')).toBeNull()
    })

    it('暂存附件（storedPath=pending）即使是图片也降级为附件图标 chip，不渲染 <img>（避免 404 破图）', async () => {
        stubWindow({workspace: P})
        h.memoApi.uploadAttachment.mockResolvedValue({ok: true, data: {id: 'att-pend-img', fileName: 'pend.png', storedPath: 'pending', mime: 'image/png', kind: 'image'}})
        render(<MemoEditDialog/>)

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
        fireEvent.change(fileInput, {target: {files: [new File(['x'], 'pend.png')]}})
        await waitFor(() => expect(screen.getByTestId('memo-attachment-card')).toBeTruthy())

        expect(screen.queryByTestId('memo-attachment-image')).toBeNull()
        expect(screen.getByText('pend.png').parentElement!.querySelector('svg')).toBeTruthy()
        expect(screen.getByText('pend.png')).toBeTruthy()
    })

    it('「添加附件」按钮位于正文下方且触发隐藏文件选择 input 的 click', () => {
        stubWindow({workspace: P})
        render(<MemoEditDialog/>)

        const btn = screen.getByTestId('memo-add-attachment')
        const textarea = screen.getByPlaceholderText('记录备忘...')
        // DOM 顺序：按钮在 textarea 之后、能力搜索之前（三方顺序，对齐注释所述覆盖）
        expect(textarea.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        const pickerInput = screen.getByPlaceholderText('搜索可用能力...') as HTMLInputElement
        expect(btn.compareDocumentPosition(pickerInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(pickerInput.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
        const clickSpy = vi.spyOn(fileInput, 'click').mockImplementation(() => {})
        fireEvent.click(btn)
        expect(clickSpy).toHaveBeenCalledTimes(1)
        clickSpy.mockRestore()
    })

    // ── 图片附件缩略图点击预览大图（复用统一看图组件 ImagePreviewModal） ──

    it('点击图片缩略图 → 打开 ImagePreviewModal 大图预览', async () => {
        stubWindow({memoId: 'memo-1'})
        h.memoApi.getById.mockResolvedValue({
            ok: true,
            data: editItem({
                attachments: [{id: 'att-img', fileName: 'photo.png', storedPath: 'E:\\p\\photo.png', mime: 'image/png', kind: 'image'}],
            }),
        })
        render(<MemoEditDialog/>)

        await waitFor(() => expect(screen.getByTestId('memo-attachment-image')).toBeTruthy())
        expect(screen.queryByText('滚轮：缩放')).toBeNull()

        fireEvent.click(screen.getByTestId('memo-attachment-image'))

        await waitFor(() => expect(screen.getByText('滚轮：缩放')).toBeTruthy())
        // 预览图 src 与缩略图同源（hclaw-media:// URL）
        const modal = screen.getByText('滚轮：缩放')
        const previewImg = modal.closest('div.fixed')!.querySelectorAll('img')
        expect([...previewImg].some((i) => (i as HTMLImageElement).getAttribute('src') === 'hclaw-media:///E:/p/photo.png')).toBe(true)
    })

    it('点击缩略图上的 × → 移除附件且不误开大图预览', async () => {
        stubWindow({memoId: 'memo-1'})
        h.memoApi.getById.mockResolvedValue({
            ok: true,
            data: editItem({
                attachments: [{id: 'att-rm', fileName: 'r.png', storedPath: 'E:\\p\\r.png', mime: 'image/png', kind: 'image'}],
            }),
        })
        render(<MemoEditDialog/>)

        await waitFor(() => expect(screen.getByTestId('memo-attachment-remove-att-rm')).toBeTruthy())
        fireEvent.click(screen.getByTestId('memo-attachment-remove-att-rm'))

        expect(screen.queryByText('滚轮：缩放')).toBeNull()
        await waitFor(() => expect(screen.queryByTestId('memo-attachment-card')).toBeNull())
        expect(h.memoApi.discardPending).not.toHaveBeenCalled()
    })

    it('非图片附件卡片不响应点击预览', async () => {
        stubWindow({memoId: 'memo-1'})
        h.memoApi.getById.mockResolvedValue({
            ok: true,
            data: editItem({
                attachments: [{id: 'att-doc', fileName: 'notes.pdf', storedPath: 'E:\\p\\notes.pdf', mime: 'application/pdf', kind: 'file'}],
            }),
        })
        render(<MemoEditDialog/>)

        await waitFor(() => expect(screen.getByText('notes.pdf')).toBeTruthy())
        fireEvent.click(screen.getByTestId('memo-attachment-card'))
        expect(screen.queryByText('滚轮：缩放')).toBeNull()
    })

    it('关闭大图预览 → 关闭弹窗且附件列表不变', async () => {
        stubWindow({memoId: 'memo-1'})
        h.memoApi.getById.mockResolvedValue({
            ok: true,
            data: editItem({
                attachments: [{id: 'att-img', fileName: 'photo.png', storedPath: 'E:\\p\\photo.png', mime: 'image/png', kind: 'image'}],
            }),
        })
        render(<MemoEditDialog/>)

        await waitFor(() => expect(screen.getByTestId('memo-attachment-image')).toBeTruthy())
        fireEvent.click(screen.getByTestId('memo-attachment-image'))
        await waitFor(() => expect(screen.getByText('滚轮：缩放')).toBeTruthy())

        fireEvent.click(screen.getByTitle('关闭 (ESC)'))

        await waitFor(() => expect(screen.queryByText('滚轮：缩放')).toBeNull())
        expect(screen.getByTestId('memo-attachment-image')).toBeTruthy()
    })

    // ── 优先级设置 ──

    it('编辑态：回填优先级，保存 patch 携带 priority', async () => {
        stubWindow({memoId: 'memo-1'})
        h.memoApi.getById.mockResolvedValue({ok: true, data: editItem({priority: 'urgent'})})
        h.memoApi.update.mockResolvedValue({ok: true, data: true})
        render(<MemoEditDialog/>)

        // 回填：徽章显示「紧急」
        await waitFor(() => expect(screen.getByText('紧急')).toBeTruthy())

        fireEvent.click(screen.getByTestId('priority-trigger'))
        fireEvent.click(screen.getByTestId('priority-option-high'))
        fireEvent.click(screen.getByText('保存'))

        await waitFor(() => expect(h.memoApi.update).toHaveBeenCalledTimes(1))
        const [, patch] = h.memoApi.update.mock.calls[0]
        expect(patch).toEqual(expect.objectContaining({priority: 'high'}))
        await waitFor(() => expect(h.closeWindow).toHaveBeenCalled())
    })

    it('新建态：默认优先级 normal，切换后 create 携带 priority', async () => {
        stubWindow({workspace: P})
        h.memoApi.create.mockResolvedValue({ok: true, data: null})
        render(<MemoEditDialog/>)

        // 缺省显示「普通」
        expect(screen.getByText('普通')).toBeTruthy()

        fireEvent.click(screen.getByTestId('priority-trigger'))
        fireEvent.click(screen.getByTestId('priority-option-low'))
        fireEvent.change(screen.getByPlaceholderText('备忘录标题'), {target: {value: '带优先级'}})
        fireEvent.change(screen.getByPlaceholderText('记录备忘...'), {target: {value: '正文'}})
        fireEvent.click(screen.getByText('保存'))

        await waitFor(() => expect(h.memoApi.create).toHaveBeenCalledTimes(1))
        expect(h.memoApi.create).toHaveBeenCalledWith(expect.objectContaining({title: '带优先级', priority: 'low'}))
    })
})

// ── Task 19：项目组 + 项目 级联两字段（§15.1②/§15.1③、D12）──
describe('MemoEditDialog — 项目组 + 项目级联', () => {
    const PA = 'E:\\ws\\a'
    const PB = 'E:\\ws\\b'
    const PTOP = 'E:\\ws\\top'

    const wsRec = (path: string) => ({id: `w-${path}`, path, name: path.split('\\').pop()!, createdAt: 1, updatedAt: 1})
    const pg = (id: string, name: string, paths: string[]): ProjectGroupWithMembers => ({
        id,
        name,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
        members: paths.map((projectPath, i) => ({projectPath, groupOrder: i})),
    })

    /** 取 select 的选项值（去掉「未选择」占位项 ''） */
    const optionValues = (select: HTMLSelectElement) =>
        Array.from(select.options).map((o) => o.value).filter((v) => v !== '')

    const groupSelect = () => document.querySelector('[data-name="memo-group-select"]') as HTMLSelectElement
    const projectSelect = () => document.querySelector('[data-name="memo-project-select"]') as HTMLSelectElement

    it('创建态渲染两个下拉，默认选中注入路径所属组与项目', async () => {
        stubWindow({
            workspace: PA,
            groups: [pg('pg-a', '组A', [PA, PB])],
            workspaces: [wsRec(PA), wsRec(PB), wsRec(PTOP)],
        })
        render(<MemoEditDialog/>)

        await waitFor(() => expect(groupSelect()).toBeTruthy())
        await waitFor(() => expect(groupSelect().value).toBe('pg-a'))
        expect(projectSelect().value).toBe(PA)
        // 组下拉含「未分组」+ 各组
        expect(Array.from(groupSelect().options).map((o) => o.value)).toEqual(['', 'pg-a'])
    })

    it('注入路径不属于任何组 → 组默认「未分组」', async () => {
        stubWindow({
            workspace: PTOP,
            groups: [pg('pg-a', '组A', [PA, PB])],
            workspaces: [wsRec(PA), wsRec(PB), wsRec(PTOP)],
        })
        render(<MemoEditDialog/>)

        await waitFor(() => expect(groupSelect()).toBeTruthy())
        await waitFor(() => expect(projectSelect().value).toBe(PTOP))
        expect(groupSelect().value).toBe('')
        expect(optionValues(projectSelect())).toEqual([PTOP])
    })

    it('选「未分组」→ 项目列只列顶层项目（无组归属者）', async () => {
        stubWindow({
            workspace: PA,
            groups: [pg('pg-a', '组A', [PA, PB])],
            workspaces: [wsRec(PA), wsRec(PB), wsRec(PTOP)],
        })
        render(<MemoEditDialog/>)

        await waitFor(() => expect(projectSelect().value).toBe(PA))
        fireEvent.change(groupSelect(), {target: {value: ''}})

        expect(optionValues(projectSelect())).toEqual([PTOP])
    })

    it('切换组后原项目不在新组 → 清空需重选（不自动猜）', async () => {
        stubWindow({
            workspace: PA,
            groups: [pg('pg-a', '组A', [PA]), pg('pg-b', '组B', [PB, PTOP])],
            workspaces: [wsRec(PA), wsRec(PB), wsRec(PTOP)],
        })
        render(<MemoEditDialog/>)

        await waitFor(() => expect(projectSelect().value).toBe(PA))
        fireEvent.change(groupSelect(), {target: {value: 'pg-b'}})

        expect(projectSelect().value).toBe('')
        expect(optionValues(projectSelect())).toEqual([PB, PTOP])
    })

    it('切换组后原项目仍在新组 → 保留原项目', async () => {
        stubWindow({
            workspace: PA,
            groups: [pg('pg-a', '组A', [PA]), pg('pg-b', '组B', [PA, PB])],
            workspaces: [wsRec(PA), wsRec(PB)],
        })
        render(<MemoEditDialog/>)

        await waitFor(() => expect(projectSelect().value).toBe(PA))
        fireEvent.change(groupSelect(), {target: {value: 'pg-b'}})
        expect(projectSelect().value).toBe(PA)
    })

    it('两项必填：未选项目时保存被拒（不调 memo.create）', async () => {
        stubWindow({
            workspace: PA,
            groups: [pg('pg-a', '组A', [PA, PB])],
            workspaces: [wsRec(PA), wsRec(PB), wsRec(PTOP)],
        })
        render(<MemoEditDialog/>)

        await waitFor(() => expect(projectSelect().value).toBe(PA))
        // 切到「未分组」→ 原项目 PA 不在顶层项目内 → 清空
        fireEvent.change(groupSelect(), {target: {value: ''}})
        expect(projectSelect().value).toBe('')

        fireEvent.change(screen.getByPlaceholderText('备忘录标题'), {target: {value: '标题'}})
        fireEvent.change(screen.getByPlaceholderText('记录备忘...'), {target: {value: '正文'}})
        fireEvent.click(screen.getByText('保存'))

        expect(screen.getByText('请选择项目')).toBeTruthy()
        expect(h.memoApi.create).not.toHaveBeenCalled()
        expect(h.closeWindow).not.toHaveBeenCalled()
    })

    it('创建保存：memo.create 的 workspacePath = 所选项目', async () => {
        stubWindow({
            workspace: PA,
            groups: [pg('pg-a', '组A', [PA, PB]), pg('pg-b', '组B', [PTOP])],
            workspaces: [wsRec(PA), wsRec(PB), wsRec(PTOP)],
        })
        h.memoApi.create.mockResolvedValue({ok: true, data: null})
        render(<MemoEditDialog/>)

        await waitFor(() => expect(projectSelect().value).toBe(PA))
        fireEvent.change(groupSelect(), {target: {value: 'pg-b'}})
        fireEvent.change(projectSelect(), {target: {value: PTOP}})
        fireEvent.change(screen.getByPlaceholderText('备忘录标题'), {target: {value: '标题'}})
        fireEvent.change(screen.getByPlaceholderText('记录备忘...'), {target: {value: '正文'}})
        fireEvent.click(screen.getByText('保存'))

        await waitFor(() => expect(h.memoApi.create).toHaveBeenCalledTimes(1))
        expect(h.memoApi.create).toHaveBeenCalledWith(expect.objectContaining({workspacePath: PTOP}))
    })

    it('编辑态：项目只读（渲染 memo-project-readonly，不渲染 select）', async () => {
        stubWindow({memoId: 'memo-1', groups: [pg('pg-a', '组A', [P])], workspaces: [wsRec(P)]})
        h.memoApi.getById.mockResolvedValue({ok: true, data: editItem()})
        render(<MemoEditDialog/>)

        await waitFor(() => expect(document.querySelector('[data-name="memo-project-readonly"]')).toBeTruthy())
        const readonly = document.querySelector('[data-name="memo-project-readonly"]')!
        expect(readonly.textContent).toContain(P)
        // 不渲染两处 select（组字段同样文本展示，但不加 data-name）
        expect(document.querySelector('[data-name="memo-project-select"]')).toBeNull()
        expect(document.querySelector('[data-name="memo-group-select"]')).toBeNull()
        // 组文本展示 = 所属组名
        await waitFor(() => expect(screen.getByText('组A')).toBeTruthy())
    })

    it('R-BV 降级：project-group:list 失败 → 组下拉仅「未分组」，项目列退化为 workspace.list 结果', async () => {
        stubWindow({workspace: PA, groupsFail: true, workspaces: [wsRec(PA), wsRec(PB)]})
        render(<MemoEditDialog/>)

        await waitFor(() => expect(groupSelect()).toBeTruthy())
        expect(Array.from(groupSelect().options).map((o) => o.value)).toEqual([''])
        await waitFor(() => expect(optionValues(projectSelect())).toEqual([PA, PB]))
        expect(projectSelect().value).toBe(PA)
        expect(screen.getByTestId('memo-edit-dialog')).toBeTruthy()
    })

    it('R-BV 降级：两个 IPC 均失败 → 空列表 + tip 提示，不抛异常不白屏', async () => {
        stubWindow({workspace: PA, groupsFail: true, workspacesFail: true})
        render(<MemoEditDialog/>)

        await waitFor(() => expect(screen.getByText(/项目组\/项目列表加载失败/)).toBeTruthy())
        expect(screen.getByTestId('memo-edit-dialog')).toBeTruthy()
        expect(optionValues(projectSelect())).toEqual([PA]) // 至少保留注入路径，可提交
    })

    it('编辑态：getById 失败时不渲染级联字段（错误分支）', async () => {
        stubWindow({memoId: 'memo-gone', groups: [pg('pg-a', '组A', [P])], workspaces: [wsRec(P)]})
        h.memoApi.getById.mockResolvedValue({ok: false, error: '备忘录不存在'})
        render(<MemoEditDialog/>)

        await waitFor(() => expect(screen.getByText('备忘录不存在')).toBeTruthy())
        expect(document.querySelector('[data-name="memo-project-readonly"]')).toBeNull()
    })
})
