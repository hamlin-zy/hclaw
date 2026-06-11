/**
 * Agent Worker Thread 入口
 *
 * 在独立线程中运行 Agent Loop，通过 parentPort 与主进程通信。
 * 主进程通过 AgentManager 创建此 Worker。
 */

import {MessagePort, parentPort, workerData} from 'worker_threads'
import {agentLoop} from './loop'
import {registerBuiltinTools} from './tools/index'
import {permissionEngine} from './tools/permission'
import {registerMCPTools, setMcpMessagePort, unregisterMCPTools} from './mcp/discovery'
import {promptResolver} from './prompts/resolver'
import {WORKER_MESSAGE_TYPES} from './constants'
import {applySerializedCapabilitiesInWorker} from './capabilityManager'
import type {AgentStartParams} from './manager'
import {updateGlobalScheme} from './model/index'
import {runtimeConfigManager} from './runtimeConfigManager'
import {taskStore} from './tasks/taskStore'
import {logger} from './logger'
import {getMessagePreview} from './utils/contentUtils'

/** Phase 2: 通过 MessagePort 从 MCP Worker 获取已连接的工具列表 */
async function listMcpServersFromWorker(port: MessagePort): Promise<Array<{
    id: string
    name: string
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
    userDescription?: string
}>> {
    return new Promise((resolve) => {
        const handler = (msg: any) => {
            if (msg.type === 'all_result') {
                port.off('message', handler)
                resolve(msg.servers || [])
            }
        }
        port.on('message', handler)
        port.postMessage({type: 'list_all', callId: 'init'})
    })
}

/** 通知主进程同步权限规则 */
function syncPermissionRulesToMain(): void {
    parentPort?.postMessage({type: WORKER_MESSAGE_TYPES.SYNC_PERMISSION_RULES})
}

/** 导出给 executor.ts 使用 */
export {syncPermissionRulesToMain}

/** Phase 2: 从主进程请求 MCP MessagePort（共享 MCP Worker 连接） */
function requestMcpPort(): Promise<MessagePort | null> {
    return new Promise((resolve) => {
        // 5 秒超时降级
        const timer = setTimeout(() => {
            parentPort?.off('message', handler)
            resolve(null)
        }, 5000)

        const handler = (msg: any) => {
            if (msg.type === 'mcp_port' && msg.port) {
                clearTimeout(timer)
                parentPort?.off('message', handler)
                resolve(msg.port)
            }
        }
        parentPort?.on('message', handler)
        parentPort?.postMessage({type: 'request_mcp_port'})
    })
}

async function main(): Promise<void> {
    const params = workerData.params as AgentStartParams & { settings?: import('@shared/types').SystemSettings }

    if (!params) {
        parentPort?.postMessage({
            type: 'error',
            conversationId: 'unknown',
            event: {type: 'error', error: 'No params provided'},
        })
        return
    }

// 加载全局系统设置（从主进程传递，不再从本地文件读取）
    let currentSettings: import('@shared/types').SystemSettings = params.settings || {
        agent: {
            maxTurns: 500,
            retryCount: 10,
            initialRetryDelay: 5000,
            maxRetryDelay: 120000,
            llmTimeout: 600000,
            compactThreshold: 700000
        },
        model: {defaultMaxTokens: 8000, defaultTemperature: 0},
        mcp: {mcpTestTimeout: 15000},
        ui: {language: 'zh-CN', theme: 'system'}
    }

// 创建运行时配置对象（用于实时更新）
    const runtimeConfig = {
        modelConfig: params.modelConfig,
        settings: currentSettings,
        pendingCompact: false,  // 待执行的压缩请求
    }

    // 初始化 runtimeConfigManager（Worker 进程）
    // runtimeConfigManager 是模块单例，需要显式初始化
    runtimeConfigManager.initialize({
        defaultWorkingDir: params.workingDir,
        defaultMode: 'safe',
    })

    // 同步系统设置到 RuntimeConfigManager（使工具函数能读取用户配置）
    runtimeConfigManager.updateSettings(currentSettings)

    // 从 params.schemeConfig 同步当前方案（agent-start 传递的）
    if (params.schemeConfig) {

        runtimeConfigManager.syncFromMain({
            scheme: {
                id: params.schemeConfig.scheme.id,
                scheme: params.schemeConfig.scheme,
                providers: params.schemeConfig.providers as any,
            },
        })

        // 同步到全局方案管理器，确保 controller 能正确读取当前方案
        // 与运行时 UPDATE_SCHEME 处理逻辑保持一致
        updateGlobalScheme(
            params.schemeConfig.scheme.id,
            params.schemeConfig.scheme,
            params.schemeConfig.providers as any,
        )
    }

    // 同步工作模式（如果传入了 workMode）
    if (params.workMode) {
        runtimeConfigManager.setWorkMode(params.workMode)
    }

// 加载提示词配置
    // 创建 AbortController 用于接收主进程的终止信号
    const abortController = new AbortController()

    // 加载提示词方案（从 SQLite）
    try {
        const {promptSchemeRepo} = await import('../repositories/sqlite/promptSchemeRepository')
        const activeId = promptSchemeRepo.getActiveId()
        if (activeId) {
            const scheme = promptSchemeRepo.getById(activeId)
            if (scheme) {
                promptResolver.loadScheme(scheme)
                
            } else {
                
            }
        } else {
            
        }
    } catch (err: any) {
        const _nodeErr = err as NodeJS.ErrnoException
        
    }

    // 注意：记忆引擎现在在主进程初始化（见 initAgent）
    // Worker 中的工具通过 IPC 调用主进程的 engine
    const _power = runtimeConfigManager.getConfig()

    // 加载能力（优先使用主进程传递的序列化能力列表）
    try {
        if (params.capabilities) {
            // 新模式：直接应用主进程传递的能力列表

            await applySerializedCapabilitiesInWorker(params.capabilities)
        } else {
            // 兼容模式：如果没有传递 capabilities，则使用旧的加载方式
            // 修复 P1-1: 保留初始化但不赋值给变量（向后兼容）
            const {powerManager} = await import('./powerManager')
            await powerManager.initialize()
            // power 变量保留用于后续扩展，目前仅做初始化
            const _power = await powerManager.getAllEnabledPower()
        }
    } catch (err: any) {
        
    }

    // ── 在 Worker 中注册工具 ──
    // Phase 2 优化: 通过 MessagePort 直连 MCP Worker（共享连接池）
    let mcpPort: MessagePort | null = null
    try {
        registerBuiltinTools()

        // Phase 2: 请求 MCP Worker 端 MessagePort
        mcpPort = await requestMcpPort()

        if (mcpPort) {
            setMcpMessagePort(mcpPort)

            // 从 MCP Worker 获取已连接的服务器工具列表
            const servers = await listMcpServersFromWorker(mcpPort)

            // 仅注册已连接的 MCP 工具
            for (const server of servers) {
                if (server.tools && server.tools.length > 0) {
                    registerMCPTools(server.id, server.tools as any, server.userDescription)
                }
            }

            // 监听 MCP Worker 的工具更新通知
            mcpPort.on('message', (msg: any) => {
                if (msg.type === 'server_tools_update') {
                    // 工具状态变化时重注册
                    unregisterMCPTools(msg.server.id)
                    if (msg.server.status === 'connected' && msg.server.tools.length > 0) {
                        registerMCPTools(msg.server.id, msg.server.tools, msg.server.userDescription)
                    }
                }
            })

            logger.info('[MCP] MCP Worker connected (' + servers.length + ' servers)')
        } else {
            logger.warn('[MCP] MCP Worker unavailable (timeout)')
        }
    } catch (err: any) {
        parentPort?.postMessage({
            type: 'error',
            conversationId: params.conversationId || 'unknown',
            event: {type: 'error', error: 'Failed to register tools: ' + err.message},
        })
        return
    }

    // 注册清理函数（进程退出时）
    process.on('exit', () => {
        
        if (mcpPort) {
            try {
                mcpPort.close()
            } catch { /* 忽略 */
            }
        }
    })

    // 处理主进程消息（MCP Worker 不可用/恢复通知）
    parentPort?.on('message', async (msg: any) => {
        if (msg.type === 'mcp_worker_unavailable') {
            
            setMcpMessagePort(null)
            if (mcpPort) {
                try {
                    mcpPort.close()
                } catch { /* 忽略 */
                }
                mcpPort = null
            }
            // 取消注册所有 MCP 工具
            const {toolRegistry: tr} = await import('./tools/registry')
            for (const tool of tr.getAll()) {
                if (tool.name.startsWith('mcp_')) {
                    tr.unregister(tool.name)
                }
            }
        }
    })

    // Phase 3: Hook 系统初始化（迁入 Worker 执行）
    // 收集 SessionStart/UserPromptSubmit hook 返回的 additionalContext
    let hookAdditionalContext = ''
    try {
        const {registerBuiltinHandlers: regHooks, hookExecutor: wkHookExe} = await import('../plugin/hooks')
        regHooks(wkHookExe)

        const {loadHooksFromDirectory: loadHooks} = await import('./hooks/loader')
        loadHooks().catch((err: any) =>
            {}
        )

        // 收集所有 hook 的 additionalContext
        async function collectHookContext(
            events: Array<{name: string; context: Record<string, unknown>}>,
        ): Promise<string> {
            const parts: string[] = []
            for (const {name, context} of events) {
                try {
                    const result = await wkHookExe.execute(name as any, context)
                    if (result?.additionalContext) {
                        parts.push(result.additionalContext)
                    }
                } catch (err: any) {
                    
                }
            }
            return parts.join('\n\n---\n\n')
        }

        const firstMsg = params.messages?.[0]
        const userPrompt = firstMsg?.role === 'user'
            ? (typeof firstMsg.content === 'string' ? firstMsg.content : '')
            : undefined

        hookAdditionalContext = await collectHookContext([
            {name: 'SessionStart', context: {sessionId: params.conversationId}},
            {name: 'UserPromptSubmit', context: {sessionId: params.conversationId, prompt: userPrompt}},
        ])

        if (hookAdditionalContext) {
            params.hookAdditionalContext = hookAdditionalContext
        }
    } catch (err: any) {
        
    }

    try {
        // ── 方案更新同步机制 ──
        // 确保方案切换完成后再继续 LLM 调用
        let schemeUpdatePromise = Promise.resolve()
        // 处理权限确认请求的 Promise 映射
        const confirmationRequests = new Map<string, (result: 'allow' | 'always' | 'deny') => void>()

        // 处理 ask_user 提问的 Promise 映射
        const askUserRequests = new Map<string, (answer: string) => void>()

        const requestConfirmation = (message: string): Promise<'allow' | 'always' | 'deny'> => {
            return new Promise((resolve) => {
                const requestId = Math.random().toString(36).substring(7)

                // 如果已经 abort，直接拒绝
                if (abortController.signal.aborted) {
                    resolve('deny')
                    return
                }

                // 不设置超时 - 永久等待用户响应，自动执行危险操作
                confirmationRequests.set(requestId, (result) => {
                    resolve(result)
                })

                // 发送权限确认请求到主进程，由主进程转发给渲染进程
                parentPort?.postMessage({
                    type: WORKER_MESSAGE_TYPES.PERMISSION_CONFIRM,
                    conversationId: params.conversationId,
                    requestId,
                    message,
                })
            })
        }

        // 向用户提问并等待回答（永久等待，不超时）
        const askUserQuestion = (question: string, options?: string[], multiSelect?: boolean): Promise<string> => {
            return new Promise((resolve) => {
                const requestId = Math.random().toString(36).substring(7)

                // 如果已经 abort，直接返回空回答
                if (abortController.signal.aborted) {
                    resolve('')
                    return
                }

                // 不设置超时 - 永久等待用户响应，避免自动继续执行
                askUserRequests.set(requestId, (answer) => {
                    resolve(answer)
                })

                // 发送提问到主进程，由主进程转发给渲染进程
                parentPort?.postMessage({
                    type: WORKER_MESSAGE_TYPES.ASK_USER_QUESTION,
                    conversationId: params.conversationId,
                    requestId,
                    question,
                    options,
                    multiSelect,
                })
            })
        }

        // 渠道消息发送请求（通过 parentPort IPC 请求主进程转发）
        const channelSendRequests = new Map<string, (result: { success: boolean; error?: string }) => void>()
        const channelSend = (channelId: string, toUser: string, text: string, contextToken?: string, fileType?: string): Promise<{ success: boolean; error?: string }> => {
            return new Promise((resolve) => {
                const requestId = Math.random().toString(36).substring(7)

                if (abortController.signal.aborted) {
                    resolve({success: false, error: 'Agent 已中止'})
                    return
                }

                channelSendRequests.set(requestId, resolve)

                // 当 fileType 存在时，text 参数实际是 filePath，走媒体发送通道
                if (fileType) {
                    parentPort?.postMessage({
                        type: WORKER_MESSAGE_TYPES.CHANNEL_SEND_MEDIA,
                        conversationId: params.conversationId,
                        requestId,
                        channelId,
                        toUser,
                        filePath: text,          // text 参数实际是 filePath
                        fileType,
                        contextToken: contextToken || '',
                    })
                } else {
                    parentPort?.postMessage({
                        type: WORKER_MESSAGE_TYPES.CHANNEL_SEND,
                        conversationId: params.conversationId,
                        requestId,
                        channelId,
                        toUser,
                        text,
                        contextToken: contextToken || '',
                    })
                }
            })
        }

        // ★ 运行中注入的用户消息队列（通过 parentPort 接收，供 Controller 读取） ★
        // 主进程转发的新用户消息会 push 到此数组中，
        // Controller 在每轮 LLM 调用前检查并注入到 currentState
        const pendingInjectedMessages: import('./model/types').ChatMessage[] = []

        // 监听来自主进程的消息（如配置更新、用户确认结果、用户回答和终止信号）
        parentPort?.on('message', async (msg) => {
            if (msg.type === WORKER_MESSAGE_TYPES.UPDATE_CONFIG) {
                runtimeConfig.modelConfig = msg.modelConfig
            } else if (msg.type === WORKER_MESSAGE_TYPES.UPDATE_SETTINGS) {
                runtimeConfig.settings = msg.settings
                // 同步到 RuntimeConfigManager，使工具函数能读取最新配置
                runtimeConfigManager.updateSettings(msg.settings)
            } else if (msg.type === WORKER_MESSAGE_TYPES.UPDATE_SCHEME) {
                if (msg.schemeConfig) {
                    params.schemeConfig = msg.schemeConfig
                    runtimeConfigManager.syncFromMain({
                        scheme: {
                            id: msg.schemeConfig.scheme.id,
                            scheme: msg.schemeConfig.scheme,
                            providers: msg.schemeConfig.providers,
                        },
                    })
                    updateGlobalScheme(msg.schemeConfig.scheme.id, msg.schemeConfig.scheme, msg.schemeConfig.providers)
                }
            } else if (msg.type === WORKER_MESSAGE_TYPES.UPDATE_PERMISSION_MODE) {
                if (msg.permissionMode) {
                    await permissionEngine.setMode(msg.permissionMode)
                    runtimeConfigManager.syncFromMain({mode: msg.permissionMode})
                }
            } else if (msg.type === WORKER_MESSAGE_TYPES.UPDATE_WORK_MODE) {
                if (msg.workMode) {
                    runtimeConfigManager.setWorkMode(msg.workMode)
                }
            } else if (msg.type === WORKER_MESSAGE_TYPES.USER_CONFIRMATION_RESULT) {
                const resolve = confirmationRequests.get(msg.requestId)
                if (resolve) {
                    resolve(msg.result)
                    confirmationRequests.delete(msg.requestId)
                    // 注意：不同步规则到主进程
                    // executor 会在用户选择 "always" 后调用 permissionEngine.addRule()
                    // 下面的变化检测机制（第 334-340 行）会检测到规则数量变化并自动同步
                }
            } else if (msg.type === WORKER_MESSAGE_TYPES.USER_ANSWER_RESULT) {
                const resolve = askUserRequests.get(msg.requestId)
                if (resolve) {
                    resolve(msg.answer)
                    askUserRequests.delete(msg.requestId)
                }
            } else if (msg.type === WORKER_MESSAGE_TYPES.CHANNEL_SEND_RESULT) {
                const resolve = channelSendRequests.get(msg.requestId)
                if (resolve) {
                    resolve({success: msg.success, error: msg.error})
                    channelSendRequests.delete(msg.requestId)
                }
            } else if (msg.type === WORKER_MESSAGE_TYPES.REFRESH_MCP_TOOLS) {
                // Phase 2: 通过 MCP Worker MessagePort 重新获取工具列表
                try {
                    if (mcpPort) {
                        const servers = await listMcpServersFromWorker(mcpPort)
                        // 清除所有现有 MCP 工具
                        const {toolRegistry: tr} = await import('./tools/registry')
                        for (const tool of tr.getAll()) {
                            if (tool.name.startsWith('mcp_')) {
                                tr.unregister(tool.name)
                            }
                        }
                        // 重新注册
                        for (const server of servers) {
                            if (server.tools && server.tools.length > 0) {
                                registerMCPTools(server.id, server.tools as any, server.userDescription)
                            }
                        }
                    }
                } catch (err: any) {
                    logger.info('[MCP] MCP tools refresh failed:', err.message)
                }
            } else if (msg.type === WORKER_MESSAGE_TYPES.INJECT_USER_MESSAGE) {
                // 接收主进程转发的新用户消息，存入队列供 Controller 读取
                if (msg.message) {
                    const userMsg: import('./model/types').ChatMessage = {
                        role: 'user',
                        content: msg.message.content || '',
                        id: msg.message.id || `inject-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    }
                    pendingInjectedMessages.push(userMsg)
                    
                }
            } else if (msg.type === WORKER_MESSAGE_TYPES.ABORT) {
                // 接收到终止信号，触发 AbortController
                abortController.abort()
                // 拒绝所有待处理的确认请求
                confirmationRequests.forEach((resolve) => resolve('deny'))
                confirmationRequests.clear()
                // 清空所有待处理的 ask_user 请求
                askUserRequests.forEach((resolve) => resolve(''))
                askUserRequests.clear()
                channelSendRequests.forEach((resolve) => resolve({success: false, error: 'Agent 已中止'}))
                channelSendRequests.clear()
            }
        })

        // 初始化任务存储，绑定 sendMessage 以发送 tasks_update 事件
        taskStore.init((msg) => {
            parentPort?.postMessage({
                type: 'stream',
                conversationId: params.conversationId,
                event: {type: msg.type, tasks: msg.tasks},
            })
        })

    // 注册清理函数（进程退出时）
    

    // 运行 Agent Loop，传递 abortSignal 和 askUserQuestion
        let lastRuleCount = (await permissionEngine.getRules()).length
        for await (const event of agentLoop({
            sessionId: params.conversationId,
            messages: params.messages,
            modelConfig: params.modelConfig,
            settings: runtimeConfig.settings, // 传递当前设置（引用，动态更新）
            workingDir: params.workingDir,
            maxTurns: params.maxTurns,
            customInstructions: params.customInstructions,
            skills: params.skills,
            mcpServers: params.mcpServers,
            agentTemplates: params.agentTemplates,
            schemeConfig: params.schemeConfig,
            requestConfirmation,
            askUserQuestion,
            channelSend,
            abortSignal: abortController.signal,
            conversationTitle: params.conversationTitle,
            // 传递方案更新 Promise 函数供 Loop 内部使用
            schemeUpdatePromise: () => schemeUpdatePromise,
            runtimeConfig, // 传递运行时配置引用（用于检查 pendingCompact）
            // 将消息元数据传递给 Loop，供识别命令模式
            // 注意：messageMetadata 需要从 ChatMessage 中提取，agentLoop 需要处理这个
            messageMetadata: params.messageMetadata,
            // 传递 Hook 收集的 additionalContext（SessionStart/UserPromptSubmit hook 返回）
            hookAdditionalContext: params.hookAdditionalContext,
            // 传递运行中注入的用户消息队列引用
            pendingInjectedMessages,
            onEvent: (e) => {
                parentPort?.postMessage({
                    type: 'stream',
                    conversationId: params.conversationId,
                    event: e,
                })
            }
        })) {
            // 检查权限规则是否变化（工具执行后用户点击"始终允许"会添加规则）
            const currentRuleCount = (await permissionEngine.getRules()).length
            if (currentRuleCount !== lastRuleCount) {
                // 确保规则被去重并保存到文件（防止重复项）
                if (typeof permissionEngine.cleanAndSave === 'function') {
                    await permissionEngine.cleanAndSave()
                }
                parentPort?.postMessage({type: WORKER_MESSAGE_TYPES.SYNC_PERMISSION_RULES})
                lastRuleCount = currentRuleCount
            }

      // 转发事件到主进程
      parentPort?.postMessage({
        type: 'stream',
        conversationId: params.conversationId,
        event,
      })

      // 检查是否结束
      if (event.type === 'done') {
        break
      }
    }

    // ── Agent 结束后检查残留的注入消息 ──
    // 场景：用户在 LLM 调用期间插入了消息，但循环在没有消费的情况下退出了
    // （如 max_turns 耗尽、无工具调用且 Fix 1 来不及处理等极端情况）
    if (pendingInjectedMessages.length > 0) {
      logger.info(`[Worker] Agent 结束后发现 ${pendingInjectedMessages.length} 条未处理的注入消息，转发回主进程`, {
        firstContent: getMessagePreview(pendingInjectedMessages[0]),
      })
      // 转发残留消息到主进程，由主进程保存到会话历史并触发新 Agent
      parentPort?.postMessage({
        type: WORKER_MESSAGE_TYPES.PENDING_MESSAGES_AFTER_EXIT,
        conversationId: params.conversationId,
        messages: pendingInjectedMessages.map(m => ({
          content: typeof m.content === 'string' ? m.content : '',
          id: m.id || `inject-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        })),
      })
    }
  } catch (err: any) {
    parentPort?.postMessage({
      type: 'error',
      conversationId: params.conversationId,
      event: { type: 'error', error: err.message },
    })
  } finally {
    // Worker 中的记忆引擎通过 IPC 管理，无需在此清理
  }
}

main().catch((err) => {
    const errorMessage = err instanceof Error ? err.message : String(err)
    const errorStack = err instanceof Error ? err.stack : undefined
    logger.error('[Worker] main() failed:', {error: errorMessage, stack: errorStack})
    parentPort?.postMessage({
        type: 'error',
        conversationId: (workerData?.params as any)?.conversationId || 'unknown',
        event: {type: 'error', error: `Worker fatal error: ${errorMessage}`},
    })
})
