// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {useMemoryManagerStore} from '../../../src/renderer/stores/memoryManagerStore'
import {confirm} from '../../../src/renderer/components/ConfirmDialog'

vi.mock('@/renderer/components/ConfirmDialog', () => ({
    confirm: vi.fn().mockResolvedValue(true),
}))

const setMemory = (memory: any) => {
    ;(window as any).electronAPI = {memory}
}

describe('memoryManagerStore', () => {
    beforeEach(() => {
        useMemoryManagerStore.getState().reset()
        vi.clearAllMocks()
    })

    it('loadTree 写入 treeData 并置 loaded', async () => {
        const list = vi.fn().mockResolvedValue({
            globalFiles: [
                {path: '/ref/_user/preferences.md', label: '跨项目偏好', sizeLimit: 4096},
            ],
            projects: [],
        })
        setMemory({list})

        await useMemoryManagerStore.getState().loadTree()

        const s = useMemoryManagerStore.getState()
        expect(s.treeLoadState).toBe('loaded')
        expect(s.treeData?.globalFiles).toHaveLength(1)
    })

    it('loadFile 读取内容并记录 selectedFile', async () => {
        const read = vi.fn().mockResolvedValue({content: 'file content'})
        setMemory({read})

        await useMemoryManagerStore.getState().loadFile('/ref/hclaw/memory.md')

        const s = useMemoryManagerStore.getState()
        expect(s.fileContent).toBe('file content')
        expect(s.contentLoadState).toBe('loaded')
        expect(s.selectedFile?.path).toBe('/ref/hclaw/memory.md')
    })

    it('updateByteCount 统计 UTF-8 字节数（中文 3 字节）', () => {
        useMemoryManagerStore.getState().updateByteCount('你好世界')

        const s = useMemoryManagerStore.getState()
        expect(s.byteCount).toBe(12)
        expect(s.overLimit).toBe(false)
    })

    it('updateByteCount 超限检测', () => {
        useMemoryManagerStore.setState({
            selectedFile: {path: '/test', label: 'test', sizeLimit: 10},
        })

        useMemoryManagerStore.getState().updateByteCount('a'.repeat(20))

        expect(useMemoryManagerStore.getState().overLimit).toBe(true)
    })

    it('saveCurrentFile 成功后清空 dirtyContent', async () => {
        const write = vi.fn().mockResolvedValue({success: true})
        setMemory({write})

        useMemoryManagerStore.setState({
            selectedFile: {path: '/test.md', label: 'test', sizeLimit: 0},
            dirtyContent: 'new content',
        })

        const success = await useMemoryManagerStore.getState().saveCurrentFile()

        expect(success).toBe(true)
        expect(write).toHaveBeenCalledWith('/test.md', 'new content')
        expect(useMemoryManagerStore.getState().dirtyContent).toBeNull()
    })

    it('deleteFile 成功后刷新树并清空选择', async () => {
        const del = vi.fn().mockResolvedValue({success: true})
        const list = vi.fn().mockResolvedValue({globalFiles: [], projects: []})
        setMemory({delete: del, list})
        useMemoryManagerStore.setState({
            selectedFile: {path: '/test.md', label: 'test', sizeLimit: 0},
        })

        const ok = await useMemoryManagerStore.getState().deleteFile('/test.md', false)

        expect(ok).toBe(true)
        expect(del).toHaveBeenCalledWith('/test.md', false)
        expect(list).toHaveBeenCalled()
        const s = useMemoryManagerStore.getState()
        expect(s.selectedFile).toBeNull()
        expect(s.treeLoadState).toBe('loaded')
    })

    it('loadFile 时保存失败则报错且不切换文件、保留 dirtyContent', async () => {
        const read = vi.fn().mockResolvedValue({content: 'next file'})
        const write = vi.fn().mockResolvedValue({error: 'write-failed', message: 'disk full'})
        setMemory({read, write})
        useMemoryManagerStore.setState({
            selectedFile: {path: '/old.md', label: 'old', sizeLimit: 0},
            dirtyContent: 'dirty',
        })

        await useMemoryManagerStore.getState().loadFile('/new.md', 'new', 0)

        expect(confirm).toHaveBeenCalled()
        expect(write).toHaveBeenCalledWith('/old.md', 'dirty')
        expect(read).not.toHaveBeenCalled()
        const s = useMemoryManagerStore.getState()
        expect(s.contentLoadState).toBe('error')
        expect(s.contentLoadError).toBe('save-failed')
        expect(s.selectedFile?.path).toBe('/old.md')
        expect(s.dirtyContent).toBe('dirty')
        expect(s.fileContent).toBe('')
    })

    it('loadFile 并发竞态：慢响应不覆盖后到的文件内容', async () => {
        let resolveFirst!: (v: any) => void
        const read = vi.fn()
            .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r }))
            .mockResolvedValueOnce({content: 'second content'})
        setMemory({read})

        const first = useMemoryManagerStore.getState().loadFile('/a.md')
        const second = useMemoryManagerStore.getState().loadFile('/b.md')
        await second
        resolveFirst({content: 'stale first'})
        await first

        const s = useMemoryManagerStore.getState()
        expect(s.selectedFile?.path).toBe('/b.md')
        expect(s.fileContent).toBe('second content')
        expect(s.contentLoadState).toBe('loaded')
    })

    it('loadFile 有未保存修改时经 confirm 保存后继续', async () => {
        const read = vi.fn().mockResolvedValue({content: 'next file'})
        const write = vi.fn().mockResolvedValue({success: true})
        setMemory({read, write})
        useMemoryManagerStore.setState({
            selectedFile: {path: '/old.md', label: 'old', sizeLimit: 0},
            dirtyContent: 'dirty',
        })

        await useMemoryManagerStore.getState().loadFile('/new.md', 'new', 0)

        expect(confirm).toHaveBeenCalled()
        expect(write).toHaveBeenCalledWith('/old.md', 'dirty')
        expect(useMemoryManagerStore.getState().fileContent).toBe('next file')
        expect(useMemoryManagerStore.getState().selectedFile?.path).toBe('/new.md')
    })
})
