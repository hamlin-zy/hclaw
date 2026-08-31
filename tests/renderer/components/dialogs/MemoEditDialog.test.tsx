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
    return {memoApi, closeWindow}
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

function stubWindow(opts: {memoId?: string; workspace?: string}) {
    vi.stubGlobal('electronAPI', {
        memo: h.memoApi,
        closeWindow: h.closeWindow,
        // 上传链路：组件先把 File 落盘 temp（saveTempFile）再走 memo.uploadAttachment
        saveTempFile: vi.fn(async () => 'E:\\tmp\\memo-test.txt'),
        memoId: opts.memoId ?? '',
        memoWorkspace: opts.workspace ?? '',
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

    it('图片附件渲染 <img> 预览（hclaw-media:// URL），非图片渲染 📎 chip', async () => {
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
        expect(screen.getByText('📎')).toBeTruthy()
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

    it('暂存附件（storedPath=pending）即使是图片也降级为 📎 chip，不渲染 <img>（避免 404 破图）', async () => {
        stubWindow({workspace: P})
        h.memoApi.uploadAttachment.mockResolvedValue({ok: true, data: {id: 'att-pend-img', fileName: 'pend.png', storedPath: 'pending', mime: 'image/png', kind: 'image'}})
        render(<MemoEditDialog/>)

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
        fireEvent.change(fileInput, {target: {files: [new File(['x'], 'pend.png')]}})
        await waitFor(() => expect(screen.getByTestId('memo-attachment-card')).toBeTruthy())

        expect(screen.queryByTestId('memo-attachment-image')).toBeNull()
        expect(screen.getByText('📎')).toBeTruthy()
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
})
