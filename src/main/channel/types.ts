// src/main/channel/types.ts

/** 支持的两类渠道 */
export type ChannelType = 'feishu' | 'wechat'

/** 渠道连接状态 */
export type ChannelStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/** 渠道记录（对应 SQLite channels 表） */
export interface ChannelRecord {
  id: string
  name: string
  type: ChannelType
  enabled: boolean
  config: {
    /** 渠道机器人/账号的用户标识（连接成功后从 SDK/登录响应获取） */
    userId?: string
    [key: string]: any
  }
  status: ChannelStatus
  statusMessage: string
  lastConnectedAt: number | null
  errorCount: number
  createdAt: number
  updatedAt: number
}

/** 渠道会话绑定（对应 channel_bindings 表） */
export interface ChannelBindingRecord {
  id: string
  channelId: string
  channelUserId: string
  conversationId: string
  isActive: boolean
  createdAt: number
  updatedAt: number
}

/** 快捷指令处理结果 */
export interface CommandResult {
    handled: boolean
    reply?: string
    /** 是否需要创建新会话（/new 指令专用） */
    needsNewSession?: boolean
    /** 是否需要重命名会话标题 */
    needsRename?: { title: string }
    /** 是否需要切换会话 */
    needsSwitchChat?: { page: number; index: number }
    /** 是否需要列出会话 */
    needsListChats?: { page: number }
}

/** 用于 IPC 传输的 UI 友好的渠道对象 */
export interface ChannelUI {
  id: string
  name: string
  type: ChannelType
  enabled: boolean
  config: Record<string, any>
  status: ChannelStatus
  statusMessage: string
  lastConnectedAt: number | null
  errorCount: number
  createdAt: number
  updatedAt: number
}

/**
 * CDN media reference structure for encrypted media download/upload.
 * Used by images, voice, video, and file attachments.
 */
export interface CDNMedia {
    encrypt_query_param?: string
    aes_key?: string
    encrypt_type?: number
    full_url?: string
}

export interface ILKImageItem {
    media?: CDNMedia
    media_id?: string
    url?: string
    width?: number
    height?: number
    file_size?: number
    aeskey?: string
}

export interface ILKVoiceItem {
    media?: CDNMedia
    media_id?: string
    voice_len?: number
    file_size?: number
    format?: number
    text?: string
}

export interface ILKVideoItem {
    media?: CDNMedia
    media_id?: string
    thumb_media_id?: string
    thumb_media?: CDNMedia
    file_size?: number
    play_length?: number
}

export interface ILKFileItem {
    media?: CDNMedia
    media_id?: string
    file_name: string
    file_size?: number
    file_ext?: string
}

/** 媒体消息项（iLink 协议） */
export interface MessageItem {
    type: number
    text_item?: { text: string }
    image_item?: ILKImageItem
    voice_item?: ILKVoiceItem
    video_item?: ILKVideoItem
    file_item?: ILKFileItem
}

/** iLink 消息体 */
export interface ILKMessage {
    message_type?: number
    message_state?: number
    from_user_id?: string
    context_token?: string
    item_list?: MessageItem[]
    get_updates_buf?: string
    msgs?: ILKMessage[]
}

/** 资源引用（未下载的附件，用于延迟下载） */
export interface ResourceRef {
    fileKey: string
    type: string
    fileName?: string
}

/** 接入层传入的待处理消息 */
export interface IncomingMessage {
    channelId: string
    userId: string
    text: string
    contextToken?: string
    /** 会话ID，用于构建会话级附件目录 */
    conversationId?: string
    /** 已下载的附件路径列表 */
    attachments?: Array<{ path: string; name: string; mimeType?: string }>
    /** 未下载的资源引用（适配器延迟下载用） */
    resources?: ResourceRef[]
}

/** Worker 线程事件（按 type 分发） */
export type WorkerEvent = {
    type: 'incoming_msg'
    channelId: string
    userId: string
    text: string
    contextToken?: string
    /** 会话ID，用于构建会话级附件目录 */
    conversationId?: string
    attachments?: Array<{ path: string; name: string; mimeType?: string }>
    /** 未下载的资源引用 */
    resources?: ResourceRef[]
} | {
    type: 'status'
    channelId: string
    status: string
    message?: string
} | {
    type: 'test_result'
    channelId: string
    success: boolean
    error?: string
    message?: string
} | {
    type: 'send_result'
    channelId: string
    success: boolean
    error?: string
} | {
    type: 'send_media_result'
    channelId: string
    success: boolean
    error?: string
} | {
    type: 'download_resources_result'
    channelId: string
    messageId: string
    attachments: Array<{ path: string; name: string; mimeType?: string }>
}

// ─── Re-export shared types ─────────────────────────────────

export type {ChannelConfig} from '../../shared/types'

// ─── Channel Adapter Interface ──────────────────────────────

/** 渠道适配器接口 */
export interface ChannelAdapter {
    readonly type: ChannelType

    /** 建立连接 */
    connect(config: Record<string, any>): Promise<void>

    /** 断开连接 */
    disconnect(): Promise<void>

    /** 发送消息 */
    sendMessage(toUserId: string, text: string, contextToken?: string): Promise<SendResult>

    /** 发送媒体消息 */
    sendMedia?(toUserId: string, filePath: string, fileType: string, contextToken?: string): Promise<SendResult>

    /** 测试连接 */
    testConnection(config: Record<string, any>): Promise<TestResult>

    /** 获取连接状态 */
    getStatus(): ConnectionStatus
}

/** 发送消息结果 */
export interface SendResult {
    success: boolean
    error?: string
}

/** 测试连接结果 */
export interface TestResult {
    success: boolean
    error?: string
    message?: string
}

/** 连接状态 */
export interface ConnectionStatus {
    connected: boolean
    message: string
}

// ─── Database Row Types ─────────────────────────────────────

/** 渠道数据库行类型（直接从 SQLite 读取） */
export interface ChannelRow {
    id: string
    name: string
    type: string
    enabled: number
    config: string
    status: string
    status_message: string
    last_connected_at: number | null
    error_count: number
    created_at: number
    updated_at: number
}
