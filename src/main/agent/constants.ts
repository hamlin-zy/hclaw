/**
 * Agent 模块常量定义
 *
 * 集中管理消息类型、Squirrel 命令等常量，避免字符串硬编码
 */

/** Worker 消息类型 */
export const WORKER_MESSAGE_TYPES = {
    /** 更新配置 (ModelConfig) */
    UPDATE_CONFIG: 'update-config',
    /** 更新全局系统设置 (SystemSettings) */
    UPDATE_SETTINGS: 'update-settings',
    /** 更新模型方案 (schemeConfig) */
    UPDATE_SCHEME: 'update-scheme',
    /** 更新权限模式 (permissionMode) */
    UPDATE_PERMISSION_MODE: 'update-permission-mode',
    /** 更新工作模式 (workMode) */
    UPDATE_WORK_MODE: 'update-work-mode',
    /** 请求权限确认 (Worker -> Main) */
    PERMISSION_CONFIRM: 'permission-confirm',
    /** 权限确认结果 (Main -> Worker) */
    USER_CONFIRMATION_RESULT: 'user-confirmation-result',
    /** 向用户提问，等待回答 (Worker -> Main) */
    ASK_USER_QUESTION: 'ask-user-question',
    /** 用户回答结果 (Main -> Worker) */
    USER_ANSWER_RESULT: 'user-answer-result',
    /** 权限规则变更同步 (Worker -> Main) */
    SYNC_PERMISSION_RULES: 'sync-permission-rules',
    /** 终止 Agent (Main -> Worker) */
    ABORT: 'abort',
    /** 请求压缩 (Main -> Worker) */
    REQUEST_COMPACT: 'request-compact',
    /** 刷新 MCP 工具 (Main -> Worker) */
    REFRESH_MCP_TOOLS: 'refresh-mcp-tools',
    /** 注入用户消息到运行中的 Agent 循环 (Main -> Worker) */
    INJECT_USER_MESSAGE: 'inject-user-message',
    /** 渠道消息发送请求 (Worker -> Main) */
    CHANNEL_SEND: 'channel-send',
    /** 渠道媒体文件发送请求 (Worker -> Main) */
    CHANNEL_SEND_MEDIA: 'channel-send-media',
    /** 渠道消息发送结果 (Main -> Worker) */
    CHANNEL_SEND_RESULT: 'channel-send-result',
    /** Agent 结束后残留的注入消息 (Worker -> Main)，用于兜底处理未消费的插入消息 */
    PENDING_MESSAGES_AFTER_EXIT: 'pending-messages-after-exit',
} as const

/** Squirrel Windows 安装程序命令 */
export const SQUIRREL_COMMANDS = [
    '--squirrel-install',
    '--squirrel-updated',
    '--squirrel-uninstall',
    '--squirrel-obsolete',
] as const
