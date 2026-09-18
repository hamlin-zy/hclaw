/**
 * ScheduleConversationsPanel — 行内展开的「执行记录」面板（能力类任务）
 *
 * ui-07 重写：不再把使用者推去「会话列表搜索」，而是就地列出该任务产生的调度会话
 * （唯一数据源：`scheduler.getConversations(scheduleId)`）。
 *
 * 【2026-09-16 修订 · feat/schedule-jump-to-conversation】
 * 执行记录**不再内联渲染会话消息正文**。原先那个内联详情是劣化副本——只渲染
 * `message.content` 纯文本（`whitespace-pre-wrap` + 400 字截断），没有工具块、
 * 没有 Markdown、没有附件/图片；而 `ConversationPage` 有全套。看完整对话本就该去会话页。
 * 现在**点击整行 = 跳转到该会话**，消息正文交给会话页呈现。随之删除全仓零调用点的
 * `scheduler.conversationDetail` 通道（原缺陷形态见设计契约 §6 #17）。
 *
 * 【2026-09-16 修订 · 跨窗口投递】本面板跑在**独立窗口**（ConfigDialogWindow），
 * 该窗口的 conversationStore 从未加载会话、`currentWorkspacePath` 恒为 null，
 * 就地调 `setActiveConversation` 只改到本进程、主窗口毫不知情（跳转从未生效）。
 * 现改为把 `{conversationId, workspacePath}` 投递给主进程（`app.openConversation`），
 * **由主窗口执行「切到该会话所属工作区 + 激活会话」**；失败才提示（无归属信息则无法定位）。
 *
 * 三态齐备且互相区分（设计契约 H5 的口径）：加载中 / 加载失败（可读原因 + 重试）/
 * 还没有任何执行记录（说明文案，措辞与样式都与失败不同）。
 * 脚本类任务委派给 `ScheduleScriptLogPanel`。
 */

import {useCallback, useEffect, useState} from 'react'
import type {ConversationMeta} from '@shared/types/infra'
import {Toast} from '../usage/statsParts'
import {formatTime} from './ScheduleUtils'
import ScheduleScriptLogPanel from './ScheduleScriptLogPanel'
import {API_UNAVAILABLE, ErrorBox, PanelShell, type Loadable} from './schedulePanelShell'

interface ScheduleConversationsPanelProps {
    scheduleId: string
    taskType: string
}

function LoadingBox({label}: { label: string }) {
    return (
        <div className="p-4 text-center">
            <div className="inline-block w-4 h-4 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin"/>
            <div className="mt-1.5 text-xs text-[var(--text-secondary)]">{label}</div>
        </div>
    )
}

/** 空态：说明这是「还没跑过」，不是加载坏了 */
function EmptyBox() {
    return (
        <div className="p-4">
            <div className="rounded-md border border-dashed border-[var(--border-emphasis)] px-3 py-4 text-center">
                <div className="text-sm text-[var(--text-primary)] font-medium">还没有任何执行记录</div>
                <div className="mt-1 text-xs text-[var(--text-secondary)] leading-relaxed">
                    这个任务还没有跑过。可以点行内的「立即执行」先试一次，之后这里会列出每次执行的过程与结果。
                </div>
            </div>
        </div>
    )
}

function ConversationsPanel({scheduleId}: { scheduleId: string }) {
    const [convs, setConvs] = useState<Loadable<ConversationMeta[]>>({status: 'loading'})
    const [reloadKey, setReloadKey] = useState(0)
    const [notice, setNotice] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setConvs({status: 'loading'})
        const run = async () => {
            try {
                const api = window.electronAPI?.scheduler
                if (!api?.getConversations) {
                    if (!cancelled) setConvs({status: 'error', error: API_UNAVAILABLE})
                    return
                }
                const res = await api.getConversations(scheduleId)
                if (cancelled) return
                if (!res) setConvs({status: 'error', error: API_UNAVAILABLE})
                else if (!res.ok) setConvs({status: 'error', error: res.error || '执行记录加载失败'})
                else setConvs({status: 'ready', data: res.data || []})
            } catch (err: unknown) {
                if (!cancelled) setConvs({status: 'error', error: err instanceof Error ? err.message : String(err)})
            }
        }
        void run()
        return () => { cancelled = true }
    }, [scheduleId, reloadKey])

    /**
     * 点击整行 = 跳转到该会话。
     *
     * 投递给主进程、**由主窗口执行**（本窗口是独立配置窗口，会话 store 从未加载，
     * 就地激活只改到本进程 → 跳转从未生效；详见文件头）。主窗口负责切到该会话所属
     * 工作区并激活它，结果通过回执返回，失败才提示。
     */
    const openConversation = useCallback(async (conv: ConversationMeta) => {
        const api = window.electronAPI?.app?.openConversation
        if (!api) {
            setNotice('打开会话失败：应用接口不可用')
            return
        }
        try {
            const res = await api({conversationId: conv.id, workspacePath: conv.workspacePath || ''})
            setNotice(res?.ok ? null : `打开会话失败：${res?.error || '未知原因'}`)
        } catch (err) {
            setNotice(`打开会话失败：${err instanceof Error ? err.message : String(err)}`)
        }
    }, [])

    return (
        <PanelShell title="执行记录">
            {convs.status === 'loading' && <LoadingBox label="加载执行记录..."/>}
            {convs.status === 'error' && (
                <ErrorBox message={`执行记录加载失败：${convs.error}`}
                          onRetry={() => setReloadKey(k => k + 1)}
                          retryName="schedule-dialog-records-retry-button"
                          retryLabel="重新加载执行记录"/>
            )}
            {convs.status === 'ready' && convs.data.length === 0 && <EmptyBox/>}
            {convs.status === 'ready' && convs.data.length > 0 && (
                <div className="divide-y divide-[var(--border-muted)]">
                    {convs.data.map(conv => (
                        <button
                            key={conv.id}
                            type="button"
                            onClick={() => openConversation(conv)}
                            aria-label={`打开会话：${conv.title || '未命名会话'}`}
                            className="w-full text-left px-3 py-2 hover:bg-[var(--surface-muted)] transition-colors"
                            data-name="schedule-dialog-conversation-button">
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-medium text-[var(--text-primary)] truncate">
                                    {conv.title || '未命名会话'}
                                </span>
                                <span className="ml-auto shrink-0 text-2xs text-[var(--text-muted)]">
                                    {formatTime(conv.updatedAt)}
                                </span>
                            </div>
                            {conv.preview && (
                                <div className="mt-0.5 text-xs text-[var(--text-secondary)] truncate">
                                    {conv.preview}
                                </div>
                            )}
                        </button>
                    ))}
                </div>
            )}

            {/* 跳转失败的提示（复用对话窗既有的 Toast 机制，不新造通知体系） */}
            {notice && (
                <Toast message={notice} type="error" onClose={() => setNotice(null)}/>
            )}
        </PanelShell>
    )
}

export default function ScheduleConversationsPanel({
                                                       scheduleId,
                                                       taskType,
                                                   }: ScheduleConversationsPanelProps) {
    if (taskType === 'script') {
        return <ScheduleScriptLogPanel scheduleId={scheduleId}/>
    }
    return <ConversationsPanel scheduleId={scheduleId}/>
}
