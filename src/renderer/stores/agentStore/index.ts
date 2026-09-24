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

import {IDLE_STATE, DEFAULT_TOP_LEVEL, createDefaultConvData} from './defaultState'

// ★ 流式缓冲区大小限制（防活跃流式无界增长导致 OOM）
// 完整内容已通过块级增量落库到 DB，内存只需保留最近窗口供渲染
const STREAM_BUFFER_MAX_CHARS = 50000      // ~50KB 文本缓冲
const STREAM_BLOCKS_MAX_COUNT = 200        // 最大块数
// ★ 思考内容上限：thinkingContent 此前无上限，思考型长 loop 下 flushThinkingBatch
//   的 prevContent + batch 全量重拼会无界增长。与 streamBuffer 同量级（思考文本
//   体量通常远小于正文，50K 足够容纳「最近窗口」），完整思考已由主进程块级落库。
const THINKING_CONTENT_MAX_CHARS = 50000

// 保持与旧 import 路径兼容（conversationStore 等外部引用）
export {createDefaultConvData}
import {useConversationStore, flatString} from '../conversationStore'

import {flushAllTextBatches} from './batching/textBatch'
import {flushAllThinkingBatches} from './batching/thinkingBatch'
import {flushToolResultBatch, getToolResultBatchMap} from './batching/toolResultBatch'
import {syncConvToTopLevel, clearConversationRuntimeState} from './helpers/convHelpers'
import {buildSeedInstruction, applySeedInstruction} from './helpers/seedApplication'
import {updateMessageContentBlocks, reconcileStreamingContent} from './contentBlocks'
import {startAgentImpl} from './handlers/startAgent'
import {abortAgentImpl} from './handlers/abortAgent'
import {handleStreamEventImpl} from './handlers/streamEvents'

let streamUnsubscribe: (() => void) | null = null
// ★ 与 streamUnsubscribe 对称：registerStreamListener 内的另两条子订阅也须模块级持有，
//   否则「重入注册而不调用上一次的 dispose」会叠加监听（每条事件被处理多次）
let batchesUnsubscribe: (() => void) | null = null
let persistUnsubscribe: (() => void) | null = null
// 全局默认权限模式同步订阅（主进程 → 渲染，普通 IPC 通道，非 agent-stream）
let permModeSyncUnsubscribe: (() => void) | null = null

/** 方案 A：后台窗口 setTimeout 被 Chromium 节流（1s），恢复可见时强制 flush，
 *  防积压后一次性涌出渲染风暴（spec §4.2 visibilitychange 兜底）。
 *  ★ 提为模块级具名函数：registerStreamListener 重入时需在函数顶部注销上一轮监听，
 *    若仍为函数内声明的局部函数，重入时引用不同 → removeEventListener 无法命中，
 *    监听器会随每次注册不断叠加。 */
function onVisibilityChange() {
    if (document.visibilityState === 'visible') {
        flushAllTextBatches()
        flushAllThinkingBatches()
    }
}

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
            pendingToolsChangeConfirm: null,
            tasks: [],
            permissionRules: [],
            permissionMode: 'safe',
            messageDisplayMode: 'detailed',
            errorMessage: null,
            modelOverride: null,
            convAgentStates: {},
            doneUnreadIds: {},

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
                if (updates.thinkingContent !== undefined) {
                    const tc = updates.thinkingContent
                    if (typeof tc === 'string' && tc.length > THINKING_CONTENT_MAX_CHARS) {
                        // 与 streamBuffer 同模式：flatString 强制扁平复制，避免 slice(-N)
                        // 产生的 SlicedString 钉住父串；保留尾部（最近思考），完整内容已落库
                        newData.thinkingContent = flatString(tc.slice(-THINKING_CONTENT_MAX_CHARS))
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
                // ★ 兜底清理：会话删除/不活跃回收时清掉该会话的运行时工具状态与段边界状态
                //   （常规路径工具完成时已即时清理，此处兜底异常残留）
                clearConversationRuntimeState(convId)
            },

            // ── 后台会话「已完成未读」标记 ──────────────────────
            // ★ 顶层 map（不进 convAgentStates）：见 types.ts doneUnreadIds 说明。
            //   置位口径在 handleDone（reason / 激活态 / 子会话 / 调度会话 / 续跑多条件
            //   集中在事件侧一处判定），此处只做纯状态写入。
            markConvDoneUnread: (convId) => {
                set({doneUnreadIds: {...get().doneUnreadIds, [convId]: Date.now()}})
            },

            clearConvDoneUnread: (convId) => {
                const cur = get().doneUnreadIds
                // 不存在即早退：避免每次激活都产出新对象引用，触发无关订阅重渲染
                if (!(convId in cur)) return
                const next = {...cur}
                delete next[convId]
                set({doneUnreadIds: next})
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

            // ── 会话级权限模式（方案B：安全模式会话级，写 meta + 广播目标 worker） ──
            setConvPermissionMode: async (convId, mode) => {
                try {
                    const res = await window.electronAPI?.agentSetConvPermissionMode?.(convId, mode)
                    // 主进程拒绝（如子会话只读继承：error='inherited'）时不改本地状态，
                    // 避免 UI 显示一个未被接受的新值。
                    if (res?.success !== false) set({permissionMode: mode})
                } catch { /* 静默处理 */ }
            },

            // ── 会话级显示模式（纯渲染层，写 meta + 更新顶层渲染开关） ──
            setConvDisplayMode: async (convId, mode) => {
                set({messageDisplayMode: mode})
                try {
                    await window.electronAPI?.conversationUpdateMeta?.(convId, {displayMode: mode})
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

            // ── tools 变动确认（prompt 缓存重建成本） ──────────
            respondToolsChange: async (decision) => {
                const {pendingToolsChangeConfirm} = get()
                if (!pendingToolsChangeConfirm?.requestId) return

                const convId = useConversationStore.getState().activeConversationId
                if (!convId) return

                try {
                    await window.electronAPI?.agentRespondToolsChange?.({
                        conversationId: convId,
                        requestId: pendingToolsChangeConfirm.requestId,
                        decision,
                    })
                    set({pendingToolsChangeConfirm: null})
                    // ★ 恢复运行态（对齐 respondQuestion 的应答后恢复模式）：
                    //   放行路径立即回到 running，否则 status 滞留 paused 直到 LLM
                    //   首包 chunk 才被 thinking/textBatch 恢复——tools 前缀失配场景
                    //   缓存重建 → TTFT 十余秒，期间思考动画与终止按钮消失，用户误判已停止。
                    //   cancel 不恢复：本轮已 yield done(tools_change_cancelled)，交由 handleDone 归 idle。
                    const convState = get().convAgentStates[convId]
                    get().updateConvData(convId, {
                        pendingToolsChangeConfirm: null,
                        ...(decision !== 'cancel' && convState
                            ? {agentState: {...convState.agentState, status: 'running' as const}}
                            : {}),
                    })
                } catch { /* 静默处理错误 */ }
            },

            clearLoopWarning: (convId) => {
                get().updateConvData(convId, {loopWarning: undefined})
            },

            clearTurnLimitNotice: (convId) => {
                get().updateConvData(convId, {turnLimitNotice: undefined})
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
                    const status = await window.electronAPI?.agentStatus?.()
                    if (!status?.allRunning?.length) {
                        get().recoverSessionsCleanup()
                        return
                    }

                    const convStore = useConversationStore.getState()

                    for (const convId of status.allRunning) {
                        if (!convStore.messagesMap[convId]?.length) {
                            await convStore.loadMessagesInitial(convId)
                        }

                        const msgs = convStore.messagesMap[convId] || convStore.loadedMessages || []
                        const snapshot = await window.electronAPI?.agentStreamSnapshot?.(convId) ?? null

                        // 统一播种：快照 v2 → 声明式指令 → 执行
                        const instruction = buildSeedInstruction(snapshot, msgs)
                        applySeedInstruction(convId, instruction)
                        // ★ 应用会话级补丁：恢复运行态 + 阻塞双态（含 pendingToolsChangeConfirm）。
                        //   缺此步，刷新后阻塞弹窗不重现 → 无限等待的 worker 无人应答 → 永久死锁。
                        get().updateConvData(convId, instruction.convPatch)

                        syncConvToTopLevel(convId)
                        console.log(`[agentStore] 已恢复 Agent 会话: ${convId}${snapshot ? `, 消息: ${snapshot.streamingMessageId}` : '（等待首个流事件）'}`)
                    }

                    // ★ keepRunning：主进程探活返回 allRunning 的会话仍真实存活，
                    //   其 running/阻塞态是刚播种的权威状态，cleanup 不得抹除；
                    //   仅清理 worker 已死、状态陈旧的残留会话（保持 cleanup 原有作用）。
                    get().recoverSessionsCleanup(new Set(status.allRunning))
                } catch (err) {
                    console.error('[agentStore] recoverSessions 失败:', err)
                }
            },

            recoverSessionsCleanup: (keepRunning) => {
                const convStates = get().convAgentStates
                const convStore = useConversationStore.getState()
                for (const [convId, data] of Object.entries(convStates)) {
                    // 已被主进程探活确认仍存活的会话：保留其运行/阻塞态（含刚播种的
                    // pendingToolsChangeConfirm / pendingQuestion / pendingPermissionConfirm），
                    // 跳过清理，否则刷新恢复链路会被本函数当场抹掉。
                    if (keepRunning?.has(convId)) continue

                    const isBusy = data.agentState.status === 'running' || data.agentState.status === 'thinking'
                    if (!isBusy) continue

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
                // ★ 子订阅对称注销：重入注册时一并注销上一轮注册的批次/持久化监听
                batchesUnsubscribe?.()
                persistUnsubscribe?.()
                permModeSyncUnsubscribe?.()
                // ★ 与三条 IPC 子订阅对称：visibilitychange 监听也须在重入时先注销，
                //   否则每次注册都会叠加一个监听器（依赖模块级具名引用才能正确移除）
                document.removeEventListener('visibilitychange', onVisibilityChange)
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
                // ★ 侧栏元数据事件（§3.4）：message-finalized（end 块落库同事务成功后发出）
                //   → touchConversation 更新会话 updatedAt 并重排（侧栏不再依赖渲染端落库顺带刷新）
                const unsubPersist = window.electronAPI?.onAgentPersistEvent?.((e: {type: string; convId: string}) => {
                    if (e?.type === 'message-finalized' && e.convId) {
                        useConversationStore.getState().touchConversation(e.convId, Date.now())
                    }
                }) || null
                // ★ 全局默认权限模式同步：仅当「当前激活会话」在本次被同步的 convIds 内
                //   才更新输入栏显示（有会话级覆盖的会话不在 convIds，显示保持用户选择）。
                const unsubPermModeSync = window.electronAPI?.onPermissionModeSynced?.((payload) => {
                    const mode = payload?.mode
                    if (mode !== 'safe' && mode !== 'auto') return
                    const activeId = useConversationStore.getState().activeConversationId
                    if (activeId && payload?.convIds?.includes(activeId)) {
                        set({permissionMode: mode})
                    }
                }) || null
                streamUnsubscribe = unsub
                batchesUnsubscribe = unsubBatches
                persistUnsubscribe = unsubPersist
                permModeSyncUnsubscribe = unsubPermModeSync
                return () => {
                    document.removeEventListener('visibilitychange', onVisibilityChange)
                    flushAllTextBatches()
                    flushAllThinkingBatches()
                    streamUnsubscribe?.()
                    batchesUnsubscribe?.()
                    persistUnsubscribe?.()
                    permModeSyncUnsubscribe?.()
                    streamUnsubscribe = null
                    batchesUnsubscribe = null
                    persistUnsubscribe = null
                    permModeSyncUnsubscribe = null
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
                if (!state) return
                // 会话级模式：重水合后先回退全局默认（激活会话时由
                // applyConvModesToAgentStore 用 meta 覆盖），避免 persist
                // 残留最后会话的模式被误用为启动默认。
                window.electronAPI?.agentGetPermissionMode?.().then((mode: any) => {
                    if (mode === 'safe' || mode === 'auto') state.permissionMode = mode
                }).catch(() => { /* 静默 */ })
                window.electronAPI?.configRead('message-display-mode').then((data: any) => {
                    const mode = data?.mode
                    if (mode === 'detailed' || mode === 'compact' || mode === 'ultra-compact') {
                        state.messageDisplayMode = mode
                    }
                }).catch(() => { /* 静默 */ })
            },
        },
    ),
)
