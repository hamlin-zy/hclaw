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
import type {RunMode, Task} from '@shared/types'

import type {AgentStore} from './types'

import {IDLE_STATE, STREAMING_STATE, DEFAULT_TOP_LEVEL, createDefaultConvData} from './defaultState'

// ★ 流式缓冲区大小限制（防活跃流式无界增长导致 OOM）
// 完整内容已通过块级增量落库到 DB，内存只需保留最近窗口供渲染
const STREAM_BUFFER_MAX_CHARS = 50000      // ~50KB 文本缓冲
const STREAM_BLOCKS_MAX_COUNT = 200        // 最大块数

// 保持与旧 import 路径兼容（conversationStore 等外部引用）
export {createDefaultConvData}
import {useConversationStore, flatString} from '../conversationStore'
import {useToolCallsStore} from '../toolCallsStore'

import {flushAllTextBatches} from './batching/textBatch'
import {flushAllThinkingBatches} from './batching/thinkingBatch'
import {flushToolResultBatch, getToolResultBatchMap} from './batching/toolResultBatch'
import {saveHmrContext, restoreFromHmr} from './helpers/hmrPersistence'
import {syncConvToTopLevel} from './helpers/convHelpers'
import {planRecovery} from './helpers/recoverySeeding'
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
                let newData = {...prev, ...updates}

                // ★ 流式缓冲区大小限制：防活跃流式无界增长导致 OOM
                // 完整内容已通过块级增量落库到 DB，内存只保留最近窗口供渲染
                if (updates.streamBuffer !== undefined) {
                    const buf = updates.streamBuffer
                    if (typeof buf === 'string' && buf.length > STREAM_BUFFER_MAX_CHARS) {
                        // flatString 强制扁平复制：slice(-N) 产生 SlicedString 会钉住整个父串
                        newData.streamBuffer = flatString(buf.slice(-STREAM_BUFFER_MAX_CHARS))
                    }
                }
                if (updates.streamBlocks !== undefined) {
                    const blocks = updates.streamBlocks
                    if (Array.isArray(blocks) && blocks.length > STREAM_BLOCKS_MAX_COUNT) {
                        newData.streamBlocks = blocks.slice(-STREAM_BLOCKS_MAX_COUNT)
                    }
                }

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

            // ── 任务批次水合（应用重启/刷新恢复） ──────────────────────
            // 从主进程 DB 读取活跃批次快照写入 convData；TodoStrip 依赖此数据
            // 在无实时事件时恢复显示。updateConvData 内部按 activeConversationId
            // 同步顶层，激活会话水合后 UI 立即生效。
            hydrateActiveBatch: async (conversationId) => {
                try {
                    const result = await window.electronAPI?.taskBatches?.getActive?.(conversationId)
                    if (!result?.batch) return
                    // ★ 竞态守卫：水合 await 期间若实时 tasks_update 已写入批次态，
                    //   以内存中的实时数据为准，放弃覆盖
                    if (get().convAgentStates[conversationId]?.currentBatch) return
                    get().updateConvData(conversationId, {
                        tasks: (result.tasks || []).map((t: {id: string; title: string; description?: string; status: string}) => ({
                            id: t.id,
                            title: t.title,
                            description: t.description,
                            status: t.status,
                        })) as Task[],
                        currentBatch: {
                            id: result.batch.id,
                            name: result.batch.name,
                            status: result.batch.status === 'completed' ? 'completed' : 'active',
                        },
                    })
                } catch (err) {
                    // 水合失败不阻塞会话 UI，但需留排查线索
                    console.warn('[agentStore] hydrateActiveBatch 失败:', err)
                }
            },

            // ── 跨窗口批次删除同步（历史任务组窗口删除后广播触发） ──────────────
            // 与 hydrateActiveBatch 同构但不做「实时优先」守卫：触发时机即 DB 已变化，
            // 以 DB 为准。DB 无活跃批次时清空残留，防止 TodoStrip 显示已删数据。
            refreshActiveBatch: async (conversationId) => {
                try {
                    const result = await window.electronAPI?.taskBatches?.getActive?.(conversationId)
                    if (!result?.batch) {
                        const existing = get().convAgentStates[conversationId]
                        if (existing?.currentBatch || existing?.tasks.length) {
                            get().updateConvData(conversationId, {currentBatch: undefined, tasks: []})
                        }
                        return
                    }
                    get().updateConvData(conversationId, {
                        tasks: (result.tasks || []).map((t: {id: string; title: string; description?: string; status: string}) => ({
                            id: t.id,
                            title: t.title,
                            description: t.description,
                            status: t.status,
                        })) as Task[],
                        currentBatch: {
                            id: result.batch.id,
                            name: result.batch.name,
                            status: result.batch.status === 'completed' ? 'completed' : 'active',
                        },
                    })
                } catch (err) {
                    // 同步失败不阻塞会话 UI，但需留排查线索
                    console.warn('[agentStore] refreshActiveBatch 失败:', err)
                }
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

                        const msgs = convStore.messagesMap[convId] || convStore.loadedMessages || []
                        const lastAssistantMsg = [...msgs].reverse().find((m) => m.role === 'assistant')

                        // ★ 崩溃恢复播种（P1）：以主进程流快照为唯一事实源。
                        //   旧实现取 DB 最后一条 assistant 消息的 metadata.content——assistant
                        //   正文不存 metadata（只在 blocks）→ streamBuffer 恒空 → 空白幽灵气泡；
                        //   当前轮消息行未落库时会错位选中旧消息。
                        //   决策逻辑见 helpers/recoverySeeding.ts planRecovery。
                        const snapshot = await window.electronAPI?.agentStreamSnapshot?.(convId) ?? null
                        const plan = planRecovery(snapshot, msgs)

                        // 崩溃窗口丢失结果的工具（DB running 但快照不含）：标记取消 + 同步消息级状态，
                        // 避免 toolCallsStore 清空后回退到持久化的 running
                        if (plan.staleToolIds.length > 0 && lastAssistantMsg) {
                            const staleSet = new Set(plan.staleToolIds)
                            for (const tc of lastAssistantMsg.toolCalls || []) {
                                if (!staleSet.has(tc.id)) continue
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
                            convStore.updateMessageForConv(convId, lastAssistantMsg.id, {
                                toolCalls: (lastAssistantMsg.toolCalls || []).map(tc =>
                                    staleSet.has(tc.id) ? {...tc, status: 'cancelled' as const} : tc
                                ),
                            })
                        }

                        // 快照中真实在跑的工具：注册为 running，UI 保持执行态
                        for (const tcId of plan.liveToolIds) {
                            toolCallsState.registerToolCall(tcId, {status: 'running'})
                        }

                        if (plan.seed) {
                            const seedId = plan.seed.streamingMessageId
                            if (!msgs.some(m => m.id === seedId)) {
                                // DB 行未建（首 flush 前崩溃）→ 用快照数据占位
                                convStore.addMessageToConv(convId, {
                                    id: seedId,
                                    role: 'assistant',
                                    content: plan.seed.streamBuffer,
                                })
                            } else {
                                // 已有半成品行 → 快照全文覆盖内存 content
                                convStore.updateMessageForConv(convId, seedId, {
                                    content: plan.seed.streamBuffer,
                                })
                            }
                            get().updateConvData(convId, {
                                streamingMessageId: seedId,
                                streamBuffer: plan.seed.streamBuffer,
                                thinkingContent: plan.seed.thinkingContent,
                                recoveredTextBlockBase: snapshot?.dbTextBlockCount ?? 0,
                                // ★ 崩溃恢复标记：即使 DB 中 seedId 消息 endedAt 已写（崩溃前
                                //   worker 落库），下一轮流式仍应复用该 id（与主进程 pending 对齐），
                                //   否则 ensureStreamingMessage 因 endedAt 检测置 null 生成新 id
                                //   → 渲染端内存出现第二条 assistant（幽灵气泡）。
                                recoveredStreaming: true,
                                agentState: STREAMING_STATE,
                            })
                        } else {
                            // worker 在跑但尚无累积（首 token 前）：仅置运行态，
                            // 不指向任何历史消息（防错位幽灵气泡）
                            get().updateConvData(convId, {agentState: STREAMING_STATE})
                        }

                        restored.add(convId)
                        syncConvToTopLevel(convId)
                        console.log(`[agentStore] 已恢复 Agent 会话: ${convId}${plan.seed ? `, 消息: ${plan.seed.streamingMessageId}` : '（等待首个流事件）'}`)
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
                // 跨窗口批次删除同步：历史任务组窗口删了本窗口会话的批次 → 以 DB 为准刷新
                const unsubBatches = window.electronAPI?.onTaskBatchesChanged?.((payload) => {
                    for (const convId of payload?.conversationIds ?? []) {
                        void get().refreshActiveBatch(convId)
                    }
                }) || null
                streamUnsubscribe = unsub
                return () => {
                    document.removeEventListener('visibilitychange', onVisibilityChange)
                    flushAllTextBatches()
                    flushAllThinkingBatches()
                    saveHmrContext()
                    streamUnsubscribe?.()
                    unsubBatches?.()
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
