/**
 * FeishuAdapter — 飞书开放平台机器人适配器
 *
 * 使用飞书官方 Channel SDK 实现，优势：
 * - WebSocket 握手/重连全自动化
 * - 消息自动归一化（NormalizedMessage）
 * - 内置安全策略（去重、单聊/群聊策略等）
 * - 支持流式回复
 *
 * 依赖：@larksuiteoapi/node-sdk
 */

import type {ChannelAdapter} from './index'
import type {ChannelType} from '../types'
import {createLarkChannel, type LarkChannel, type NormalizedMessage, type BotIdentity, type CardActionEvent} from '@larksuiteoapi/node-sdk'
import {logger} from '../../agent/logger'

// ─── 常量 ──────────────────────────────────────────────────

interface FeishuConfig {
  appId: string
  appSecret: string
}

/**
 * 飞书 Channel SDK 适配器
 */
export class FeishuAdapter implements ChannelAdapter {
  readonly type: ChannelType = 'feishu'
  channel: LarkChannel | null = null
  botIdentity: BotIdentity | null = null
  conversationId: string = ''

  private _onMessageCallback: ((msg: any) => void) | null = null

  set onMessageCallback(cb: (msg: any) => void) {
    this._onMessageCallback = cb
  }

  /**
   * 建立飞书长连接（Channel SDK 自动处理 WebSocket 握手和重连）
   */
  async connect(config: Record<string, any>): Promise<void> {
    const cfg = config as FeishuConfig

    if (!cfg.appId || !cfg.appSecret) {
      throw new Error('飞书配置不完整：appId 和 appSecret 必填')
    }

    // ── 创建 Channel（自动建立 WebSocket 长连接）──
    this.channel = createLarkChannel({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      // 仅监听消息事件（其他事件类型按需添加）
      // 注意：需要在开发者后台「事件与回调」中订阅 im.message.receive_v1
    })

    // ── 监听消息 ──
    this.channel.on('message', async (msg: NormalizedMessage) => {
      // 不再立即下载附件——此时 conversationId 可能尚未设置。
      // 改为传递资源引用，由主进程在已知 conversationId 后触发下载，
      // 确保附件保存到正确的会话级目录。
      this._onMessageCallback?.({
        channelId: 'feishu',
        userId: msg.senderId,
        text: msg.content,
        contextToken: msg.messageId,
        conversationId: this.conversationId,
        resources: msg.resources?.map(r => ({
          fileKey: r.fileKey,
          type: r.type,
          fileName: r.fileName,
        })),
      })
    })

    // ── 监听卡片交互（按钮点击等）──
    this.channel.on('cardAction', async (evt: CardActionEvent) => {
      // 卡片按钮回调处理
      const actionData = evt.action?.value || evt.action
      this._onMessageCallback?.({
        channelId: 'feishu',
        userId: evt.operator?.userId || evt.operator?.openId || '',
        text: JSON.stringify(actionData),
        contextToken: evt.messageId,
        conversationId: this.conversationId,
        isCardAction: true,
        cardAction: evt,
      })
    })

    // ── 建立连接（会等待 WebSocket 握手成功）──
    await this.channel.connect()
    this.botIdentity = this.channel.botIdentity!
    logger.info('FeishuAdapter.connected')
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (this.channel) {
      await this.channel.disconnect()
      this.channel = null
      this.botIdentity = null
      logger.info('FeishuAdapter.disconnected')
    }
  }

  /**
   * 发送文本消息
   */
  async sendMessage(
    toUserId: string,
    text: string,
    contextToken?: string,
  ): Promise<{success: boolean; error?: string}> {
    if (!this.channel) {
      return {success: false, error: 'Channel not connected'}
    }

    try {
      // 判断是单聊还是群聊消息
      const isReply = !!contextToken
      const sendOpts = isReply ? {replyTo: contextToken} : {}

      // 优先尝试 Markdown 格式，失败后降级为纯文本
      await this.channel.send(toUserId, {markdown: text}, sendOpts)
      return {success: true}
    } catch (err: any) {
      return {success: false, error: err.message}
    }
  }

  /**
   * 发送媒体消息（图片/文件）
   */
  async sendMedia(
    toUserId: string,
    filePath: string,
    fileType: string,
    _contextToken?: string,
  ): Promise<{success: boolean; error?: string}> {
    if (!this.channel) {
      return {success: false, error: 'Channel not connected'}
    }

    try {
      const isImage = ['image', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(fileType.toLowerCase())

      if (isImage) {
        await this.channel.send(toUserId, {image: {source: filePath}})
      } else {
        await this.channel.send(toUserId, {
          file: {source: filePath, fileName: filePath.split(/[/\\]/).pop() || 'file'},
        })
      }

      return {success: true}
    } catch (err: any) {
      return {success: false, error: err.message}
    }
  }

  /**
   * 测试连接（获取 token 验证凭据有效性）
   */
  async testConnection(config: Record<string, any>): Promise<{
    success: boolean
    error?: string
    message?: string
  }> {
    try {
      const cfg = config as FeishuConfig
      if (!cfg.appId || !cfg.appSecret) {
        return {success: false, error: 'appId 和 appSecret 未配置'}
      }

      // 创建临时 Channel 测试连接（不注册事件）
      const testChannel = createLarkChannel({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        // 禁止自动重连，避免测试时产生副作用
      })

      await testChannel.connect()
      const identity = testChannel.botIdentity
      await testChannel.disconnect()

      if (identity) {
        return {success: true, message: `连接测试成功：${identity.name}`}
      }
      return {success: false, error: '无法获取机器人信息'}
    } catch (err: any) {
      return {success: false, error: err.message}
    }
  }

  /**
   * 获取连接状态
   */
  getStatus(): {connected: boolean; message: string} {
    if (!this.channel) {
      return {connected: false, message: '未连接'}
    }

    const status = this.channel.getConnectionStatus()
    if (!status) {
      return {connected: false, message: '连接状态未知'}
    }

    const stateMap: Record<string, string> = {
      idle: '未连接',
      connecting: '连接中',
      connected: '已连接',
      reconnecting: '重连中',
      disconnected: '已断开',
    }

    return {
      connected: status.state === 'connected',
      message: stateMap[status.state] || status.state,
    }
  }

  /**
   * 设置当前会话ID（用于构建会话级附件目录）
   */
  setConversationId(conversationId: string): void {
    this.conversationId = conversationId
  }

  /**
   * 在已知 conversationId 后下载附件资源
   * 由主进程通过 Worker 触发，确保附件保存到正确的会话级目录
   */
  async downloadAttachments(resources: Array<{fileKey: string; type: string; fileName?: string}>): Promise<Array<{path: string; name: string; mimeType?: string}>> {
    if (!resources?.length || !this.channel) return []

    const attachments: Array<{path: string; name: string; mimeType?: string}> = []
    for (const res of resources) {
      try {
        const buf = await this.channel.downloadResource(res.fileKey, res.type as any)
        const mimeType = this.#getMimeType(res)
        const {saveMediaBuffer} = await import('./mediaUtils')
        const result = saveMediaBuffer('feishu', buf, {
          conversationId: this.conversationId,  // 此时会话 ID 已正确设置
          fileName: res.fileName,
          mimeType,
        })
        attachments.push({
          path: result.path!,
          name: res.fileName || res.fileKey,
          mimeType,
        })
      } catch (_err) {
      }
    }

    return attachments
  }

  /**
   * 发送飞书交互卡片消息（Interactive Card）
   */
  async sendCard(
    toUserId: string,
    card: Record<string, any>,
    _contextToken?: string,
  ): Promise<{success: boolean; error?: string}> {
    if (!this.channel) {
      return {success: false, error: 'Channel not connected'}
    }

    try {
      await this.channel.send(toUserId, {card})
      return {success: true}
    } catch (err: any) {
      return {success: false, error: err.message}
    }
  }

  // ─── 私有方法 ────────────────────────────────────────

  /**
   * 根据资源类型推断 MIME 类型
   */
  #getMimeType(res: {type: string; fileName?: string}): string {
    const ext = res.fileName?.split('.').pop()?.toLowerCase()
    const typeMap: Record<string, string> = {
      image: 'image/png',
      file: 'application/octet-stream',
      audio: 'audio/amr',
      video: 'video/mp4',
      sticker: 'image/png',
    }
    const mime = typeMap[res.type] || 'application/octet-stream'
    if (ext === 'png') return 'image/png'
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
    if (ext === 'gif') return 'image/gif'
    if (ext === 'mp4') return 'video/mp4'
    if (ext === 'amr') return 'audio/amr'
    return mime
  }
}