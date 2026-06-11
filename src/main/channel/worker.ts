/**
 * ChannelWorker — Worker Thread
 *
 * 在独立线程中运行多个渠道适配器，通过 postMessage 与主进程通信。
 * 适配器按 channelType 动态创建，消息通过 parentPort 转发。
 */

import {parentPort} from 'worker_threads'
import {FeishuAdapter} from './adapters/feishuAdapter'
import {WeChatAdapter} from './adapters/wechatAdapter'
import {logger} from '../agent/logger'
import type {ChannelAdapter} from './adapters/index'

if (!parentPort) throw new Error('ChannelWorker must be run as a Worker thread')

const adapters = new Map<string, ChannelAdapter>()

function post(channelId: string, type: string, extra?: Record<string, unknown>) {
  parentPort?.postMessage({type, channelId, ...extra})
}

function postError(type: string, channelId: string, err: unknown) {
  post(channelId, type, {
    success: false,
    error: err instanceof Error ? err.message : String(err),
  })
}

function get(channelId: string): ChannelAdapter {
  const a = adapters.get(channelId)
  if (!a) throw new Error(`Adapter not found: ${channelId}`)
  return a
}

function setOnMessage(adapter: ChannelAdapter, channelId: string): void {
  if ('onMessageCallback' in adapter) {
    (adapter as any).onMessageCallback = (msg: any) => {
      parentPort?.postMessage({type: 'incoming_msg', channelId, ...msg})
    }
  }
}

function createAdapter(channelType: string): ChannelAdapter {
  switch (channelType) {
    case 'feishu': return new FeishuAdapter()
    case 'wechat': return new WeChatAdapter()
    default: throw new Error(`Unsupported channel type: ${channelType}`)
  }
}

parentPort.on('message', async (msg: any) => {
  try {
    switch (msg.cmd) {
      case 'connect': {
        post(msg.channelId, 'status', {status: 'connecting'})
        try {
          const existing = adapters.get(msg.channelId)
          if (existing) {
            await existing.disconnect()
          }

          const adapter = createAdapter(msg.channelType)
          setOnMessage(adapter, msg.channelId)
          adapters.set(msg.channelId, adapter)

          const connectionTimeout = msg.connectionTimeout ?? 30
          const timeoutMs = connectionTimeout * 1000
          const connectPromise = adapter.connect(msg.config)
          const timeoutPromise = new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`连接超时 (${connectionTimeout}s)`)), timeoutMs)
          )
          await Promise.race([connectPromise, timeoutPromise])

          post(msg.channelId, 'status', {
            status: 'connected',
            botIdentity: 'botIdentity' in adapter ? (adapter as any).botIdentity : undefined,
          })
        } catch (err: any) {
          logger.info('worker.connect', { channelId: msg.channelId, error: err.message })
          post(msg.channelId, 'status', {status: 'error', message: err.message})
        }
        break
      }

      case 'send':
        try {
          const result = await get(msg.channelId).sendMessage(msg.toUserId, msg.text, msg.contextToken)
          post(msg.channelId, 'send_result', result)
        } catch (err: any) {
          postError('send_result', msg.channelId, err)
        }
        break

      case 'send_media':
        try {
          const adapter = get(msg.channelId)
          const result = adapter.sendMedia
              ? await adapter.sendMedia(msg.toUserId, msg.filePath, msg.fileType, msg.contextToken)
              : await adapter.sendMessage(msg.toUserId, `📎 已生成文件：${msg.filePath}`, msg.contextToken)
          post(msg.channelId, 'send_media_result', result)
        } catch (err: any) {
          postError('send_media_result', msg.channelId, err)
        }
        break

      case 'set_conversation_id': {
        const adapter = adapters.get(msg.channelId)
        if (adapter && 'setConversationId' in adapter) {
          (adapter as any).setConversationId(msg.conversationId)
        }
        break
      }

      case 'download_resources': {
        const dlAdapter = adapters.get(msg.channelId)
        const attachments = dlAdapter && 'downloadAttachments' in dlAdapter
            ? await (dlAdapter as any).downloadAttachments(msg.resources)
            : []
        post(msg.channelId, 'download_resources_result', {messageId: msg.messageId, attachments})
        break
      }

      case 'disconnect': {
        const adapter = adapters.get(msg.channelId)
        if (adapter) {
          await adapter.disconnect()
          adapters.delete(msg.channelId)
        }
        logger.info('worker.disconnect', { channelId: msg.channelId })
        post(msg.channelId, 'status', {status: 'disconnected'})
        break
      }

      case 'test':
        try {
          const adapter = adapters.get(msg.channelId)
          const result = adapter
              ? await adapter.testConnection(msg.config || {})
              : {success: false, error: 'Adapter not initialized'}
          post(msg.channelId, 'test_result', result)
        } catch (err: any) {
          postError('test_result', msg.channelId, err)
        }
        break

      case 'shutdown': {
        for (const [id, adapter] of adapters) {
          await adapter.disconnect()
          adapters.delete(id)
        }
        parentPort?.close()
        process.exit(0)
      }

      default:
        post(msg.channelId ?? '', 'error', {message: `Unknown command: ${msg.cmd}`})
    }
  } catch (err) {
    logger.error('worker.uncaught', { error: (err as Error)?.message || err })
    post('', 'error', {message: (err as Error).message})
  }
})