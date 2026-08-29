import {contextBridge, ipcRenderer, webUtils} from 'electron'
import type {UpdateResult} from '../shared/types/updater'

// 从 additionalArguments 读取初始主题（窗口创建前由主进程从 SQLite 读取原始主题名）
// 主进程已传递原始名称（'dark'/'light'/'yuanshandai'/'shiyangjin'），不再映射
const themeArg = process.argv.find(arg => arg.startsWith('--hclaw-theme='))
const initialThemeValue = themeArg ? themeArg.split('=')[1] : 'light'

// 从 additionalArguments 读取 Win11 标识（同步，无需 IPC 往返）
const win11Arg = process.argv.find(arg => arg.startsWith('--hclaw-win11='))
const isWin11 = win11Arg ? win11Arg.split('=')[1] === '1' : false

// 从 additionalArguments 读取 macOS 标识（用于 TitleBar 左侧交通灯间距）
const darwinArg = process.argv.find(arg => arg.startsWith('--hclaw-darwin='))
const isDarwin = darwinArg ? darwinArg.split('=')[1] === '1' : false

// 从 additionalArguments 读取窗口 id（独立窗口才有；主窗口无此参数 → windowControls 不注入）
const windowIdArg = process.argv.find(arg => arg.startsWith('--hclaw-window-id='))
const windowId = windowIdArg ? windowIdArg.split('=')[1] : ''

// 从 additionalArguments 读取配置窗口类型（仅配置窗口有）
const dialogArg = process.argv.find(arg => arg.startsWith('--hclaw-dialog='))
const dialogType = dialogArg ? dialogArg.split('=')[1] : ''

// 从 additionalArguments 读取任务历史窗口的限定会话 id（仅 task-history-conv 窗口有）
const taskConvArg = process.argv.find(arg => arg.startsWith('--hclaw-task-conv='))
const taskConvId = taskConvArg ? taskConvArg.split('=')[1] : ''

contextBridge.exposeInMainWorld('electronAPI', {
    initialTheme: initialThemeValue,
    isWin11,
    isDarwin,
  // Window control
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    getPlatform: () => ipcRenderer.invoke('get-platform'),
    isWindows11: () => ipcRenderer.invoke('is-windows-11'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  isMaximized: () => ipcRenderer.invoke('is-maximized'),

  // Updater
  updaterGetStatus: () => ipcRenderer.invoke('updater:get-status'),
  updaterCheckForUpdate: () => ipcRenderer.invoke('updater:check-for-update'),
  onUpdaterStatusChanged: (callback: (result: UpdateResult) => void) => {
    const handler = (_: unknown, result: unknown) => callback(result as UpdateResult)
    ipcRenderer.on('updater:status-changed', handler)
    return () => ipcRenderer.removeListener('updater:status-changed', handler)
  },

  // 模型方案变更推送（其他窗口改了 model-schemes → 本窗口需重新 hydration）
  onModelSchemesChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('model-schemes-changed', handler)
    return () => ipcRenderer.removeListener('model-schemes-changed', handler)
  },

  // 模型配置（providers/models）变更推送（其他窗口改了 llm 配置 → 本窗口需重新 hydration）
  onLlmConfigChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('llm-config-changed', handler)
    return () => ipcRenderer.removeListener('llm-config-changed', handler)
  },

  // 工具列表变更推送（其他窗口改了工具启用/超时 → 本窗口需重新加载）
  onToolsChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('tools-changed', handler)
    return () => ipcRenderer.removeListener('tools-changed', handler)
  },

  // 提示词方案变更推送（其他窗口改了 prompt-schemes → 本窗口需重新 hydration）
  onPromptSchemesChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('prompt-schemes-changed', handler)
    return () => ipcRenderer.removeListener('prompt-schemes-changed', handler)
  },

    // 监听最大化状态变化（用于更新 UI）
    onWindowMaximizedChange: (callback: (isMaximized: boolean) => void) => {
        const handler = (_: unknown, isMaximized: boolean) => callback(isMaximized)
        ipcRenderer.on('window-maximized-changed', handler)
        return () => ipcRenderer.removeListener('window-maximized-changed', handler)
    },

  // Agent messaging
  onAgentMessage: (callback: (message: unknown) => void) => {
    const handler = (_: unknown, message: unknown) => callback(message)
    ipcRenderer.on('agent-message', handler)
    return () => ipcRenderer.removeListener('agent-message', handler)
  },
  sendAgentCommand: (command: string) => {
    ipcRenderer.send('agent-command', command)
  },

  // Agent stream (流式事件监听)
  onAgentStream: (callback: (payload: any) => void) => {
    const handler = (_: unknown, payload: any) => callback(payload)
    ipcRenderer.on('agent-stream', handler)
    return () => ipcRenderer.removeListener('agent-stream', handler)
  },
  agentStart: (params: import('../shared/types').AgentStartParams) =>
    ipcRenderer.invoke('agent-start', params),
  agentAbort: (conversationId: string) =>
    ipcRenderer.invoke('agent-abort', conversationId),
  agentLoopSilence: (conversationId: string, fingerprint: string) =>
    ipcRenderer.invoke('agent-loop-silence', conversationId, fingerprint),
  agentRegisterStreamingMessage: (conversationId: string, messageId: string) =>
    ipcRenderer.invoke('agent-register-streaming-message', conversationId, messageId),
  agentInjectMessage: (params: { conversationId: string; content: string; messageId?: string }) =>
    ipcRenderer.invoke('agent-inject-message', params),
  agentStatus: (conversationId?: string) =>
    ipcRenderer.invoke('agent-status', conversationId),
  agentStreamSnapshot: (conversationId: string) =>
    ipcRenderer.invoke('agent-stream-snapshot', conversationId),
  contextGetUsage: (conversationId: string) =>
    ipcRenderer.invoke('context:get-usage', conversationId),
    agentRespondConfirmation: (params: {
        conversationId: string
        requestId: string
        result: 'allow' | 'always' | 'deny'
    }) => ipcRenderer.invoke('agent-respond-confirmation', params),
    agentRespondAskUser: (params: {
        conversationId: string
        requestId: string
        answer: string
    }) => ipcRenderer.invoke('agent-respond-ask-user', params),
    agentWarmupClients: (data: {
        scheme: import('../shared/types').ModelScheme
        providers: Array<{
            id: string
            name: string
            type: 'anthropic' | 'openai' | 'google' | 'ollama' | 'custom'
            authType?: 'api-key' | 'google-oauth2'
            credentials?: {
                apiKey?: string
                accessToken?: string
                refreshToken?: string
                expiryDate?: number
            }
            apiKey?: string
            baseUrl?: string
            enabled: boolean
            models: Array<{ id: string; name: string; enabled: boolean }>
        }>
    }) => ipcRenderer.invoke('agent-warmup-clients', data),
    updateModelScheme: (data: {
        schemeId: string
        scheme: import('../shared/types').ModelScheme
        providers: Array<{
            id: string
            name: string
            type: 'anthropic' | 'openai' | 'google' | 'ollama' | 'custom'
            authType?: 'api-key' | 'google-oauth2'
            credentials?: {
                apiKey?: string
                accessToken?: string
                refreshToken?: string
                expiryDate?: number
            }
            apiKey?: string
            baseUrl?: string
            enabled: boolean
            models: Array<{ id: string; name: string; enabled: boolean }>
        }>
    }) => ipcRenderer.invoke('model-scheme-update', data),
    agentsScan: (forceScan?: boolean) => ipcRenderer.invoke('agents:scan', forceScan),
    agentsCreate: (params: {
        name: string
        description: string
        whenToUse?: string
        systemPrompt: string
        enabled?: boolean
    }) => ipcRenderer.invoke('agents:create', params),
    agentsDelete: (templateId: string) =>
        ipcRenderer.invoke('agents:delete', templateId),
    agentsUpdate: (templateId: string, updates: {
        name?: string
        description?: string
        whenToUse?: string
        enabled?: boolean
        systemPrompt?: string
    }) => ipcRenderer.invoke('agents:update', templateId, updates),
    agentsToggleBatch: (params: {templateIds: string[]; enabled: boolean}) =>
        ipcRenderer.invoke('agents:toggle-batch', params),
    agentTemplateUpdateDescription: (templateId: string, whenToUse: string) =>
        ipcRenderer.invoke('agent-template-update-description', templateId, whenToUse),

    // 系统提示词构建（用于测试）
    systemPromptBuild: () => ipcRenderer.invoke('system-prompt-build'),

    // 工具列表 + MCP 服务器列表（用于测试）
    toolMcpList: () => ipcRenderer.invoke('tool-mcp-list'),

  // Config file read/write (.conf)
  configRead: (name: string) => ipcRenderer.invoke('config-read', name),
  configWrite: (name: string, data: unknown) => ipcRenderer.invoke('config-write', name, data),

  // Session-level model override (model-override-get/set IPC)
  modelOverrideGet: (convId: string) =>
    ipcRenderer.invoke('model-override-get', convId),
  modelOverrideSet: (convId: string, override: import('../shared/types/model').ModelOverride | null) =>
    ipcRenderer.invoke('model-override-set', convId, override),

  // Background image (local picture as app background)
  backgroundPick: () => ipcRenderer.invoke('background-pick'),
  backgroundRemove: (path: string) => ipcRenderer.invoke('background-remove', path),
  backgroundList: () => ipcRenderer.invoke('background-list'),

    // System config directory
    configGetHclawDir: () => ipcRenderer.invoke('config-get-hclaw-dir'),
    configSetHclawDir: (dir: string) => ipcRenderer.invoke('config-set-hclaw-dir', dir),

  // Folder dialog
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  selectFilePath: () => ipcRenderer.invoke('select-file-path'),

  // Directory-level config (agents/skills/logs)
  configDirRead: (dir: string, filename: string) =>
    ipcRenderer.invoke('config-dir-read', dir, filename),
  configDirWrite: (dir: string, filename: string, data: unknown) =>
    ipcRenderer.invoke('config-dir-write', dir, filename, data),
  configDirList: (dir: string) =>
    ipcRenderer.invoke('config-dir-list', dir),
  configDirDelete: (dir: string, filename: string) =>
    ipcRenderer.invoke('config-dir-delete', dir, filename),

  // Secret encryption (safeStorage)
  secretEncrypt: (plainText: string) =>
    ipcRenderer.invoke('secret-encrypt', plainText),
  secretDecrypt: (cipherText: string) =>
    ipcRenderer.invoke('secret-decrypt', cipherText),

  // Provider 模型拉取 / 测试（主进程执行，绕 CORS）
  providerFetchModels: (params: any) => ipcRenderer.invoke('provider:fetch-models', params),
  providerTestModel: (params: any) => ipcRenderer.invoke('provider:test-model', params),
  modelMetaGetWindow: (model: string) =>
    ipcRenderer.invoke('model-meta:get-window', {model}),
  modelMetaLookup: (model: string) =>
    ipcRenderer.invoke('model-meta:lookup', {model}),
  exchangeRateGet: () =>
    ipcRenderer.invoke('exchange-rate:get'),
  // 汇率手动刷新
  exchangeRateRefresh: () =>
    ipcRenderer.invoke('exchange-rate:refresh'),
  // 模型价目表手动刷新
  modelMetaRefresh: () =>
    ipcRenderer.invoke('model-meta:refresh'),

  // Conversation management
  conversationCreate: (convId: string, meta: Record<string, unknown>) =>
    ipcRenderer.invoke('conversation-create', convId, meta),
  conversationReadMeta: (convId: string) =>
    ipcRenderer.invoke('conversation-read-meta', convId),
  conversationReadMessages: (convId: string) =>
    ipcRenderer.invoke('conversation-read-messages', convId),
    conversationReadTail: (convId: string, count: number) =>
        ipcRenderer.invoke('conversation-read-tail', convId, count),
    conversationReadBefore: (convId: string, beforeTimestamp: number, count: number) =>
        ipcRenderer.invoke('conversation-read-before', convId, beforeTimestamp, count),
  conversationWriteMessages: (convId: string, messages: unknown[]) =>
    ipcRenderer.invoke('conversation-write-messages', convId, messages),
  conversationWriteMessagesDelta: (convId: string, message: unknown) =>
    ipcRenderer.invoke('conversation-write-messages-delta', convId, message),
  conversationWriteBlockDelta: (convId: string, msgId: string, patch: unknown) =>
    ipcRenderer.invoke('conversation-write-block-delta', convId, msgId, patch),
  conversationUpdateMeta: (convId: string, updates: Record<string, unknown>) =>
    ipcRenderer.invoke('conversation-update-meta', convId, updates),
  conversationDelete: (convId: string) =>
    ipcRenderer.invoke('conversation-delete', convId),
  conversationDeleteMessage: (convId: string, messageId: string) => {
    return ipcRenderer.invoke('conversation-delete-message', convId, messageId)
  },
  conversationList: () =>
    ipcRenderer.invoke('conversation-list'),
    conversationListWithStats: (workspacePath: string) =>
        ipcRenderer.invoke('conversation-list-with-stats', workspacePath),
    conversationListByWorkspace: (workspacePath: string) =>
        ipcRenderer.invoke('conversation-list-by-workspace', workspacePath),
    conversationDeleteBatch: (ids: string[]) =>
        ipcRenderer.invoke('conversation-delete-batch', ids),
    conversationUsageStats: (convId: string) =>
        ipcRenderer.invoke('conversation-usage-stats', convId),
  conversationSetMessageEnded: (convId: string, messageId: string, endedAt: number) =>
    ipcRenderer.invoke('conversation-set-message-ended', convId, messageId, endedAt),
    // 监听主进程推送的新建会话（渠道创建等）
    onConversationCreated: (callback: (conv: any) => void) => {
        const handler = (_: unknown, conv: any) => callback(conv)
        ipcRenderer.on('conversation-created', handler)
        return () => ipcRenderer.removeListener('conversation-created', handler)
    },

    // 监听主进程推送的会话更新（如渠道消息更新 preview）
    onConversationUpdated: (callback: (data: { id: string; preview: string; updatedAt: number }) => void) => {
        const handler = (_: unknown, data: any) => callback(data)
        ipcRenderer.on('conversation-updated', handler)
        return () => ipcRenderer.removeListener('conversation-updated', handler)
    },

    // 监听主进程推送的会话删除（任意窗口删除后其他窗口同步移除侧栏条目）
    onConversationDeleted: (callback: (data: { ids: string[] }) => void) => {
        const handler = (_: unknown, data: any) => callback(data)
        ipcRenderer.on('conversation-deleted', handler)
        return () => ipcRenderer.removeListener('conversation-deleted', handler)
    },

  // Message LLM stats update
  message: {
    updateLlmStats: (params: {
      conversationId: string
      messageId: string
      llmStats: Array<{
        inputTokens: number
        outputTokens: number
        provider: string
        model: string
        duration: number
      }>
    }) => ipcRenderer.invoke('message:updateLlmStats', params),
  },

  // Block operations (incremental write)
  blocksWrite: (convId: string, block: unknown) =>
    ipcRenderer.invoke('blocks-write', convId, block),
  blocksUpdate: (blockId: string, updates: unknown) =>
    ipcRenderer.invoke('blocks-update', blockId, updates),
  blocksReadByMessage: (messageId: string) =>
    ipcRenderer.invoke('blocks-read-by-message', messageId),

  // File operations
    saveTempFile: (data: { buffer: number[], name: string }) =>
        ipcRenderer.invoke('save-temp-file', data),
    saveDroppedFile: (data: { sourcePath: string, name: string }) =>
        ipcRenderer.invoke('save-dropped-file', data),
    // 通过 webUtils 获取拖拽文件的完整路径（sandbox 模式下 file.path 不可用）
    getDroppedFilePath: (file: File) => webUtils.getPathForFile(file),
    clipboardWriteImage: (data: { buffer: number[] }) =>
        ipcRenderer.invoke('clipboard-write-image', data),
  openPath: (filePath: string) =>
      ipcRenderer.invoke('open-path', filePath),

    // 工作目录文件浏览
    workspaceReadDir: (dirPath: string) =>
        ipcRenderer.invoke('workspace-read-dir', dirPath),

  // 读取文件并返回 data URL（用于图片预览）
    readFileAsDataUrl: (filePath: string) =>
        ipcRenderer.invoke('read-file-as-data-url', filePath),

    // 读取文件原始 Buffer（用于音频播放，无 base64 开销）
    readFileBuffer: (filePath: string) =>
        ipcRenderer.invoke('read-file-buffer', filePath),

  showItemInFolder: (filePath: string) =>
      ipcRenderer.invoke('show-item-in-folder', filePath),

  openBuiltin: (url: string) =>
      ipcRenderer.invoke('open-builtin', url),

  openSystem: (url: string) =>
      ipcRenderer.invoke('open-system', url),

  openExternal: (url: string) =>
      ipcRenderer.invoke('open-external', url),

    // 语音转文字（前端录音按钮使用）
    speechToTextConvert: (audioPath: string) =>
        ipcRenderer.invoke('speech-to-text-convert', audioPath),

  // Flush save on app quit
  onFlushSave: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('flush-save', handler)
    return () => ipcRenderer.removeListener('flush-save', handler)
  },

    // MCP (Model Context Protocol) management
    mcp: {
        list: () => ipcRenderer.invoke('mcp:list'),
        saveServer: (server: any) => ipcRenderer.invoke('mcp:save-server', server),
        delete: (id: string) => ipcRenderer.invoke('mcp:delete', id),
        setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('mcp:set-enabled', id, enabled),
        testConnection: (config: any) => ipcRenderer.invoke('mcp:test-connection', config),
        startServer: (config: any) => ipcRenderer.invoke('mcp:start-server', config),
        stopServer: (serverId: string) => ipcRenderer.invoke('mcp:stop-server', serverId),
        restartServer: (serverId: string) => ipcRenderer.invoke('mcp:restart-server', serverId),
        getAllStatus: () => ipcRenderer.invoke('mcp:get-all-status'),
        removeServer: (id: string) => ipcRenderer.invoke('mcp:remove-server', id),
        importConfig: (filePath: string) => ipcRenderer.invoke('mcp:import-config', filePath),
        // 新增：状态变化事件监听
        onStatusChanged: (callback: (payload: {
          serverId: string
          status: string
          error?: string
          tools?: unknown[]
        }) => void) => {
            const handler = (_: unknown, payload: any) => {
                callback(payload)
            }
          ipcRenderer.on('mcp:status-changed', handler)
          return () => ipcRenderer.removeListener('mcp:status-changed', handler)
        },
        // 列表变化事件监听（外部修改 mcp.json 时触发）
        onListChanged: (callback: () => void) => {
            const handler = () => {
                callback()
            }
            ipcRenderer.on('mcp:list-changed', handler)
            return () => ipcRenderer.removeListener('mcp:list-changed', handler)
        },
    },

    // 调度任务管理
    scheduler: {
        list: () => ipcRenderer.invoke('scheduler-list'),
        create: (data: any) => ipcRenderer.invoke('scheduler-create', data),
        update: (id: string, updates: any) => ipcRenderer.invoke('scheduler-update', {id, ...updates}),
        delete: (id: string) => ipcRenderer.invoke('scheduler-delete', id),
        del: (id: string) => ipcRenderer.invoke('scheduler-delete', id),
        stop: (scheduleId: string) => ipcRenderer.invoke('scheduler-stop', scheduleId),
        runNow: (id: string) => ipcRenderer.invoke('scheduler-run-now', id),
        getConversations: (scheduleId: string) => ipcRenderer.invoke('scheduler-get-conversations', scheduleId),
        conversationDetail: (convId: string) => ipcRenderer.invoke('scheduler-conversation-detail', convId),
        scriptLogs: (scheduleId: string) => ipcRenderer.invoke('scheduler-script-logs', scheduleId),
        readScriptLog: (logPath: string) => ipcRenderer.invoke('scheduler-read-script-log', logPath),
        // 定时任务变更事件监听（工具/后端修改时通知前端刷新）
        onChanged: (callback: () => void) => {
            const handler = () => {
                callback()
            }
            ipcRenderer.on('schedules-changed', handler)
            return () => ipcRenderer.removeListener('schedules-changed', handler)
        },
    },

    // 渠道管理
    channel: {
        list: () => ipcRenderer.invoke('channel-list'),
        create: (data: {
            type: string;
            name: string;
            config: Record<string, unknown>
        }) => ipcRenderer.invoke('channel-create', data),
        update: (id: string, updates: any) => ipcRenderer.invoke('channel-update', id, updates),
        delete: (id: string) => ipcRenderer.invoke('channel-delete', id),
        login: (id: string) => ipcRenderer.invoke('channel-login', id),
        // 微信扫码登录流程
        startWechatLogin: () => ipcRenderer.invoke('channel-start-wechat-login'),
        checkWechatLogin: (sessionKey: string) => ipcRenderer.invoke('channel-check-wechat-login', sessionKey),
        cancelWechatLogin: (sessionKey: string) => ipcRenderer.invoke('channel-cancel-wechat-login', sessionKey),
        // 消息长轮询
        startWorker: (channelId: string) => ipcRenderer.invoke('channel-start-worker', channelId),
        stopWorker: () => ipcRenderer.invoke('channel-stop-worker'),
        // 渠道状态变更推送（Worker → Main → Renderer）
        onStatusChanged: (callback: (data: { channelId: string; status: string; statusMessage: string }) => void) => {
            const handler = (_: unknown, data: any) => callback(data)
            ipcRenderer.on('channel-status-changed', handler)
            return () => ipcRenderer.removeListener('channel-status-changed', handler)
        },
    },

    // 工具管理
    tool: {
        list: () => ipcRenderer.invoke('tool:list'),
        setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('tool:setEnabled', id, enabled),
        setEnabledBatch: (updates: Array<{id: string; enabled: boolean}>) => 
            ipcRenderer.invoke('tool:setEnabledBatch', updates),
        getTimeout: (id: string) => ipcRenderer.invoke('tool:getTimeout', id),
        setTimeout: (id: string, timeout: number | null) => 
            ipcRenderer.invoke('tool:setTimeout', id, timeout),
    },

    // LLM 调用轨迹（llm-trace:*，Task 5 IPC；取代旧 llm-call-logs 管线）
    openLlmLogsWindow: () => ipcRenderer.invoke('open-llm-logs-window'),
    getLlmTraceProjection: (convIds?: string[]) => ipcRenderer.invoke('llm-trace:get-projection', convIds),
    getLlmTraceFile: (convId: string, file: string) => ipcRenderer.invoke('llm-trace:get-file', convId, file),
    listLlmTraceConversations: () => ipcRenderer.invoke('llm-trace:list-conversations'),
    toggleLlmTrace: (enabled: boolean) => ipcRenderer.invoke('llm-trace:toggle', enabled),
    clearLlmTrace: () => ipcRenderer.invoke('llm-trace:clear'),
    onLlmTraceRecord: (cb: (r: any) => void) => {
        const h = (_e: unknown, r: any) => cb(r)
        ipcRenderer.on('llm-trace-record', h)
        return () => ipcRenderer.removeListener('llm-trace-record', h)
    },
    onLlmTraceEvent: (cb: (e: {type: 'paused'; reason: string}) => void) => {
        const h = (_e: unknown, ev: any) => cb(ev)
        ipcRenderer.on('llm-trace-event', h)
        return () => ipcRenderer.removeListener('llm-trace-event', h)
    },

    // 全局用量统计窗口
    openUsageStatsWindow: () => ipcRenderer.invoke('open-usage-stats-window'),
    usageStatsQuery: (params: import('@shared/types').UsageStatsQueryParams) =>
        ipcRenderer.invoke('usage-stats:query', params),
    windowId,
    dialogType,
    /** 任务历史窗口限定的会话 id（--hclaw-task-conv；仅 task-history-conv 有，其余为空串） */
    taskConvId,
    openConfigWindow: (type: string, extraArgs?: string[]) =>
        ipcRenderer.invoke('open-config-window', type, extraArgs),
    // 通用独立窗口控制（仅独立窗口注入：主窗口无 --hclaw-window-id）
    ...(windowId
        ? {
              windowControls: {
                  minimize: () => ipcRenderer.invoke(`${windowId}:minimize`),
                  maximize: () => ipcRenderer.invoke(`${windowId}:maximize`),
                  close: () => ipcRenderer.invoke(`${windowId}:close`),
                  isMaximized: () => ipcRenderer.invoke(`${windowId}:is-maximized`),
                  onMaximizedChange: (callback: (isMaximized: boolean) => void) => {
                      const handler = (_: unknown, v: boolean) => callback(v)
                      ipcRenderer.on(`${windowId}-maximized-changed`, handler)
                      return () => ipcRenderer.removeListener(`${windowId}-maximized-changed`, handler)
                  },
              },
          }
        : {}),

    // Permission rules management
    agentGetPermissionRules: () => ipcRenderer.invoke('agent-get-permission-rules'),
    agentCleanPermissionRules: () => ipcRenderer.invoke('agent-clean-permission-rules'),
    agentAddPermissionRule: (rule: any) => ipcRenderer.invoke('agent-add-permission-rule', rule),
    agentRemovePermissionRule: (toolName: string) => ipcRenderer.invoke('agent-remove-permission-rule', toolName),
    agentSetPermissionMode: (mode: string) => ipcRenderer.invoke('agent-set-permission-mode', mode),
    agentSetConvPermissionMode: (convId: string, mode: 'safe' | 'auto') =>
        ipcRenderer.invoke('agent-set-conv-permission-mode', convId, mode),
    agentGetPermissionMode: () => ipcRenderer.invoke('agent-get-permission-mode'),

    // Skills management
    skillsRefresh: (forceRefresh?: boolean) => ipcRenderer.invoke('skills-refresh', forceRefresh),
    skillInstall: (zipPath: string) => ipcRenderer.invoke('skill-install', zipPath),
    openSkillFileDialog: () => ipcRenderer.invoke('open-skill-file-dialog'),
    skillAdd: (params: {
        name: string;
        description: string;
        content: string;
        version?: string;
        enabled?: boolean;
        allowedTools?: string[]
    }) =>
        ipcRenderer.invoke('skill-add', params),
    skillRemove: (skillId: string) => ipcRenderer.invoke('skill-remove', skillId),
    skillToggle: (skillId: string) => ipcRenderer.invoke('skill-toggle', skillId),
    skillToggleBatch: (params: {skillIds: string[]; enabled: boolean}) =>
        ipcRenderer.invoke('skill-toggle-batch', params),
    skillUpdateDescription: (skillId: string, userDescription: string) =>
        ipcRenderer.invoke('skill-update-description', skillId, userDescription),
    updateSkillContent: (params: {skillId: string; name?: string; description?: string; body?: string}) =>
        ipcRenderer.invoke('skill-update-content', params),

    // System settings management
    settingsUpdate: (settings: import('../shared/types').SystemSettings) =>
        ipcRenderer.invoke('settings-update', settings),

    // Window theme management
    setWindowTheme: (theme: string) =>
        ipcRenderer.invoke('set-window-theme', theme),
    onThemeChanged: (callback: (theme: string) => void) => {
        const handler = (_e: unknown, theme: string) => callback(theme)
        ipcRenderer.on('theme-changed', handler)
        return () => { ipcRenderer.removeListener('theme-changed', handler) }
    },

    // 系统设置变更推送（其他窗口改了 settings → 本窗口需重新 hydration，
    // 如背景图/遮罩/模糊等 ui.background 变更后主窗口刷新 settingsStore）
    onSettingsChanged: (callback: (settings: any) => void) => {
        const handler = (_e: unknown, settings: any) => callback(settings)
        ipcRenderer.on('settings-changed', handler)
        return () => { ipcRenderer.removeListener('settings-changed', handler) }
    },

    // Google OAuth2 认证
    authGoogleLogin: () => ipcRenderer.invoke('auth-google-login'),
    onGoogleAuthSuccess: (callback: (tokens: any) => void) => {
        const handler = (_: unknown, tokens: any) => callback(tokens)
        ipcRenderer.on('google-auth-success', handler)
        return () => ipcRenderer.removeListener('google-auth-success', handler)
    },
    onGoogleAuthError: (callback: (info: {error: string}) => void) => {
        const handler = (_: unknown, info: {error: string}) => callback(info)
        ipcRenderer.on('google-auth-error', handler)
        return () => ipcRenderer.removeListener('google-auth-error', handler)
    },

    // 通用 IPC 接口 (为了兼容性和灵活性)
    invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
    receive: (channel: string, callback: (...args: any[]) => void) => {
        const handler = (_: unknown, ...args: any[]) => callback(...args)
        ipcRenderer.on(channel, handler)
        return () => ipcRenderer.removeListener(channel, handler)
    },

    platform: process.platform,

    // Command palette
    commandPrepareMessage: (commandId: string, args?: string) =>
        ipcRenderer.invoke('command:prepare-message', commandId, args),
    commandResolveByName: (name: string, args?: string) =>
        ipcRenderer.invoke('command:resolve-by-name', name, args),

    // User-defined commands management
    command: {
        getSkillCommands: () => ipcRenderer.invoke('command:get-skill-commands'),
        getAgentCommands: () => ipcRenderer.invoke('command:get-agent-commands'),
        getAll: () => ipcRenderer.invoke('command:get-all'),
        getUserCommands: () => ipcRenderer.invoke('command:get-user-commands'),
        create: (input: any) => ipcRenderer.invoke('command:create', input),
        update: (id: string, updates: any) => ipcRenderer.invoke('command:update', id, updates),
        delete: (id: string) => ipcRenderer.invoke('command:delete', id),
        toggle: (id: string, enabled: boolean) => ipcRenderer.invoke('command:toggle', id, enabled),
        import: (commands: any[]) => ipcRenderer.invoke('command:import', commands),
        export: () => ipcRenderer.invoke('command:export'),
        getDefaultTemplate: (name: string) => ipcRenderer.invoke('command:get-default-template', name),
        resetPresets: () => ipcRenderer.invoke('command:reset-presets'),
    },

    // Command overrides (enabled/disabled state management)
    commandOverride: {
        setEnabled: (commandId: string, enabled: boolean) =>
            ipcRenderer.invoke('command:toggle', commandId, enabled),
        getAll: () => ipcRenderer.invoke('command-override:get-all'),
    },

    // Plugin API
    plugin: {
        getCommands: () => ipcRenderer.invoke('plugin:get-commands'),
        install: (sourceUrl: string) => ipcRenderer.invoke('plugin:install', sourceUrl),
        uninstall: (name: string) => ipcRenderer.invoke('plugin:uninstall', name),
        enable: (name: string) => ipcRenderer.invoke('plugin:enable', name),
        disable: (name: string) => ipcRenderer.invoke('plugin:disable', name),
        list: (enabledOnly?: boolean) => ipcRenderer.invoke('plugin:list', enabledOnly),
        reload: () => ipcRenderer.invoke('plugin:reload'),
        update: (name: string, options?: { force?: boolean }) => ipcRenderer.invoke('plugin:update', name, options),
        reset: (name: string) => ipcRenderer.invoke('plugin:reset', name),
        getRealCounts: () => ipcRenderer.invoke('plugin:get-real-counts'),
        getCapabilityDetails: (pluginName: string) => ipcRenderer.invoke('plugin:get-capability-details', pluginName),
        syncVersions: (name: string) => ipcRenderer.invoke('plugin:sync-versions', name),
        getVersions: (name: string) => ipcRenderer.invoke('plugin:get-versions', name),
        switchVersion: (name: string, ref: string) => ipcRenderer.invoke('plugin:switch-version', name, ref),
        getAllVersionMeta: () => ipcRenderer.invoke('plugin:get-all-version-meta'),
        onPluginStatusUpdate: (callback: (data: any) => void) => {
            const handler = (_: unknown, data: any) => callback(data)
            ipcRenderer.on('plugin:status-update', handler)
            return () => ipcRenderer.removeListener('plugin:status-update', handler)
        },
    },

    // Plugin command overrides
    pluginCommand: {
        getOverrides: () => ipcRenderer.invoke('plugin-command:get-overrides'),
        upsertOverride: (input: any) => ipcRenderer.invoke('plugin-command:upsert-override', input),
        deleteOverride: (pluginCommandId: string) => ipcRenderer.invoke('plugin-command:delete-override', pluginCommandId),
    },

    // Provider (LLM 服务商) 管理
    provider: {
        list: () => ipcRenderer.invoke('provider:list'),
        get: (id: string) => ipcRenderer.invoke('provider:get', id),
        listWithModels: () => ipcRenderer.invoke('provider:list-with-models'),
        save: (provider: any) => ipcRenderer.invoke('provider:save', provider),
        saveAll: (providers: any[]) => ipcRenderer.invoke('provider:save-all', providers),
        delete: (id: string) => ipcRenderer.invoke('provider:delete', id),
        setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('provider:set-enabled', id, enabled),
    },

    // Provider Model (服务商模型) 管理
    providerModel: {
        list: () => ipcRenderer.invoke('provider-model:list'),
        listByProvider: (providerId: string) => ipcRenderer.invoke('provider-model:list-by-provider', providerId),
        save: (model: any) => ipcRenderer.invoke('provider-model:save', model),
        saveByProvider: (providerId: string, models: any[]) =>
            ipcRenderer.invoke('provider-model:save-by-provider', providerId, models),
        delete: (id: string) => ipcRenderer.invoke('provider-model:delete', id),
        deleteByProvider: (providerId: string) => ipcRenderer.invoke('provider-model:delete-by-provider', providerId),
        setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('provider-model:set-enabled', id, enabled),
    },

    // Model Scheme 管理
    modelScheme: {
        list: () => ipcRenderer.invoke('model-scheme:list'),
        get: (id: string) => ipcRenderer.invoke('model-scheme:get', id),
        save: (scheme: any) => ipcRenderer.invoke('model-scheme:save', scheme),
        delete: (id: string) => ipcRenderer.invoke('model-scheme:delete', id),
        setActive: (schemeId: string) => ipcRenderer.invoke('model-scheme:set-active', schemeId),
        getActiveId: () => ipcRenderer.invoke('model-scheme:get-active-id'),
    },

    // Prompt Scheme 管理
    promptScheme: {
        list: () => ipcRenderer.invoke('prompt-scheme:list'),
        get: (id: string) => ipcRenderer.invoke('prompt-scheme:get', id),
        save: (scheme: any) => ipcRenderer.invoke('prompt-scheme:save', scheme),
        delete: (id: string) => ipcRenderer.invoke('prompt-scheme:delete', id),
        getActiveId: () => ipcRenderer.invoke('prompt-scheme:get-active-id'),
    },

    // 激活提示词方案（同步主进程 PromptResolver）
    updatePromptScheme: (schemeId: string | null) => ipcRenderer.invoke('update-prompt-scheme', schemeId),

    // 系统提示词预览构建
    systemPromptBuildWithScheme: (nodes: Record<string, string>) => ipcRenderer.invoke('system-prompt-build-with-scheme', nodes),

    // Workspace 管理
    workspace: {
        list: () => ipcRenderer.invoke('workspace:list'),
        get: (id: string) => ipcRenderer.invoke('workspace:get', id),
        getByPath: (workspacePath: string) => ipcRenderer.invoke('workspace:getByPath', workspacePath),
        create: (id: string, workspacePath: string, name: string) =>
            ipcRenderer.invoke('workspace:create', id, workspacePath, name),
        update: (id: string, updates: { path?: string; name?: string }) =>
            ipcRenderer.invoke('workspace:update', id, updates),
        delete: (id: string) => ipcRenderer.invoke('workspace:delete', id),
        getCurrent: () => ipcRenderer.invoke('workspace:getCurrent'),
        setCurrent: (id: string) => ipcRenderer.invoke('workspace:setCurrent', id),
    },

    // CapabilityHub — 统一能力中心查询 API
    capability: {
        query: (filter?: any) => ipcRenderer.invoke('capability:query', filter),
        getByType: (type: string) => ipcRenderer.invoke('capability:get-by-type', type),
        search: (q: string) => ipcRenderer.invoke('capability:search', q),
        getPluginGroups: (type?: string) => ipcRenderer.invoke('capability:plugin-groups', type),
        getStats: () => ipcRenderer.invoke('capability:stats'),
        get: (id: string) => ipcRenderer.invoke('capability:get', id),
    },

    // 任务批次（历史任务组窗口数据源）
    taskBatches: {
        getActive: (conversationId: string) => ipcRenderer.invoke('task-batches:get-active', conversationId),
        list: (opts?: {filter?: string; conversationId?: string; workspaceId?: string}) =>
            ipcRenderer.invoke('task-batches:list', opts),
        getTasks: (batchId: string) => ipcRenderer.invoke('task-batches:get-tasks', batchId),
        remove: (ids: string[]) => ipcRenderer.invoke('task-batches:delete', ids),
    },

    // 任务批次删除跨窗口广播（主窗口据此刷新 TodoStrip 残留批次态）
    onTaskBatchesChanged: (callback: (payload: {conversationIds: string[]}) => void) => {
        const handler = (_: unknown, payload: unknown) => callback(payload as {conversationIds: string[]})
        ipcRenderer.on('task-batches-changed', handler)
        return () => ipcRenderer.removeListener('task-batches-changed', handler)
    },

},)


