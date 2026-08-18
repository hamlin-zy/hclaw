import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * 会话管理独立窗口列表加载静态契约。
 *
 * 根因：会话管理窗口迁移为独立窗口后是全新 JS 堆，不继承主窗口 zustand store，
 * useConversationStore 的 currentWorkspacePath 初始为 null → ConversationsDialog.loadData
 * 提前返回空列表 → 会话列表为空；删除时的后代展开同样拿不到工作区路径。
 * 修复：窗口打开时显式调用 store.loadConversations()（仿 toolStore.loadTools 模式，
 * 内部经 workspace.getCurrent 解析当前工作区并填充 workspaces / currentWorkspacePath），
 * 之后 loadData 再经 conversationListWithStats 拉取列表。
 */

const DIALOG_TS = path.resolve(process.cwd(), 'src/renderer/components/dialogs/ConversationsDialog.tsx')
const PRELOAD_TS = path.resolve(process.cwd(), 'src/preload/index.ts')

describe('ConversationsDialog.tsx — 独立窗口打开时显式初始化 store', () => {
    it('currentWorkspacePath 缺失时调用 store.loadConversations()（独立窗口初始化入口）', () => {
        const src = fs.readFileSync(DIALOG_TS, 'utf-8')
        expect(src).toContain('useConversationStore.getState()')
        expect(src).toContain('state.loadConversations()')
        expect(src).toContain('setWorkspaceReady(true)')
    })

    it('loadData 在初始化完成前不提前渲染空列表（workspaceReady 门控）', () => {
        const src = fs.readFileSync(DIALOG_TS, 'utf-8')
        expect(src).toContain('if (!workspaceReady) return')
        expect(src).toContain('conversationListWithStats')
    })
})

describe('独立窗口链路可用的 IPC', () => {
    it('preload 暴露 workspace.getCurrent（store.loadConversations 解析当前工作区所需）', () => {
        const src = fs.readFileSync(PRELOAD_TS, 'utf-8')
        expect(src).toContain('getCurrent: () => ipcRenderer.invoke(\'workspace:getCurrent\')')
    })

    it('preload 暴露 conversationListWithStats（会话列表统计查询所需）', () => {
        const src = fs.readFileSync(PRELOAD_TS, 'utf-8')
        expect(src).toContain('conversationListWithStats: (workspacePath: string) =>')
        expect(src).toContain("ipcRenderer.invoke('conversation-list-with-stats', workspacePath)")
    })
})
