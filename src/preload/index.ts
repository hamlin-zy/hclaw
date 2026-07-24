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
  agentInjectMessage: (params: { conversationId: string; content: string; messageId?: string }) =>
    ipcRenderer.invoke('agent-inject-message', params),
  agentStatus: (conversationId?: string) =>
    ipcRenderer.invoke('agent-status', conversationId),
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

    // System config directory
    configGetHclawDir: () => ipcRenderer.invoke('config-get-hclaw-dir'),
    configSetHclawDir: (dir: string) => ipcRenderer.invoke('config-set-hclaw-dir', dir),

  // Folder dialog
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  selectFilePath: () => ipcRenderer.invoke('select-file-path'),

  // Directory-level config (agents/skill/hooks)
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

    // LLM call logs
    getLlmCallLogs: () => ipcRenderer.invoke('llm-call-logs:get'),
    clearLlmCallLogs: () => ipcRenderer.invoke('llm-call-logs:clear'),
    openLlmLogsWindow: () => ipcRenderer.invoke('open-llm-logs-window'),
    onLlmCallLog: (callback: (log: any) => void) => {
        const handler = (_: unknown, log: any) => callback(log)
        ipcRenderer.on('llm-call-log', handler)
        return () => ipcRenderer.removeListener('llm-call-log', handler)
    },
    getLlmLogEnabled: () => ipcRenderer.invoke('llm-log:enabled'),
    toggleLlmLog: (enabled: boolean) => ipcRenderer.invoke('llm-log:toggle', enabled),

    // Permission rules management
    agentGetPermissionRules: () => ipcRenderer.invoke('agent-get-permission-rules'),
    agentCleanPermissionRules: () => ipcRenderer.invoke('agent-clean-permission-rules'),
    agentAddPermissionRule: (rule: any) => ipcRenderer.invoke('agent-add-permission-rule', rule),
    agentRemovePermissionRule: (toolName: string) => ipcRenderer.invoke('agent-remove-permission-rule', toolName),
    agentSetPermissionMode: (mode: string) => ipcRenderer.invoke('agent-set-permission-mode', mode),
    agentGetWorkMode: () => ipcRenderer.invoke('agent-get-work-mode'),
    agentSetWorkMode: (mode: string) => ipcRenderer.invoke('agent-set-work-mode', mode),

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
    setWindowTheme: (theme: 'light' | 'dark') =>
        ipcRenderer.invoke('set-window-theme', theme),

    // Google OAuth2 认证
    authGoogleLogin: () => ipcRenderer.invoke('auth-google-login'),
    onGoogleAuthSuccess: (callback: (tokens: any) => void) => {
        const handler = (_: unknown, tokens: any) => callback(tokens)
        ipcRenderer.on('google-auth-success', handler)
        return () => ipcRenderer.removeListener('google-auth-success', handler)
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
    },

    // Plugin command overrides
    pluginCommand: {
        getOverrides: () => ipcRenderer.invoke('plugin-command:get-overrides'),
        upsertOverride: (input: any) => ipcRenderer.invoke('plugin-command:upsert-override', input),
        deleteOverride: (pluginCommandId: string) => ipcRenderer.invoke('plugin-command:delete-override', pluginCommandId),
    },

    // Hooks API
    hooks: {
        list: () => ipcRenderer.invoke('hooks:list'),
        get: (id: string) => ipcRenderer.invoke('hooks:get', id),
        save: (hook: any) => ipcRenderer.invoke('hooks:save', hook),
        delete: (id: string) => ipcRenderer.invoke('hooks:delete', id),
        setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('hooks:set-enabled', id, enabled),
        getEventDefinitions: () => ipcRenderer.invoke('hooks:get-event-definitions'),
        getPluginDefaults: (pluginName: string, hookId: string) => ipcRenderer.invoke('hooks:get-plugin-defaults', pluginName, hookId),
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

},)


