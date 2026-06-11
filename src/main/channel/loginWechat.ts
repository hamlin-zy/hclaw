/**
 * loginWechat — 个人微信 iLink 协议扫码登录
 *
 * 基于 weixin-agent-sdk 反编译的登录流程：
 * 1. GET ilink/bot/get_bot_qrcode?bot_type=3 → 获取二维码标识 + 二维码内容 URL
 * 2. GET ilink/bot/get_qrcode_status?qrcode=xxx → 轮询扫码状态（长轮询 35s）
 * 3. 确认后获得 bot_token，用于后续 API 调用
 */
import {logger} from '../agent/logger'

const ILINK_BASE = 'https://ilinkai.weixin.qq.com'
const GET_QRCODE_TIMEOUT_MS = 5_000
const QR_POLL_TIMEOUT_MS = 35_000
const QR_SESSION_TTL_MS = 5 * 60_000

interface QRCodeResponse {
  qrcode: string
  qrcode_img_content: string
}

interface StatusResponse {
  status: 'wait' | 'scanned' | 'confirmed' | 'expired' | 'scanned_but_redirect'
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

interface LoginSession {
  qrcode: string
  qrcodeUrl: string
  startedAt: number
  abortController: AbortController
}

const activeSessions = new Map<string, LoginSession>()

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

/**
 * iLink 登录 API 使用 GET 请求（与消息 API 的 POST 不同）
 * 仅携带轻量头信息，无需 Authorization / X-WECHAT-UIN
 */
async function apiGet(
  baseUrl: string,
  endpoint: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const base = ensureTrailingSlash(baseUrl)
  const url = new URL(endpoint, base)
    const urlStr = url.toString()
    const startTime = Date.now()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // 合并外部 signal
  const cleanup: (() => void)[] = []
  if (signal) {
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, {once: true})
    cleanup.push(() => signal.removeEventListener('abort', onAbort))
  }

  try {
      const res = await fetch(urlStr, {
      method: 'GET',
      signal: controller.signal,
    })
      const elapsed = Date.now() - startTime
    clearTimeout(timer)
    cleanup.forEach(fn => fn())
      const body = await res.text()
    if (!res.ok) {
        logger.warn('[loginWechat] apiGet HTTP error', {
            url: urlStr, status: res.status, body: body.slice(0, 200), elapsed,
        })
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
      logger.info('[loginWechat] apiGet success', {
          url: urlStr, status: res.status, bodyLen: body.length, bodyPreview: body.slice(0, 150), elapsed,
      })
      return body
  } catch (err) {
      const elapsed = Date.now() - startTime
    clearTimeout(timer)
    cleanup.forEach(fn => fn())
      if ((err as any)?.name === 'AbortError') {
          if (signal?.aborted) {
              logger.info('[loginWechat] apiGet cancelled (external signal)', {url: urlStr, elapsed})
          } else {
              logger.info('[loginWechat] apiGet timeout (long-poll)', {url: urlStr, timeoutMs, elapsed})
          }
      } else {
          logger.warn('[loginWechat] apiGet error', {
              url: urlStr, error: (err as Error)?.message, elapsed,
          })
      }
    throw err
  }
}

/**
 * 启动微信扫码登录
 *
 * 调用 get_bot_qrcode 接口（GET 请求）获取二维码。
 * 返回 qrcodeUrl（二维码内容字符串，供渲染进程用 qrcode 库生成图片）和 sessionKey。
 */
export async function startWechatLogin(): Promise<{
  qrcodeUrl: string
  sessionKey: string
}> {
  const abortController = new AbortController()

  const rawText = await apiGet(
    ILINK_BASE,
    `ilink/bot/get_bot_qrcode?bot_type=3`,
    GET_QRCODE_TIMEOUT_MS,
    abortController.signal,
  )
  const data: QRCodeResponse = JSON.parse(rawText)
  logger.info('[loginWechat] QR code received', {
    qrcodeLen: data.qrcode?.length,
      qrcodePreview: data.qrcode?.slice(0, 16),
    imgContentLen: data.qrcode_img_content?.length,
      imgContentPreview: data.qrcode_img_content?.slice(0, 50),
  })

  const sessionKey = `wx-login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  activeSessions.set(sessionKey, {
    qrcode: data.qrcode,
    qrcodeUrl: data.qrcode_img_content,
    startedAt: Date.now(),
    abortController,
  })

  return {qrcodeUrl: data.qrcode_img_content, sessionKey}
}

/**
 * 检查微信扫码登录状态
 *
 * 调用 get_qrcode_status 接口（GET 请求，短轮询 5s）。
 * 前端每 2s 调用一次，超时返回 wait 由前端继续轮询。
 *
 * @returns 登录状态（值已映射到渲染进程期望的格式）
 */
export async function checkWechatLogin(
  sessionKey: string,
): Promise<{
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'binded_redirect' | 'error'
  botToken?: string
  accountId?: string
  baseUrl?: string
  userId?: string
  message?: string
}> {
  const session = activeSessions.get(sessionKey)
  if (!session) {
    return {status: 'error', message: '会话已过期或不存在'}
  }

  if (Date.now() - session.startedAt > QR_SESSION_TTL_MS) {
    activeSessions.delete(sessionKey)
    return {status: 'expired', message: '二维码已过期，请重新扫码'}
  }

  try {
    const rawText = await apiGet(
      ILINK_BASE,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`,
        QR_POLL_TIMEOUT_MS,
      session.abortController.signal,
    )

      // 尝试 JSON 解析，失败时日志输出原文
      let data: StatusResponse
      try {
          data = JSON.parse(rawText)
      } catch {
          logger.error('[loginWechat] JSON parse failed', {rawText: rawText.slice(0, 300)})
          return {status: 'wait'}
      }

      logger.info('[loginWechat] status response', {
          status: data.status, hasBotToken: !!data.bot_token,
          hasIlinkBotId: !!data.ilink_bot_id, hasBaseurl: !!data.baseurl,
      })

    switch (data.status) {
      case 'confirmed':
        activeSessions.delete(sessionKey)
          logger.info('[loginWechat] login confirmed', {
              botTokenLen: data.bot_token?.length,
              baseUrl: data.baseurl,
              userId: data.ilink_user_id,
          })
        return {
          status: 'confirmed',
          botToken: data.bot_token,
          accountId: data.ilink_bot_id,
          baseUrl: data.baseurl || ILINK_BASE,
          userId: data.ilink_user_id,
        }

      case 'scanned_but_redirect':
        activeSessions.delete(sessionKey)
          logger.warn('[loginWechat] binded redirect', {redirectHost: data.redirect_host})
        return {
          status: 'binded_redirect',
          message: data.redirect_host
            ? `该账号已在 ${data.redirect_host} 绑定，请更换账号`
            : '该账号已在其他平台连接',
        }

      case 'scanned':
          logger.info('[loginWechat] QR scanned by user')
        return {status: 'scaned'}

      case 'expired':
        activeSessions.delete(sessionKey)
          logger.info('[loginWechat] QR expired')
        return {status: 'expired', message: '二维码已过期，请重新扫码'}

      default: // 'wait'
        return {status: 'wait'}
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
        logger.info('[loginWechat] poll timeout (normal for long-poll)', {
            qrcodePreview: session.qrcode.slice(0, 12),
        })
        return {status: 'wait'}
    }
      logger.error('[loginWechat] check status error', {
          error: err.message, qrcodePreview: session.qrcode.slice(0, 12),
      })
    return {status: 'wait'}
  }
}

/**
 * 取消微信扫码登录
 */
export function cancelWechatLogin(sessionKey: string): void {
  const session = activeSessions.get(sessionKey)
  if (session) {
    session.abortController.abort()
    activeSessions.delete(sessionKey)
    logger.info('[loginWechat] Login cancelled', {sessionKey})
  }
}
