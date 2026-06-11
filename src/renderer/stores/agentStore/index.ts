// ── Agent Store 主入口 ──────────────────────────────────────
//
// 职责：
// 1. 管理 Agent 运行时状态（idle/thinking/running/error）
// 2. 缓冲流式文本 / thinking / 工具调用
// 3. 通过 IPC 启动/中止 Agent
// 4. 所有事件（text/tool_start/tool_result）写入同一条 assistant 消息
//    → 一次 Agent 回合 = 一条 assistant 消息（含内联工具调用）

import {create} from 'zustand'
import {persist} from 'zustand/middleware'
import type {AgentState, RunMode, WorkMode} from '@shared/types'
// WORK_MODE_TO_MODEL_ROLE 已废弃，直接使用 mode 作为角色名

import type {AgentStore} from './types'
import type {HookResultItem} from './types'

// 保持类型导出兼容（HookResultsBar 等外部引用）
export type {HookResultItem}
import {IDLE_STATE, STREAMING_STATE, DEFAULT_TOP_LEVEL, createDefaultConvData} from './defaultState'

// 保持与旧 import 路径兼容（conversationStore 等外部引用）
export {createDefaultConvData}
import {useConversationStore} from '../conversationStore'
import {useToolCallsStore} from '../toolCallsStore'
import {useModelSchemeStore} from '../modelSchemeStore'

import {flushAllTextBatches, flushTextBatch, clearTextBatch} from './batching/textBatch'
import {flushToolResultBatch, getToolResultBatchMap} from './batching/toolResultBatch'
import {saveHmrContext, restoreFromHmr} from './helpers/hmrPersistence'
import {syncConvToTopLevel} from './helpers/convHelpers'
import {updateMessageContentBlocks} from './contentBlocks'
import {startAgentImpl} from './handlers/startAgent'
import {abortAgentImpl} from './handlers/abortAgent'
import {handleStreamEventImpl} from './handlers/streamEvents'

let streamUnsubscribe: (() => void) | null = null

export const useAgentStore = create<AgentStore>()(
    persist(
        (set, get) => ({
            // ── 初始状态 ──────────────────────────────
            agentState: {...IDLE_STATE, currentModelName: undefined, currentModelProvider: undefined},
            streamBuffer: '',
            thinkingContent: null,
            streamBlocks: [],
            streamingMessageId: null,
            isThinkingAfterTools: false,
            runningToolCount: 0,
            pendingQuestion: null,
            toolPopupData: null,
            combinedPopupData: null,
            pendingPermissionConfirm: null,
            tasks: [],
            intentResult: null,
            permissionRules: [],
            permissionMode: 'safe',
            workMode: 'primary',
            messageDisplayMode: 'detailed',
            compactStats: null,
            compactInProgress: false,
            errorMessage: null,
            hookResults: [],
            convAgentStates: {},

            // ── Hook 结果 ──────────────────────────────
            addHookResult: (item: HookResultItem) => {
                set((prev) => {
                    const results = [...prev.hookResults, item]
                    if (results.length > 50) results.splice(0, results.length - 50)
                    return {hookResults: results}
                })
            },

            // ── 压缩横幅 ──────────────────────────────
            clearCompactBanner: () => {
                set({compactStats: null})
            },

            // ── 多会话状态管理 ──────────────────────────────
            getConvData: (convId) => {
                return get().convAgentStates[convId] || createDefaultConvData()
            },

            updateConvData: (convId, updates) => {
                const prev = get().convAgentStates[convId] || createDefaultConvData()
                const newData = {...prev, ...updates}
                const newMap = {...get().convAgentStates, [convId]: newData}
                const activeConvId = useConversationStore.getState().activeConversationId
                set({
                    convAgentStates: newMap,
                    ...(convId === activeConvId ? newData : {}),
                })
            },

            removeConvData: (convId) => {
                const newMap = {...get().convAgentStates}
                delete newMap[convId]
                set({convAgentStates: newMap})
            },

            // ── 简单状态设置 ──────────────────────────────
            setAgentState: (state) => {
                set((prev) => ({agentState: {...prev.agentState, ...state}}))
            },

            setMode: (mode) => {
                set((prev) => ({agentState: {...prev.agentState, mode}}))
            },

            // ── 权限模式 ──────────────────────────────
            setPermissionMode: async (mode: RunMode) => {
                try {
                    await window.electronAPI?.agentSetPermissionMode?.(mode)
                    set({permissionMode: mode})
                } catch { /* 静默处理错误 */ }
            },

            // ── 工作模式 ──────────────────────────────
            setWorkMode: async (mode: WorkMode) => {
                try {
                    await window.electronAPI?.agentSetWorkMode?.(mode)
                    set({workMode: mode})

                    const currentStatus = get().agentState.status
                    if (currentStatus === 'idle' || currentStatus === 'error' || currentStatus === 'paused') {
                        // mode 直接作为角色名查找
                        const role = mode === 'auto' ? 'primary' : mode
                        const modelConfig = useModelSchemeStore.getState().getModelConfigForRole(role as any)
                        if (!modelConfig) return

                        const {provider, model: modelName} = modelConfig
                        const agentStatePatch = {currentModelName: modelName, currentModelProvider: provider}

                        const activeConvId = useConversationStore.getState().activeConversationId
                        const convData = activeConvId ? get().convAgentStates[activeConvId] : undefined
                        if (convData) {
                            get().updateConvData(activeConvId!, {
                                agentState: {...convData.agentState, ...agentStatePatch},
                            })
                        } else {
                            set({agentState: {...get().agentState, ...agentStatePatch}})
                        }
                    }
                } catch { /* 静默处理错误 */ }
            },

            // ── 消息显示模式 ──────────────────────────────
            setMessageDisplayMode: async (mode) => {
                set({messageDisplayMode: mode})
                try {
                    await window.electronAPI?.configWrite?.('message-display-mode', {mode})
                } catch { /* 静默处理持久化错误 */ }
            },

            // ── 权限确认 ──────────────────────────────
            respondQuestion: async (result) => {
                const {pendingPermissionConfirm, agentState, streamingMessageId} = get()
                if (!pendingPermissionConfirm?.requestId) return

                const convId = useConversationStore.getState().activeConversationId
                if (!convId) return

                try {
                    await window.electronAPI?.agentRespondConfirmation?.({
                        conversationId: convId,
                        requestId: pendingPermissionConfirm.requestId,
                        result,
                    })

                    if (streamingMessageId) {
                        const currentMsg = useConversationStore.getState().loadedMessages.find(m => m.id === streamingMessageId)
                        if (currentMsg?.permissionConfirm) {
                            useConversationStore.getState().updateMessageForConv(convId, streamingMessageId, {
                                permissionConfirm: {
                                    ...currentMsg.permissionConfirm,
                                    status: result === 'allow' ? 'approved'
                                        : result === 'always' ? 'always'
                                        : 'denied',
                                    respondedAt: Date.now(),
                                },
                            })
                        }
                    }

                    set({
                        pendingPermissionConfirm: null,
                        agentState: {...agentState, status: result === 'deny' ? 'idle' : 'running'},
                    })
                    get().updateConvData(convId, {pendingPermissionConfirm: null})
                } catch { /* 静默处理错误 */ }
            },

            // ── 提问回答 ──────────────────────────────
            answerQuestion: async (answer) => {
                const {pendingQuestion} = get()
                if (!pendingQuestion?.requestId) return

                const convId = useConversationStore.getState().activeConversationId
                if (!convId) return

                try {
                    await window.electronAPI?.agentRespondAskUser?.({
                        conversationId: convId,
                        requestId: pendingQuestion.requestId,
                        answer,
                    })
                    set({pendingQuestion: null})
                    get().updateConvData(convId, {pendingQuestion: null})
                } catch { /* 静默处理错误 */ }
            },

            clearPendingQuestion: () => {
                const convId = useConversationStore.getState().activeConversationId
                set({pendingQuestion: null})
                if (convId) get().updateConvData(convId, {pendingQuestion: null})
            },

            // ── 弹窗管理 ──────────────────────────────
            openToolPopup: (data) => {
                set({toolPopupData: data})
                const convId = useConversationStore.getState().activeConversationId
                if (convId) get().updateConvData(convId, {toolPopupData: data})
            },
            closeToolPopup: () => {
                set({toolPopupData: null})
                const convId = useConversationStore.getState().activeConversationId
                if (convId) get().updateConvData(convId, {toolPopupData: null})
            },
            updateToolPopupExpanded: (expandedCardIds) => {
                const prev = get().toolPopupData
                if (!prev) return
                const updated = {...prev, expandedCardIds}
                set({toolPopupData: updated})
                const convId = useConversationStore.getState().activeConversationId
                if (convId) get().updateConvData(convId, {toolPopupData: updated})
            },
            openCombinedPopup: (data) => {
                set({combinedPopupData: data})
            },
            closeCombinedPopup: () => {
                set({combinedPopupData: null})
            },

            // ── 权限规则 ──────────────────────────────
            setPendingPermissionConfirm: (confirm) => {
                set({pendingPermissionConfirm: confirm})
            },
            fetchPermissionRules: async () => {
                try {
                    const rules = await window.electronAPI?.agentGetPermissionRules?.()
                    if (rules) set({permissionRules: rules})
                } catch { /* 静默处理错误 */ }
            },
            removePermissionRule: async (toolName) => {
                try {
                    await window.electronAPI?.agentRemovePermissionRule?.(toolName)
                    await get().fetchPermissionRules()
                } catch { /* 静默处理错误 */ }
            },
            addPermissionRule: async (rule) => {
                try {
                    await window.electronAPI?.agentAddPermissionRule?.(rule)
                    await get().fetchPermissionRules()
                } catch { /* 静默处理错误 */ }
            },

            // ── 核心 Agent 操作（委派给 handler 实现） ──────────
            startAgent: async (params) => {
                return startAgentImpl(set, get, params)
            },

            abortAgent: async (conversationId) => {
                return abortAgentImpl(set, get, conversationId)
            },

            handleStreamEvent: async (payload) => {
                return handleStreamEventImpl(set, get, payload)
            },

            // ── ContentBlocks 重建 ──────────────────────────────
            updateMessageContentBlocks: (convId) => {
                return updateMessageContentBlocks(convId)
            },

            // ── 刷新待处理批数据 ──────────────────────────────
            flushPendingStreamData: () => {
                flushAllTextBatches()
                for (const convId of Object.keys(getToolResultBatchMap())) {
                    flushToolResultBatch(convId)
                }
            },

            // ── 会话恢复 ──────────────────────────────
            recoverSessions: async () => {
                try {
                    const restored = await restoreFromHmr()

                    const status = await window.electronAPI?.agentStatus?.()
                    if (!status?.allRunning?.length) {
                        get().recoverSessionsCleanup(restored)
                        return
                    }

                    const convStore = useConversationStore.getState()
                    const toolCallsState = useToolCallsStore.getState()

                    for (const convId of status.allRunning) {
                        if (restored.has(convId)) continue

                        if (!convStore.messagesMap[convId]?.length) {
                            await convStore.loadMessagesInitial(convId)
                        }

                        const msgs = convStore.messagesMap[convId] || convStore.loadedMessages
                        if (!msgs?.length) continue

                        const lastAssistantMsg = [...msgs].reverse().find((m) => m.role === 'assistant')
                        if (!lastAssistantMsg) continue

                        for (const tc of lastAssistantMsg.toolCalls || []) {
                            if (tc.status === 'running' || tc.status === 'pending') {
                                toolCallsState.registerToolCall(tc.id, {
                                    status: tc.status,
                                    progress: tc.progress,
                                })
                                if (tc.name === 'agent' && tc.taskId) {
                                    toolCallsState.registerToolCall(`sub-${tc.taskId}`, {
                                        status: 'running',
                                        progress: '子 Agent 恢复中...',
                                    })
                                }
                            }
                        }

                        get().updateConvData(convId, {
                            streamingMessageId: lastAssistantMsg.id,
                            streamBuffer: lastAssistantMsg.content || '',
                            agentState: STREAMING_STATE,
                        })
                        restored.add(convId)
                        syncConvToTopLevel(convId)
                        console.log(`[agentStore] 已恢复 Agent 会话: ${convId}, 消息: ${lastAssistantMsg.id}`)
                    }

                    get().recoverSessionsCleanup(restored)
                } catch (err) {
                    console.error('[agentStore] recoverSessions 失败:', err)
                }
            },

            recoverSessionsCleanup: (keepRunning?: Set<string>) => {
                const convStates = get().convAgentStates
                const convStore = useConversationStore.getState()
                for (const [convId, data] of Object.entries(convStates)) {
                    const isBusy = data.agentState.status === 'running' || data.agentState.status === 'thinking'
                    if (!isBusy) continue
                    if (keepRunning?.has(convId)) continue

                    get().updateConvData(convId, createDefaultConvData())
                    if (convId === convStore.activeConversationId) {
                        set({...DEFAULT_TOP_LEVEL, agentState: IDLE_STATE})
                    }
                    console.log(`[agentStore] 已清理残留运行状态: ${convId}`)
                }
            },

            // ── 流式监听器注册 ──────────────────────────────
            registerStreamListener: () => {
                streamUnsubscribe?.()
                const unsub = window.electronAPI?.onAgentStream?.((payload: any) => {
                    get().handleStreamEvent(payload)
                }) || null
                streamUnsubscribe = unsub
                return () => {
                    flushAllTextBatches()
                    saveHmrContext()
                    streamUnsubscribe?.()
                    streamUnsubscribe = null
                }
            },
        }),
        {
            name: 'hclaw-agent-storage',
            partialize: (state) => ({
                permissionMode: state.permissionMode,
                messageDisplayMode: state.messageDisplayMode,
            }),
            onRehydrateStorage: () => (state) => {
                window.electronAPI?.configRead('message-display-mode').then((data: any) => {
                    if (data?.mode && state) {
                        state.messageDisplayMode = data.mode
                    }
                }).catch(() => { /* 静默处理读取错误 */ })
            },
        },
    ),
)
