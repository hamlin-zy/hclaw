import {create} from 'zustand'
import type {MemoryListResult} from '@shared/types/memoryIPC'
import {confirm} from '../components/ConfirmDialog'

/** 当前选中文件（来自树条目的最小字段集） */
export interface SelectedFile {
    path: string
    label: string
    /** 字节上限（0=不限） */
    sizeLimit: number
}

interface MemoryManagerStore {
    // 树
    treeData: MemoryListResult | null
    treeLoadState: 'idle' | 'loading' | 'loaded' | 'error'
    treeLoadError: string | null
    loadTree: () => Promise<void>

    // 当前选中文件
    selectedFile: SelectedFile | null
    fileContent: string
    contentLoadState: 'idle' | 'loading' | 'loaded' | 'error'
    contentLoadError: string | null
    /** label/sizeLimit 可省略（默认空标签、不限字节），供仅知路径的调用方使用 */
    loadFile: (path: string, label?: string, sizeLimit?: number) => Promise<void>
    clearSelection: () => void

    // 编辑
    editMode: boolean
    dirtyContent: string | null
    setEditMode: (mode: boolean) => void
    setDirtyContent: (content: string | null) => void
    saveCurrentFile: () => Promise<boolean>

    // 删除
    deleteFile: (path: string, recursive: boolean) => Promise<boolean>

    // 字节统计
    byteCount: number
    overLimit: boolean
    updateByteCount: (content: string) => void

    reset: () => void
}

/** UTF-8 字节数（Electron 渲染端与测试环境均可用 TextEncoder，不依赖 Buffer） */
function getByteCount(content: string): number {
    return new TextEncoder().encode(content).length
}

const clearedSelection = {
    selectedFile: null,
    fileContent: '',
    contentLoadState: 'idle' as const,
    contentLoadError: null,
    dirtyContent: null,
    editMode: false,
    byteCount: 0,
    overLimit: false,
}

/** loadFile 并发序号守卫：慢响应不得覆盖后到的请求 */
let loadFileSeq = 0

export const useMemoryManagerStore = create<MemoryManagerStore>((set, get) => ({
    treeData: null,
    treeLoadState: 'idle',
    treeLoadError: null,

    selectedFile: null,
    fileContent: '',
    contentLoadState: 'idle',
    contentLoadError: null,

    editMode: false,
    dirtyContent: null,

    byteCount: 0,
    overLimit: false,

    loadTree: async () => {
        set({treeLoadState: 'loading', treeLoadError: null})
        try {
            const result = await window.electronAPI?.memory.list()
            if (result) {
                set({treeData: result, treeLoadState: 'loaded'})
            } else {
                set({treeLoadState: 'error', treeLoadError: 'electronAPI.memory 不可用'})
            }
        } catch (e) {
            set({treeLoadState: 'error', treeLoadError: e instanceof Error ? e.message : String(e)})
        }
    },

    loadFile: async (path, label = '', sizeLimit = 0) => {
        const seq = ++loadFileSeq
        // 切换前结算未保存修改
        const {dirtyContent, saveCurrentFile} = get()
        if (dirtyContent !== null) {
            const shouldSave = await confirm({
                title: '未保存的修改',
                message: '当前文件有未保存的修改，是否保存？',
                confirmText: '保存',
                cancelText: '放弃',
            })
            if (shouldSave) {
                const saved = await saveCurrentFile()
                if (!saved) {
                    // 保存失败：不切换文件、保留未保存内容
                    set({contentLoadState: 'error', contentLoadError: 'save-failed'})
                    return
                }
            }
        }
        if (seq !== loadFileSeq) return

        set({contentLoadState: 'loading', contentLoadError: null, selectedFile: {path, label, sizeLimit}})
        try {
            const result = await window.electronAPI?.memory.read(path)
            if (seq !== loadFileSeq) return
            if (result && 'content' in result) {
                set({
                    fileContent: result.content,
                    contentLoadState: 'loaded',
                    dirtyContent: null,
                    editMode: false,
                    byteCount: getByteCount(result.content),
                    overLimit: sizeLimit > 0 && getByteCount(result.content) > sizeLimit,
                })
            } else {
                set({
                    fileContent: '',
                    contentLoadState: 'error',
                    contentLoadError: result && 'error' in result ? result.error : 'electronAPI.memory 不可用',
                })
            }
        } catch {
            if (seq === loadFileSeq) set({contentLoadState: 'error', contentLoadError: 'read-error'})
        }
    },

    clearSelection: () => set({...clearedSelection}),

    setEditMode: (mode) => set({editMode: mode}),

    setDirtyContent: (content) => {
        set({dirtyContent: content})
        if (content !== null) {
            get().updateByteCount(content)
        }
    },

    saveCurrentFile: async () => {
        const {selectedFile, dirtyContent} = get()
        if (!selectedFile || dirtyContent === null) return false
        try {
            const result = await window.electronAPI?.memory.write(selectedFile.path, dirtyContent)
            if (result && 'success' in result && result.success === true) {
                set({fileContent: dirtyContent, dirtyContent: null})
                return true
            }
            return false
        } catch {
            return false
        }
    },

    deleteFile: async (path, recursive) => {
        try {
            const result = await window.electronAPI?.memory.delete(path, recursive)
            if (!result || !('success' in result) || result.success !== true) return false
            await get().loadTree()
            const {selectedFile} = get()
            if (selectedFile && (path === selectedFile.path || recursive)) {
                set({...clearedSelection})
            }
            return true
        } catch {
            return false
        }
    },

    updateByteCount: (content) => {
        const bytes = getByteCount(content)
        const {selectedFile} = get()
        set({
            byteCount: bytes,
            overLimit: selectedFile !== null && selectedFile.sizeLimit > 0 && bytes > selectedFile.sizeLimit,
        })
    },

    reset: () => {
        set({
            treeData: null,
            treeLoadState: 'idle',
            treeLoadError: null,
            ...clearedSelection,
        })
    },
}))
