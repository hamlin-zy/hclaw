export {}

declare global {
  interface Window {
    electronAPI?: {
        // 初始主题（窗口创建前从 SQLite 读取，用于首次渲染前设置正确主题）
        initialTheme?: string
        // Windows 11 标识（用于 CSS 条件圆角，同步传递无需 IPC 往返）
        isWin11: boolean
        // macOS 标识（用于 TitleBar 左侧为交通灯按钮预留间距）
        isDarwin: boolean

      // Window control
      getAppVersion: () => Promise<string>

      // Updater
      updaterGetStatus: () => Promise<import('../shared/types/updater').UpdateResult | null>
      updaterCheckForUpdate: () => Promise<import('../shared/types/updater').UpdateResult>
      onUpdaterStatusChanged: (callback: (result: import('../shared/types/updater').UpdateResult) => void) => () => void
      // 模型方案变更推送（其他窗口改了 model-schemes → 本窗口需重新 hydration）
      onModelSchemesChanged: (callback: () => void) => () => void
      // 模型配置（providers/models）变更推送
      onLlmConfigChanged: (callback: () => void) => () => void
      // 工具列表变更推送
      onToolsChanged: (callback: () => void) => () => void
      // 提示词方案变更推送
      onPromptSchemesChanged: (callback: () => void) => () => void
      minimizeWindow: () => Promise<void>
      maximizeWindow: () => Promise<void>
      closeWindow: () => Promise<void>
      isMaximized: () => Promise<boolean>
      onWindowMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void
        setWindowTheme: (theme: string) => Promise<void>
        onThemeChanged: (callback: (theme: string) => void) => () => void
        // 系统设置变更推送（其他窗口改了 settings → 本窗口需重新 hydration）
        onSettingsChanged: (callback: (settings: any) => void) => () => void
        platform: string

        // Command palette
        commandPrepareMessage: (commandId: string, args?: string) => Promise<string>

      // Agent messaging (legacy)
      onAgentMessage: (callback: (message: unknown) => void) => () => void
      sendAgentCommand: (command: string) => void

      // Agent stream (流式事件监听)
      onAgentStream: (callback: (payload: {
        conversationId: string
        event: {
          type: string
          content?: string
          toolCall?: { id: string; name: string; arguments: Record<string, unknown> }
          toolCallId?: string
          progress?: string
          result?: { success: boolean; output: unknown; error?: string }
          reason?: string
          error?: string
          question?: string
            options?: string[]
            multiSelect?: boolean
          taskId?: string
          description?: string
        }
      }) => void) => () => void

      // Agent control
      agentStart: (params: {
        conversationId: string
          /** 新消息内容 */
        message: string
          /** 消息附件（文件路径列表） */
          messageAttachments?: Array<{ path: string; name: string }>
          /** 消息元数据（如命令模板等） */
          messageMetadata?: Record<string, unknown>
      }) => Promise<{ success: boolean; error?: string }>
      agentAbort: (conversationId: string) => Promise<{ success: boolean }>
      agentRegisterStreamingMessage: (conversationId: string, messageId: string) => Promise<boolean>
      agentInjectMessage: (params: { conversationId: string; content: string; messageId?: string }) => Promise<{ success: boolean }>
      agentStatus: (conversationId?: string) => Promise<{
        running: boolean
        allRunning: string[]
      }>
      agentStreamSnapshot: (conversationId: string) =>
        Promise<import('./stores/agentStore/helpers/recoverySeeding').StreamSnapshot | null>
        contextGetUsage: (conversationId: string) => Promise<{
          ratio: number
          windowTokens: number
          estimatedTokens: number
        }>
        agentSetPermissionMode: (mode: 'safe' | 'auto') => Promise<boolean>
        agentSetConvPermissionMode: (convId: string, mode: 'safe' | 'auto') => Promise<{ success: boolean; error?: string }>
        agentGetPermissionMode: () => Promise<'safe' | 'auto'>
        agentGetPermissionRules: () => Promise<any[]>
        agentCleanPermissionRules: () => Promise<{ success: boolean }>
        agentRemovePermissionRule: (toolName: string) => Promise<boolean>
        agentAddPermissionRule: (rule: { tool: string; action: string }) => Promise<{ success: boolean }>
        agentRespondConfirmation: (params: {
            conversationId: string
            requestId: string
            result: 'allow' | 'always' | 'deny'
        }) => Promise<{ success: boolean }>
        agentRespondAskUser: (params: {
            conversationId: string
            requestId: string
            answer: string
        }) => Promise<{ success: boolean }>
        saveTempFile: (data: { buffer: number[], name: string }) => Promise<string | null>
        saveDroppedFile: (data: { sourcePath: string, name: string }) => Promise<string | null>
        getDroppedFilePath: (file: File) => string
        clipboardWriteImage: (data: { buffer: number[] }) => Promise<{ success: boolean; error?: string }>
        agentWarmupClients: (data: {
            scheme: import('./types').ModelScheme
            providers: Array<{
                id: string
                name: string
                type: 'anthropic' | 'openai' | 'google' | 'ollama' | 'custom'
                apiKey?: string
                baseUrl?: string
                enabled: boolean
                models: Array<{ id: string; name: string; enabled: boolean }>
            }>
        }) => Promise<{ success: boolean; error?: string }>
        updateModelScheme: (data: {
            schemeId: string
            scheme: import('./types').ModelScheme
            providers: Array<{
                id: string
                name: string
                type: 'anthropic' | 'openai' | 'google' | 'ollama' | 'custom'
                apiKey?: string
                baseUrl?: string
                enabled: boolean
                models: Array<{ id: string; name: string; enabled: boolean }>
            }>
        }) => Promise<{ success: boolean; error?: string }>

        // Session-level model override (model-override-get/set IPC)
        modelOverrideGet: (convId: string) => Promise<{
            success: boolean
            data: {
                override: import('../shared/types/model').ModelOverride | null
            }
        }>
        modelOverrideSet: (convId: string, override: import('../shared/types/model').ModelOverride | null) => Promise<{ success: boolean }>

      // Config file read/write
      configRead: (name: string) => Promise<unknown>
      configWrite: (name: string, data: unknown) => Promise<boolean>

        // System config directory
        configGetHclawDir: () => Promise<string>
        configSetHclawDir: (dir: string) => Promise<string>

      // Folder/file dialogs
      openFolderDialog: () => Promise<string | null>
      selectFilePath: () => Promise<string | null>

        // Background image management
        backgroundPick: () => Promise<{ path: string } | null>
        backgroundList: () => Promise<Array<{ path: string; name: string; size: number; mtime: number }>>
        backgroundRemove: (path: string) => Promise<boolean>

      // Directory-level config (agents/skills/logs)
      configDirRead: (dir: string, filename: string) => Promise<unknown>
      configDirWrite: (dir: string, filename: string, data: unknown) => Promise<boolean>
      configDirList: (dir: string) => Promise<unknown[]>
      configDirDelete: (dir: string, filename: string) => Promise<boolean>

        // Agent template management
        agentsScan: (forceScan?: boolean) => Promise<{
            success: boolean;
            templates?: import('./types').AgentTemplate[];
            loadErrors: Array<{ filePath: string; agentName?: string; error: string; timestamp: number }>
            error?: string
        }>
        agentsCreate: (params: {
            name: string
            description?: string
            whenToUse?: string
            systemPrompt: string
            enabled?: boolean
        }) => Promise<{ success: boolean; error?: string }>
        agentsDelete: (templateId: string) => Promise<{ success: boolean; error?: string }>
        agentsUpdate: (templateId: string, updates: {
            name?: string
            description?: string
            whenToUse?: string
            enabled?: boolean
            systemPrompt?: string
        }) => Promise<{ success: boolean; error?: string }>
        agentsToggleBatch: (params: {templateIds: string[]; enabled: boolean}) => Promise<{
            success: boolean;
            templates?: import('./types').AgentTemplate[];
            error?: string
        }>
        agentTemplateUpdateDescription: (templateId: string, whenToUse: string) => Promise<{
            success: boolean
            templates: any[]
            error?: string
        }>

      // Secret encryption (safeStorage)
      secretEncrypt: (plainText: string) => Promise<string | null>
      secretDecrypt: (cipherText: string) => Promise<string | null>

      // Conversation management
      conversationCreate: (convId: string, meta: Record<string, unknown>) => Promise<boolean>
      conversationReadMeta: (convId: string) => Promise<Record<string, unknown> | null>
      conversationReadMessages: (convId: string) => Promise<unknown[]>
        conversationReadTail: (convId: string, count: number) => Promise<{ messages: unknown[]; totalCount: number }>
        conversationReadBefore: (convId: string, beforeTimestamp: number, count: number) => Promise<{
            messages: unknown[];
            totalCount: number
        }>
      conversationWriteMessages: (convId: string, messages: unknown[]) => Promise<boolean>
      conversationWriteMessagesDelta: (convId: string, message: unknown) => Promise<boolean>
      conversationWriteBlockDelta: (convId: string, msgId: string, patch: unknown) => Promise<boolean>
      conversationUpdateMeta: (convId: string, updates: Record<string, unknown>) => Promise<boolean>
      conversationDelete: (convId: string) => Promise<boolean>
      conversationDeleteMessage: (convId: string, messageId: string) => Promise<boolean>
      conversationList: () => Promise<Record<string, unknown>[]>
        conversationListWithStats: (workspacePath: string) => Promise<import('./types').ConversationWithStats[]>
        conversationListByWorkspace: (workspacePath: string) => Promise<{id: string}[]>
        conversationDeleteBatch: (ids: string[]) => Promise<boolean>
        conversationUsageStats: (convId: string) => Promise<import('../shared/types/infra').ConversationUsageStats | null>
      conversationSetMessageEnded: (convId: string, messageId: string, endedAt: number) => Promise<boolean>
        // 监听主进程推送的新建会话（渠道创建等）
        onConversationCreated: (callback: (conv: {
            id: string
            title: string
            workspacePath: string
            createdAt: number
            updatedAt: number
            preview: string
            pinned: boolean
            channel?: string
        }) => void) => () => void

        // 监听主进程推送的会话更新（渠道消息更新 preview、定时任务状态更新等）
        onConversationUpdated?: (callback: (data: {
            id: string
            preview?: string
            title?: string
            status?: 'active' | 'running' | 'archived'
            updatedAt?: number
        }) => void) => () => void

      // Block operations (incremental write)
      blocksWrite: (convId: string, block: unknown) => Promise<boolean>
      blocksUpdate: (blockId: string, updates: unknown) => Promise<boolean>
      blocksReadByMessage: (messageId: string) => Promise<unknown[]>

      // Database migration
      migrateDb: () => Promise<{ conversations: number; messages: number; blocks: number; configs: number; rules: number } | null>

      // File operations
      openPath: (filePath: string) => Promise<string>
        workspaceReadDir: (dirPath: string) => Promise<Array<{ name: string; path: string; isDirectory: boolean }>>
      readFileAsDataUrl: (filePath: string) => Promise<string | null>
        readFileBuffer: (filePath: string) => Promise<{ data: Uint8Array; mimeType: string } | null>
      showItemInFolder: (filePath: string) => Promise<{ success: boolean; error?: string }>
      openBuiltin: (url: string) => Promise<{ success: boolean; error?: string }>
      openSystem: (url: string) => Promise<{ success: boolean; error?: string }>
      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>

        // Speech-to-Text (voice recording button)
        speechToTextConvert: (audioPath: string) => Promise<{ success: boolean; text?: string; error?: string }>

      // Flush save on app quit
      onFlushSave: (callback: () => void) => () => void

        // MCP (Model Context Protocol) management
        mcp: {
            list: () => Promise<{ success: boolean; data?: any[]; error?: string }>
            save: (servers: any[]) => Promise<{ success: boolean; error?: string }>
            saveServer: (server: any) => Promise<{ success: boolean; error?: string }>
            delete: (id: string) => Promise<{ success: boolean; error?: string }>
            removeServer: (id: string) => Promise<{ success: boolean; error?: string }>
            setEnabled: (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>
            testConnection: (config: any) => Promise<{ success: boolean; tools?: any[]; error?: string }>
            startServer: (config: any) => Promise<{ success: boolean; toolCount: number; error?: string }>
            stopServer: (serverId: string) => Promise<{ success: boolean; error?: string }>
            restartServer: (serverId: string) => Promise<{ success: boolean; error?: string }>
            getAllStatus: () => Promise<any[]>
            onStatusChanged: (callback: (payload: {
                serverId: string
                status: string
                error?: string
                tools?: unknown[]
            }) => void) => () => void
            onListChanged: (callback: () => void) => () => void
        }

        // 系统提示词构建（用于测试）
        systemPromptBuild: () => Promise<{ success: boolean; systemPrompt?: string; error?: string }>

            // 工具列表 + MCP 服务器列表（用于测试）
        toolMcpList: () => Promise<{
            success: boolean
            tools?: ToolDefinitionForLLM[]
            mcpServers?: Array<{
                serverId: string
                serverName: string
                status: string
                tools: ToolDefinitionForLLM[]
            }>
            error?: string
        }>

        // LLM 调用轨迹（llm-trace:*；取代旧 llm-call-logs 管线）
        openLlmLogsWindow: () => Promise<void>
        getLlmTraceProjection: (convIds?: string[]) => Promise<import('./components/llmTrace/types').LlmTraceProjection>
        getLlmTraceFile: (convId: string, file: string) => Promise<string | null>
        listLlmTraceConversations: () => Promise<string[]>
        toggleLlmTrace: (enabled: boolean) => Promise<boolean>
        clearLlmTrace: () => Promise<boolean>
        onLlmTraceRecord: (callback: (record: import('../shared/types/llmTrace').LlmCallRecord) => void) => () => void
        onLlmTraceEvent: (callback: (ev: {type: 'paused'; reason: string}) => void) => () => void

        // 全局用量统计窗口
        openUsageStatsWindow: () => Promise<void>
        usageStatsQuery: (params: import('../shared/types/infra').UsageStatsQueryParams) => Promise<import('../shared/types/infra').GlobalUsageStats>
        windowId: string
        /** 配置窗口类型（--hclaw-dialog；仅配置窗口有，主窗口为空字符串） */
        dialogType: string
        /** 任务历史窗口限定的会话 id（--hclaw-task-conv；仅 task-history-conv 有，其余为空字符串） */
        taskConvId: string
        /** 打开配置对话框独立窗口（主进程注册表按 dialogType 管理单例；extraArgs 追加为窗口启动参数） */
        openConfigWindow: (dialogType: string, extraArgs?: string[]) => Promise<void>
        /** 独立窗口通用控制（主窗口无 --hclaw-window-id，此值为 undefined） */
        windowControls?: {
            minimize: () => Promise<void>
            maximize: () => Promise<void>
            close: () => Promise<void>
            isMaximized: () => Promise<boolean>
            onMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void
        }

        // Skills management
        skillsRefresh: (forceRefresh?: boolean) => Promise<{
            success: boolean
            count: number
            skills: any[]
            loadErrors: Array<{ skillDir: string; filePath: string; error: string; timestamp: number }>
            error?: string
        }>
        skillInstall: (zipPath: string) => Promise<{
            success: boolean
            skillName?: string
            targetDir?: string
            skills: any[]
            hasSkillMd?: boolean
            error?: string
        }>
        openSkillFileDialog: () => Promise<string | null>
        skillAdd: (params: {
            name: string
            description: string
            content: string
            version?: string
            enabled?: boolean
            allowedTools?: string[]
        }) => Promise<{
            success: boolean
            skillDirName?: string
            skills: any[]
            count: number
            error?: string
        }>
        skillRemove: (skillId: string) => Promise<{
            success: boolean
            skills: any[]
            count: number
            error?: string
        }>
        skillToggle: (skillId: string) => Promise<{
            success: boolean
            enabled: boolean
            skills: any[]
            count: number
            error?: string
        }>
        skillToggleBatch: (params: {skillIds: string[]; enabled: boolean}) => Promise<{
            success: boolean
            skills: any[]
            error?: string
        }>
        skillUpdateDescription: (skillId: string, userDescription: string) => Promise<{
            success: boolean
            skills: any[]
            count: number
            error?: string
        }>
        skillUpdateContent: (skillId: string, content: string) => Promise<{
            success: boolean
            skills: any[]
            count: number
            error?: string
        }>

        // Plugin API
        plugin: {
            install: (sourceUrl: string) => Promise<{
                success: boolean
                plugin?: LoadedPlugin
                error?: PluginError
            }>
            uninstall: (name: string) => Promise<{ success: boolean; error?: PluginError }>
            enable: (name: string) => Promise<{ success: boolean; error?: string }>
            disable: (name: string) => Promise<{ success: boolean; error?: string }>
            list: (enabledOnly?: boolean) => Promise<LoadedPlugin[]>
            getCommands: () => Promise<Record<string, CommandDef[]>>
            reload: () => Promise<{ success: boolean; error?: string }>
            update: (name: string, options?: { force?: boolean }) => Promise<{
                success: boolean
                updated?: boolean
                forceApplied?: boolean
                dirtyFiles?: string[]
                error?: PluginError
            }>
            reset: (name: string) => Promise<{ success: boolean; error?: PluginError }>
            syncVersions: (name: string) => Promise<{
                success: boolean
                versionInfo?: { tags: string[]; branches: string[]; latest: string; current: string; hasUpdate: boolean }
                error?: string
            }>
            getVersions: (name: string) => Promise<{
                tags: string[]
                branches: string[]
                latest: string
                current: string
                hasUpdate: boolean
            } | null>
            switchVersion: (name: string, ref: string) => Promise<{ success: boolean; error?: string }>
            getAllVersionMeta: () => Promise<Record<string, { current: string; latest: string; hasUpdate: boolean }>>
            onPluginStatusUpdate: (callback: (data: any) => void) => () => void
        }

        // Plugin command override management
        pluginCommand?: {
            getOverrides: () => Promise<Array<{
                id: string
                name: string
                description?: string
                content: string
                args?: Array<{ name: string; description?: string; required?: boolean; default?: string }>
                tags?: string[]
                enabled: boolean
                pluginCommandId: string
            }>>
            upsertOverride: (input: {
                pluginCommandId: string
                name: string
                description?: string
                content?: string
                args?: Array<{ name: string; description?: string; required?: boolean; default?: string }>
                enabled: boolean
                tags?: string[]
            }) => Promise<{ success: boolean; error?: string }>
            deleteOverride: (pluginCommandId: string) => Promise<{ success: boolean; error?: string }>
        }

        // Provider (LLM 服务商) 管理
        provider: {
            list: () => Promise<{ success: boolean; data?: any[]; error?: string }>
            get: (id: string) => Promise<{ success: boolean; data?: any; error?: string }>
            listWithModels: () => Promise<{ success: boolean; data?: any[]; error?: string }>
            save: (provider: any) => Promise<{ success: boolean; error?: string }>
            saveAll: (providers: any[]) => Promise<{ success: boolean; error?: string }>
            delete: (id: string) => Promise<{ success: boolean; error?: string }>
            setEnabled: (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>
        }

        // Provider Model (服务商模型) 管理
        providerModel: {
            list: () => Promise<{ success: boolean; data?: any[]; error?: string }>
            listByProvider: (providerId: string) => Promise<{ success: boolean; data?: any[]; error?: string }>
            save: (model: any) => Promise<{ success: boolean; error?: string }>
            saveByProvider: (providerId: string, models: any[]) => Promise<{ success: boolean; error?: string }>
            delete: (id: string) => Promise<{ success: boolean; error?: string }>
            deleteByProvider: (providerId: string) => Promise<{ success: boolean; error?: string }>
            setEnabled: (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>
        }

        // Provider 模型拉取 / 测试（主进程执行，绕 CORS；不写库、不产生会话）
        providerFetchModels: (params: any) => Promise<any>
        providerTestModel: (params: any) => Promise<any>
        modelMetaGetWindow: (model: string) => Promise<{contextLength: number}>
        exchangeRateGet: () => Promise<{rate: number; date: string | null}>

        // Model Scheme (模型方案) 管理
        modelScheme: {
            list: () => Promise<{ success: boolean; data?: any[]; error?: string }>
            get: (id: string) => Promise<{ success: boolean; data?: any; error?: string }>
            getActiveId: () => Promise<{ success: boolean; data?: string | null; error?: string }>
            save: (scheme: any) => Promise<{ success: boolean; error?: string }>
            delete: (id: string) => Promise<{ success: boolean; error?: string }>
            setActive: (schemeId: string) => Promise<{ success: boolean; error?: string }>
        }

        // Prompt Scheme (提示词方案) 管理
        promptScheme?: {
            list: () => Promise<{ success: boolean; data?: any[]; error?: string }>
            get: (id: string) => Promise<{ success: boolean; data?: any; error?: string }>
            save: (scheme: any) => Promise<{ success: boolean; error?: string }>
            delete: (id: string) => Promise<{ success: boolean; error?: string }>
            getActiveId: () => Promise<{ success: boolean; data?: string | null; error?: string }>
        }

        // 激活提示词方案（同步主进程 PromptResolver）
        updatePromptScheme?: (schemeId: string | null) => Promise<{ success: boolean; error?: string }>

        // 系统提示词构建（用于预览）
        systemPromptBuildWithScheme?: (nodes: Record<string, string>) => Promise<{
            success: boolean
            systemPrompt?: string
            error?: string
        }>

        // Workspace 管理
        workspace: {
            list: () => Promise<Array<{ id: string; path: string; name: string; createdAt: number; updatedAt: number }>>
            get: (id: string) => Promise<{ id: string; path: string; name: string; createdAt: number; updatedAt: number } | null>
            getByPath: (workspacePath: string) => Promise<{ id: string; path: string; name: string; createdAt: number; updatedAt: number } | null>
            create: (id: string, workspacePath: string, name: string) => Promise<boolean>
            update: (id: string, updates: { path?: string; name?: string }) => Promise<boolean>
            delete: (id: string) => Promise<boolean>
            getCurrent: () => Promise<{ id: string; path: string; name: string; createdAt: number; updatedAt: number } | null>
            setCurrent: (id: string) => Promise<boolean>
        }

        // 任务批次（历史任务组窗口数据源；类型复用主进程 taskBatchRepository）
        taskBatches: {
            getActive: (conversationId: string) => Promise<import('../../main/repositories/sqlite/taskBatchRepository').BatchWithTasks | null>
            list: (opts?: { filter?: string; conversationId?: string; workspaceId?: string }) =>
                Promise<import('../../main/repositories/sqlite/taskBatchRepository').BatchGroup[]>
            getTasks: (batchId: string) =>
                Promise<import('../../main/repositories/sqlite/taskBatchRepository').BatchWithTasks['tasks']>
            remove: (ids: string[]) => Promise<{ deleted: number }>
        }

        /** 任务批次删除跨窗口广播（主窗口据此刷新 TodoStrip 残留批次态） */
        onTaskBatchesChanged: (callback: (payload: {conversationIds: string[]}) => void) => () => void

        // Tool management
        tool?: {
            list: () => Promise<{ success: boolean; data?: ToolState[]; error?: string }>
            setEnabled: (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>
            setEnabledBatch: (updates: Array<{ id: string; enabled: boolean }>) => Promise<{
                success: boolean;
                error?: string
            }>
            getTimeout: (id: string) => Promise<number | null>
            setTimeout: (id: string, timeout: number | null) => Promise<{ success: boolean; error?: string }>
        }

        // Settings management
        settingsUpdate: (settings: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>

        commandResolveByName: (name: string, args?: string) => Promise<{ template: string; commandId: string } | null>

        // User-defined commands CRUD
        command?: {
            getSkillCommands: () => Promise<Array<{ id: string; name: string; description: string }>>
            getAgentCommands: () => Promise<Array<{ id: string; name: string; description: string }>>
            getAll: () => Promise<{
                pluginGroups: Record<string, unknown[]>;
                userCommands: unknown[];
                pluginCommandOverrides: Record<string, { enabled: boolean; edited?: boolean }>;
            }>
            getUserCommands: () => Promise<{ success: boolean; data?: unknown[]; error?: string }>
            create: (input: unknown) => Promise<{ success: boolean; error?: string }>
            update: (id: string, updates: unknown) => Promise<{ success: boolean; error?: string }>
            delete: (id: string) => Promise<{ success: boolean; error?: string }>
            toggle: (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>
            import: (commands: unknown[]) => Promise<{ success: boolean; count?: number; error?: string }>
            export: () => Promise<{ success: boolean; data?: unknown; error?: string }>
            getDefaultTemplate: (name: string) => Promise<{
                content: string;
                description?: string;
                args?: Array<{ name: string; description?: string; required?: boolean; default?: string }>;
            } | null>
            resetPresets: () => Promise<{ success: boolean; error?: string }>
        }

        // Command overrides (enabled/disabled state from DB)
        commandOverride?: {
            setEnabled: (commandId: string, enabled: boolean) => Promise<boolean>
            getAll: () => Promise<Array<{ command_id: string; enabled: boolean; updated_at: number }>>
        }

        // Google OAuth2
        authGoogleLogin: () => Promise<{ success: boolean; error?: string }>
        onGoogleAuthSuccess: (callback: (tokens: {
            accessToken: string;
            refreshToken?: string;
            email?: string
        }) => void) => () => void
        onGoogleAuthError: (callback: (info: {error: string}) => void) => () => void

        // Context compaction
        compact?: {
            request: (conversationId: string) => Promise<{ success: boolean; error?: string }>
            compact: (conversationId: string, customInstructions?: string) => Promise<{
                success: boolean;
                error?: string
            }>
            getWarningState: () => Promise<{ shouldWarn: boolean; lastPromptTime?: number }>
        }

        // Generic IPC (fallback)
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
        receive: (channel: string, callback: (...args: unknown[]) => void) => () => void

        // Scheduler (定时任务)
        scheduler?: {
            list: () => Promise<any[]>
            get: (id: string) => Promise<any>
            create: (data: any) => Promise<{ success: boolean; id?: string }>
            update: (id: string, updates: any) => Promise<{ success: boolean }>
            delete: (id: string) => Promise<{ success: boolean }>
            pause: (id: string) => Promise<void>
            resume: (id: string) => Promise<void>
            stop: (scheduleId: string) => Promise<void>
            runNow: (id: string) => Promise<void>
            getConversations: (scheduleId: string) => Promise<any[]>
            conversationDetail: (convId: string) => Promise<any[]>
            scriptLogs: (scheduleId: string) => Promise<Array<{path: string; fileName: string; startTime: number; size: number}>>
            readScriptLog: (logPath: string) => Promise<string>
            // 定时任务变更事件监听（工具/后端修改时通知前端刷新）
            onChanged: (callback: () => void) => () => void
        }

        // Channel (多渠道)
        channel?: {
            list: () => Promise<any[]>
            saveConfig: (id: string, config: any) => Promise<{success: boolean; error?: string}>
            setEnabled: (id: string, enabled: boolean) => Promise<{success: boolean; error?: string}>
            test: (id: string) => Promise<{success: boolean; error?: string}>
            getStatus: (id: string) => Promise<{status: string; statusMessage: string} | null>
        }

        // CapabilityHub — 统一能力中心查询 API
        capability?: {
            query: (filter?: {
                types?: Array<'skill' | 'agent' | 'command'>
                sources?: Array<'builtin' | 'user' | 'plugin'>
                enabled?: boolean
                pluginName?: string
            }) => Promise<Array<import('./capabilityTypes').CapabilityEntry>>
            getByType: (type: 'skill' | 'agent' | 'command') => Promise<Array<import('./capabilityTypes').CapabilityEntry>>
            search: (q: string) => Promise<Array<import('./capabilityTypes').CapabilityEntry>>
            getPluginGroups: (type?: 'skill' | 'agent' | 'command') => Promise<Array<{
                name: string; enabled: boolean
                entries: Array<import('./capabilityTypes').CapabilityEntry>
            }>>
            getStats: () => Promise<{
                total: number; enabled: number
                byType: Record<'skill' | 'agent' | 'command', number>
                bySource: Record<'builtin' | 'user' | 'plugin', number>
            }>
            get: (id: string) => Promise<import('./capabilityTypes').CapabilityEntry | null>
        }

    }
}

// Plugin types (mirrored from src/main/plugin/types.ts for renderer access)
interface PluginManifest {
    name: string
    version?: string
    description?: string
    author?: {
        name: string
        email?: string
        url?: string
    }
    homepage?: string
    repository?: string
    license?: string
    keywords?: string[]
    dependencies?: string[]
    commands?: string | string[] | Record<string, string>
    agents?: string | string[]
    skills?: string | string[]
    mcpServers?: string | Record<string, unknown>
    lspServers?: string | Record<string, unknown>
    settings?: Record<string, unknown>
    userConfig?: UserConfigSchema
}

interface UserConfigSchema {
    [key: string]: {
        type: 'string' | 'number' | 'boolean'
        title?: string
        description?: string
        required?: boolean
        sensitive?: boolean
        default?: unknown
        min?: number
        max?: number
    }
}

interface LoadedPlugin {
    name: string
    source: string
    path: string
    manifest: PluginManifest
    enabled: boolean
    isBuiltin: boolean
    commands?: CommandDef[]
    skills?: SkillDefinition[]
    agents?: AgentDefinition[]
    mcpServers?: McpServerConfig[]
    userConfig?: UserConfigSchema
}

    interface ToolState {
        id: string
        name: string
        enabled: boolean
        timeout?: number | null

        [key: string]: unknown
    }

    /** 传递给 LLM 的工具定义（包含完整的 inputSchema） */
    interface ToolDefinitionForLLM {
        name: string
        description: string
        inputSchema: {
            type: 'object'
            properties: Record<string, {
                type?: string
                description?: string
                enum?: string[]
                const?: unknown
                items?: unknown
                [key: string]: unknown
            }>
            required?: string[]
            [key: string]: unknown
        }
    }

    /** MCP 服务器信息 */
    interface McpServerInfo {
        serverInfo?: { name?: string }
        config?: { id?: string; name?: string }
        name?: string
        id?: string
        status: string
    }

interface CommandDef {
    id: string
    name: string
    description?: string
    args?: ArgumentDef[]
    content: string
    filePath: string
}

interface ArgumentDef {
    name: string
    description?: string
    required?: boolean
    default?: string
}

interface SkillDefinition {
    name: string
    description: string
    filePath: string
    allowedTools?: string[]
    userInvocable?: boolean
}

interface AgentDefinition {
    name: string
    description: string
    filePath: string
    type?: string
}

interface McpServerConfig {
    command: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
}

type PluginError =
    | { type: 'git-clone-failed'; message: string }
    | { type: 'manifest-not-found'; path: string }
    | { type: 'manifest-invalid'; errors: string[] }
    | { type: 'plugin-not-found'; name: string }
    | { type: 'dependency-unsatisfied'; deps: string[] }
}

// CSS module declarations
declare module '*.css' {
    const content: { [className: string]: string }
    export default content
}
