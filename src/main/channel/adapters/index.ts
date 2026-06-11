// src/main/channel/adapters/index.ts

import type {ChannelType} from '../types'

/** 渠道适配器基类 - 所有渠道实现此接口 */
export interface ChannelAdapter {
    readonly type: ChannelType

    /** 建立连接 */
    connect(config: Record<string, any>): Promise<void>

    /** 断开连接 */
    disconnect(): Promise<void>

    /** 发送消息 */
    sendMessage(toUserId: string, text: string, contextToken?: string): Promise<{ success: boolean; error?: string }>

    /** 发送媒体消息 */
    sendMedia?(toUserId: string, filePath: string, fileType: string, contextToken?: string): Promise<{
        success: boolean;
        error?: string
    }>

    /** 测试连接 */
    testConnection(config: Record<string, any>): Promise<{ success: boolean; error?: string; message?: string }>

    /** 获取连接状态 */
    getStatus(): { connected: boolean; message: string }
}
