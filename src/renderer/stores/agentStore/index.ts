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
import type {RunMode} from '@shared/types'

import type {AgentStore} from './types'

import {IDLE_STATE, STREAMING_STATE, DEFAULT_TOP_LEVEL, createDefaultConvData} from './defaultState'

// 保持与旧 import 路径兼容（conversationStore 等外部引用）
export {createDefaultConvData}
import {useConversationStore} from '../conversationStore'
import {useToolCallsStore} from '../toolCallsStore'

import {flushAllTextBatches} from './batching/textBatch'
import {flushAllThinkingBatches} from './batching/thinkingBatch'
import {flushToolResultBatch, getToolResultBatchMap} from './batching/toolResultBatch'
import {saveHmrContext, restoreFromHmr} from './helpers/hmrPersistence'
import {syncConvToTopLevel} from './helpers/convHelpers'
import {updateMessageContentBlocks, reconcileStreamingContent} from './contentBlocks'
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
            permissionRules: [],
            permissionMode: 'safe',
            messageDisplayMode: 'detailed',
            compactStats: null,
            compactInProgress: false,
            errorMessage: null,
            modelOverride: null,
            convAgentStates: {},

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

            // ── 权限模式 ──────────────────────────────
            setPermissionMode: async (mode: RunMode) => {
                try {
                    await window.electronAPI?.agentSetPermissionMode?.(mode)
                    set({permissionMode: mode})
                } catch { /* 静默处理错误 */ }
            },

            // ── 消息显示模式 ──────────────────────────────
            setMessageDisplayMode: async (mode) => {
                set({messageDisplayMode: mode})
                try {
                    await window.electronAPI?.configWrite?.('message-display-mode', {mode})
                } catch { /* 静默处理持久化错误 */ }
            },

            // ── 会话级模型 override ──────────────────────────
            setModelOverride: async (convId, override) => {
                try {
                    await window.electronAPI?.modelOverrideSet?.(convId, override)
                    set({modelOverride: override})
                } catch { /* 静默处理 */ }
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
            updateMessageContentBlocks,

            // ── 运行中会话切换补全 ──────────────────────────────
            // 切回后台运行中的会话时，DB 快照的 contentBlocks 滞后于流式进度
            // （非活跃期间冻结 + 块级落库惰性），用 agentStore 流式数据重建完整
            // contentBlocks（见 contentBlocks.reconcileStreamingContent 注释）。
            reconcileStreamingContent,

            // ── 刷新待处理批数据 ──────────────────────────────
            flushPendingStreamData: () => {
                flushAllTextBatches()
                flushAllThinkingBatches()
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

                        // 崩溃恢复：agent 已死亡，将其标记为 cancelled 而非保留旧状态
                        const isStale = (tc: {status: string}) => tc.status === 'running' || tc.status === 'pending'
                        const staleCalls = (lastAssistantMsg.toolCalls || []).filter(isStale)
                        for (const tc of staleCalls) {
                            toolCallsState.registerToolCall(tc.id, {
                                status: 'cancelled',
                                progress: tc.progress || '会话中断, 工具已取消',
                            })
                            if (tc.name === 'agent' && tc.taskId) {
                                toolCallsState.registerToolCall(`sub-${tc.taskId}`, {
                                    status: 'cancelled',
                                    progress: '会话中断, 子 Agent 已取消',
                                })
                            }
                        }

                        // 同步更新消息级别状态，避免 toolCallsStore 清空后回退到持久化的 running
                        if (staleCalls.length > 0) {
                            convStore.updateMessageForConv(convId, lastAssistantMsg.id, {
                                toolCalls: (lastAssistantMsg.toolCalls || []).map(tc =>
                                    isStale(tc) ? {...tc, status: 'cancelled' as const} : tc
                                ),
                            })
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
                // ★ 方案 A：后台窗口 setTimeout 被 Chromium 节流（1s），恢复可见时强制 flush，
                //   防积压后一次性涌出渲染风暴（spec §4.2 visibilitychange 兜底）
                const onVisibilityChange = () => {
                    if (document.visibilityState === 'visible') {
                        flushAllTextBatches()
                        flushAllThinkingBatches()
                    }
                }
                document.addEventListener('visibilitychange', onVisibilityChange)
                const unsub = window.electronAPI?.onAgentStream?.((payload: any) => {
                    get().handleStreamEvent(payload)
                }) || null
                streamUnsubscribe = unsub
                return () => {
                    document.removeEventListener('visibilitychange', onVisibilityChange)
                    flushAllTextBatches()
                    flushAllThinkingBatches()
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
