/**
 * WeChatAdapter — 个人微信 iLink 协议适配器
 *
 * 支持通过 CDN 下载和 AES 解密媒体文件（图片、语音、视频、文件）
 * 支持发送媒体文件（需要 CDN 上传）
 */

import crypto from 'crypto'
import * as path from 'path'
import * as fs from 'fs'

import type {ChannelAdapter} from './index'
import type {CDNMedia, ChannelType, MessageItem} from '../types'
import {saveMediaBuffer} from './mediaUtils'
import {
    aesEcbPaddedSize,
    API_ENDPOINTS,
    AUDIO_EXTENSIONS,
    buildCdnDownloadUrl,
    buildCdnUploadUrl,
    CDN,
    getFileExtension,
    getMimeFromFilePath,
    ILINK,
    IMAGE_EXTENSIONS,
    TIMEOUTS,
    VIDEO_EXTENSIONS,
} from '../constants'
import {logger} from '../../agent/logger'

// ─── Types ──────────────────────────────────────────────────

interface WeChatConfig {
    botToken: string;
    accountName?: string;
    baseUrl?: string
}

interface UploadedMedia {
    filekey: string
    upload_param: string
    thumb_upload_param?: string
    fileSize: number
    fileSizeCiphertext: number
    aes_key: string
}

interface WeixinMessage {
    message_type?: number;
    message_state?: number;
    from_user_id?: string
    context_token?: string;
    item_list?: MessageItem[];
    get_updates_buf?: string
}

type MediaResult = { path: string | null; name: string; mimeType?: string }
type SendResult = { success: boolean; error?: string }

const log = (m: string, ...args: unknown[]) => logger.info('WeChatAdapter.' + m, { args: args.length > 0 ? args : undefined })
const logErr = (m: string, ...args: unknown[]) => logger.error('WeChatAdapter.' + m, { args: args.length > 0 ? args : undefined })

// ─── Adapter ────────────────────────────────────────────────

export class WeChatAdapter implements ChannelAdapter {
    readonly type: ChannelType = 'wechat'
    private config: WeChatConfig | null = null
    private apiBase: string = API_ENDPOINTS.ILINK_BASE
    private cdnBase: string = CDN.DEFAULT_BASE_URL
    private updatesBuf = ''
    private connected = false
    private pollingActive = false
    /** 会话ID，用于构建会话级附件目录 */
    private conversationId: string = ''

    onMessageCallback?: (msg: unknown) => void

    // ─── Public API ─────────────────────────────────────────

    async connect(config: Record<string, unknown>): Promise<void> {
        this.config = config as unknown as WeChatConfig
        if (this.config.baseUrl) {
            this.apiBase = this.config.baseUrl.replace(/\/+$/, '')
            this.cdnBase = this.apiBase
        }
        log(`connect botToken=${this.config.botToken?.length ?? 0}chars`)
        this.connected = true
        this.startPolling().catch(err => logErr('startPolling crashed:', err.message))
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        this.pollingActive = false
        await this.notifyStop().catch(() => {
        })
    }

    /**
     * 设置当前会话ID，用于构建会话级附件目录
     * 由 ChannelManager 在收到消息时调用
     */
    setConversationId(conversationId: string): void {
        this.conversationId = conversationId
    }

    private static checkUserId(userId: string): string {
        return userId.includes('@') ? userId : userId+'@im.wechat';
    }

    async sendMessage(toUserId: string, text: string, contextToken?: string): Promise<SendResult> {
        const cleanUserId = WeChatAdapter.checkUserId(toUserId);
        return this.sendApi({
            toUserId: cleanUserId, contextToken,
            itemList: [{type: ILINK.ITEM_TYPE_TEXT, text_item: {text}}],
        })
    }

    async sendMedia(toUserId: string, filePath: string, _fileType: string, contextToken?: string): Promise<SendResult> {
        const cleanUserId = WeChatAdapter.checkUserId(toUserId);
        if (!this.config?.botToken) return {success: false, error: 'Not authenticated'}

        const stat = tryStat(filePath)
        if (!stat) return {success: false, error: `File not found: ${filePath}`}
        if (stat.size > CDN.MAX_FILE_SIZE) return {success: false, error: `File too large: ${stat.size}`}

        const ext = getFileExtension(filePath)
        const {itemType, mediaType} = classifyExt(ext)
        const uploaded = await this.uploadMediaToCdn(filePath, mediaType, cleanUserId)

        // aes_key 格式：hex 字符串 → base64，对齐 iLink SDK 规范
        // SDK: Buffer.from(hexString).toString("base64") 将 hex 字符当 ASCII 文本编码
        const aesKeyBase64 = Buffer.from(uploaded.aes_key).toString('base64')
        const cdnRef: CDNMedia = {encrypt_query_param: uploaded.upload_param, aes_key: aesKeyBase64, encrypt_type: 1}

        let item: MessageItem
        switch (itemType) {
            case ILINK.ITEM_TYPE_IMAGE:
                item = {
                    type: itemType,
                    image_item: {media: cdnRef, ...(uploaded.fileSizeCiphertext && {mid_size: uploaded.fileSizeCiphertext}) as any}
                };
                break
            case ILINK.ITEM_TYPE_VIDEO:
                item = {type: itemType, video_item: {media: cdnRef}};
                break
            case ILINK.ITEM_TYPE_VOICE:
                item = {type: itemType, voice_item: {media: cdnRef}};
                break
            default:
                item = {
                    type: itemType,
                    file_item: {media: cdnRef, file_name: path.basename(filePath), file_ext: ext.slice(1)}
                }
        }

        log(`sendMedia: calling sendApi with item type=${itemType} (image=${itemType === ILINK.ITEM_TYPE_IMAGE}) file=${path.basename(filePath)}`)
        const sendResult = await this.sendApi({toUserId: cleanUserId, contextToken, itemList: [item]})
        log(`sendMedia: sendApi result: success=${sendResult.success}${sendResult.error ? ' error=' + sendResult.error : ''}`)
        return sendResult
    }

    async testConnection(config: Record<string, unknown>): Promise<{
        success: boolean;
        error?: string;
        message?: string
    }> {
        if (!(config as unknown as WeChatConfig)?.botToken) return {success: false, error: 'BotToken 未配置'}
        return {success: true, message: '配置校验通过'}
    }

    getStatus(): { connected: boolean; message: string } {
        return {connected: this.connected, message: this.connected ? '长轮询中' : '未连接'}
    }

    // ─── Polling ────────────────────────────────────────────

    private async notifyStop(): Promise<void> {
        try {
            await fetch(`${this.apiBase}${API_ENDPOINTS.ILINK_NOTIFY_STOP}`, {
                method: 'POST', headers: this.headers(),
                body: JSON.stringify({base_info: {channel_version: ILINK.CHANNEL_VERSION}}),
            })
        } catch { /* ignore */
        }
    }

    private async startPolling(): Promise<void> {
        log('started')
        this.pollingActive = true
        let count = 0

        while (this.pollingActive && this.connected) {
            count++

            try {
                if (count % 60 === 1) log(`getupdates #${count}`)

                const res = await fetch(`${this.apiBase}${API_ENDPOINTS.ILINK_GET_UPDATES}`, {
                    method: 'POST', headers: this.headers(),
                    body: JSON.stringify({
                        get_updates_buf: this.updatesBuf,
                        base_info: {channel_version: ILINK.CHANNEL_VERSION},
                    }),
                })

                if (!res.ok) {
                    logErr(`getupdates HTTP ${res.status}, retry`)
                    await this.sleep(TIMEOUTS.RECONNECT_DELAY);
                    continue
                }

                const data = await res.json() as WeixinMessage & { msgs?: WeixinMessage[] }
                if (data.get_updates_buf) this.updatesBuf = data.get_updates_buf

                const msgs = data.msgs || (data.message_type ? [data] : [])
                // 过滤掉自己发的消息（echo），避免轮询收到自己 send 后产生重复处理
                const userMsgs = msgs.filter(m => m.message_type !== ILINK.MESSAGE_TYPE_BOT)
                if (!userMsgs.length) {
                    if (msgs.length) log(`skipped ${msgs.length} self-echoed bot message(s)`)
                    await this.sleep(TIMEOUTS.SLEEP_SHORT);
                    continue
                }

                log(`getupdates #${count} received ${userMsgs.length} user message(s)`)
                for (const msg of userMsgs) {
                    if (!msg.from_user_id || !this.onMessageCallback) continue
                    const {text, attachments} = await this.extractAttachments(msg)
                    const conversationId = this.conversationId

                    this.onMessageCallback({
                        channelId: 'wechat', userId: msg.from_user_id, text,
                        contextToken: msg.context_token,
                        conversationId,
                        attachments: attachments.length ? attachments : undefined,
                    })
                }
            } catch (err) {
                if (!this.connected) break
                logErr(`Polling error #${count}:`, (err as Error).message)
                await this.sleep(TIMEOUTS.RECONNECT_DELAY)
            }
        }
        log('exited')
    }

    // ─── Send API ───────────────────────────────────────────

    // iLink API 错误码含义映射
    private readonly RET_ERROR_MESSAGES: Record<number, string> = {
        [-2]: '用户ID格式错误或用户不存在',
        [-3]: '用户与机器人没有会话关系，请先添加机器人为好友',
        [-14]: '会话已过期',
        [-100]: 'Bot token无效或已过期',
    };

    private async sendApi(opts: {
        toUserId: string;
        contextToken?: string;
        itemList: MessageItem[]
    }): Promise<SendResult> {
        if (!this.config?.botToken) return {success: false, error: 'Not authenticated'}

        try {
            const res = await fetch(`${this.apiBase}${API_ENDPOINTS.ILINK_SEND_MESSAGE}`, {
                method: 'POST', headers: this.headers(),
                body: JSON.stringify({
                    msg: {
                        from_user_id: '', to_user_id: opts.toUserId,
                        client_id: crypto.randomUUID(),
                        message_type: ILINK.MESSAGE_TYPE_BOT,
                        message_state: ILINK.MESSAGE_STATE_FINISH,
                        item_list: opts.itemList,
                        context_token: opts.contextToken || undefined,
                    },
                    base_info: {channel_version: ILINK.CHANNEL_VERSION},
                }),
            })

            const text = await res.text()
            log(`sendApi: HTTP ${res.status} body=${text.slice(0, 300)}`)
            if (!res.ok) return {success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`}

            const data = JSON.parse(text)
            if (data.errcode !== undefined && data.errcode !== 0) {
                const retCode = data.errcode as number;
                const errorMsg = this.RET_ERROR_MESSAGES[retCode] || `API错误 (errcode=${retCode}): ${data.errmsg || ''}`;
                log(`sendApi failed: ${errorMsg}, toUserId=${opts.toUserId}`);
                return {success: false, error: errorMsg};
            }
            return {success: true}
        } catch (err) {
            return {success: false, error: (err as Error).message}
        }
    }

    // ─── Inbound Message Processing ─────────────────────────

    /**
     * 提取消息文本和附件（使用官方 bodyFromItemList 提取原始文本，不生成 [图片] 标记）
     *
     * bodyFromItemList 行为：
     * - TEXT 项 → 返回用户输入的文字
     * - VOICE 项 + voice_item.text → 返回语音转文字
     * - 图片/文件 → 返回空字符串
     *
     * 当返回空文本时，messageHandler 的 isAttachmentOnlyMarker 识别为纯附件→积压
     */
    private async extractAttachments(msg: WeixinMessage): Promise<{ text: string; attachments: MediaResult[] }> {
        const text = bodyFromItemList(msg.item_list) || ''
        if (!msg.item_list?.length) return {text: '', attachments: []}

        const attachments: MediaResult[] = []
        for (const item of msg.item_list) {
            const result = await this.downloadMediaItem(item)
            if (result) attachments.push(result)
        }
        return {text, attachments}
    }

    private async downloadMediaItem(item: MessageItem): Promise<MediaResult | null> {
        const uniqueId = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`

        // 优先按实际存在的子字段匹配（比 type 数字更可靠）
        // 微信 iLink 协议中 FILE 消息的 type=4（与 VIDEO 冲突），所以不能完全依赖 type
        if (item.file_item) return await this.downloadFile(item.file_item, uniqueId)
        if (item.video_item) return await this.downloadVideo(item.video_item, uniqueId)

        switch (item.type) {
            case ILINK.ITEM_TYPE_IMAGE:
                if (!item.image_item) return null
                return await this.downloadImage(item.image_item, uniqueId)

            case ILINK.ITEM_TYPE_VOICE:
                // 语音转文字已由 bodyFromItemList 提取，此处不下载音频
                if (!item.voice_item || item.voice_item.text) return null
                return await this.downloadVoice(item.voice_item, uniqueId)

            case ILINK.ITEM_TYPE_VIDEO:
                // type=4 冲突：FILE 和 VIDEO 都用此编号，优先匹配 file_item
                if (item.file_item) return await this.downloadFile(item.file_item, uniqueId)
                return null

            case ILINK.ITEM_TYPE_FILE:
                if (!item.file_item) return null
                return await this.downloadFile(item.file_item, uniqueId)

            default:
                return null
        }
    }

    // ─── CDN Download ───────────────────────────────────────

    /** 统一 CDN 下载入口：优先 AES 解密，回退明文下载 */
    private async downloadCdn(param: string, aesKey: string, fullUrl?: string): Promise<Buffer | null> {
        if (!param) return null
        try {
            if (aesKey) return await this.cdnFetchAndDecrypt(param, aesKey, fullUrl)
            const url = fullUrl || buildCdnDownloadUrl(param, this.cdnBase)
            const res = await fetch(url)
            if (!res.ok) throw new Error(`CDN download failed: ${res.status}`)
            return Buffer.from(await res.arrayBuffer())
        } catch (err) {
            logErr('downloadCdn:', (err as Error).message)
            return null
        }
    }

    private async cdnFetchAndDecrypt(param: string, aesKey: string, fullUrl?: string): Promise<Buffer> {
        const key = parseAesKey(aesKey)
        const url = fullUrl || buildCdnDownloadUrl(param, this.cdnBase)
        const res = await fetch(url)
        if (!res.ok) throw new Error(`CDN fetch failed: ${res.status}`)
        return decryptAesEcb(Buffer.from(await res.arrayBuffer()), key)
    }

    /**
     * 保存媒体文件到会话隔离目录
     * 委托给 mediaUtils.saveMediaBuffer，按 conversationId 隔离
     */
    private _saveMediaBuffer(
        buffer: Buffer,
        mimeType?: string,
        _direction?: string,
        _maxBytes?: number,
        fileName?: string
    ): { path: string } {
        return saveMediaBuffer('wechat', buffer, {
            conversationId: this.conversationId,
            mimeType,
            fileName,
        })
    }

    private async downloadImage(item: NonNullable<MessageItem['image_item']>, uniqueId: string): Promise<MediaResult> {
        const param = item.media?.encrypt_query_param || item.aeskey || item.media_id || ''
        const aesKey = item.aeskey || item.media?.aes_key || ''

        if (!param && item.url) {
            const buf = await this.fetchBuffer(item.url)
            if (!buf) return {path: null, name: ''}
            const saved = this._saveMediaBuffer(buf, 'image/jpeg', 'inbound', 100 * 1024 * 1024, `img_${uniqueId}.jpg`)
            return {path: saved.path, name: path.basename(saved.path)}
        }

        const buf = await this.downloadCdn(param, aesKey, item.media?.full_url)
        if (!buf) return {path: null, name: ''}
        const saved = this._saveMediaBuffer(buf, 'image/jpeg', 'inbound', 100 * 1024 * 1024)
        return {path: saved.path, name: path.basename(saved.path)}
    }

    private async downloadVoice(item: NonNullable<MessageItem['voice_item']>, _uniqueId: string): Promise<MediaResult> {
        const param = item.media?.encrypt_query_param || item.media_id || ''
        const aesKey = item.media?.aes_key || ''
        if (!param || !aesKey) return {path: null, name: '', mimeType: 'audio/silk'}

        try {
            const silk = await this.cdnFetchAndDecrypt(param, aesKey, item.media?.full_url)
            const wav = await silkToWav(silk)
            const mimeType = wav ? 'audio/wav' : 'audio/silk'
            const saved = this._saveMediaBuffer(wav ?? silk, mimeType, 'inbound', 100 * 1024 * 1024)
            return {path: saved.path, name: path.basename(saved.path), mimeType}
        } catch (err) {
            logErr('downloadVoice:', (err as Error).message)
            return {path: null, name: '', mimeType: 'audio/silk'}
        }
    }

    private async downloadVideo(item: NonNullable<MessageItem['video_item']>, uniqueId: string): Promise<MediaResult> {
        return this.downloadMediaFile(
            item.media?.encrypt_query_param || item.media_id || '',
            item.media?.aes_key || '',
            'mp4', uniqueId,
        )
    }

    private async downloadFile(item: NonNullable<MessageItem['file_item']>, uniqueId: string): Promise<MediaResult> {
        const param = item.media?.encrypt_query_param || item.media_id || ''
        const aesKey = item.media?.aes_key || ''
        const origName = item.file_name || `file_${uniqueId}`

        const buf = await this.downloadCdn(param, aesKey, item.media?.full_url)
        if (!buf) return {path: null, name: origName, mimeType: 'application/octet-stream'}

        const saved = this._saveMediaBuffer(buf, undefined, 'inbound', 100 * 1024 * 1024, origName)
        return {path: saved.path, name: origName, mimeType: getMimeFromFilePath(saved.path)}
    }

    private async downloadMediaFile(param: string, aesKey: string, ext: string, _uniqueId: string): Promise<MediaResult> {
        if (!param || !aesKey) return {path: null, name: ''}
        const buf = await this.downloadCdn(param, aesKey)
        if (!buf) return {path: null, name: ''}
        const saved = this._saveMediaBuffer(buf, `video/${ext}`, 'inbound', 100 * 1024 * 1024)
        return {path: saved.path, name: path.basename(saved.path)}
    }

    private async fetchBuffer(url: string): Promise<Buffer | null> {
        try {
            const res = await fetch(url)
            return res.ok ? Buffer.from(await res.arrayBuffer()) : null
        } catch {
            return null
        }
    }

    // ─── CDN Upload ────────────────────────────────────────

    private async uploadMediaToCdn(filePath: string, mediaType: number, toUserId: string): Promise<UploadedMedia> {
        const buf = fs.readFileSync(filePath)
        const rawSize = buf.length
        const rawMd5 = crypto.createHash('md5').update(buf).digest('hex')
        const aesKey = crypto.randomBytes(16)
        const fileKey = crypto.randomBytes(16).toString('hex')
        const encrypted = encryptAesEcb(buf, aesKey)

        const uploadResp = await this.getUploadUrl({
            filekey: fileKey, mediaType, toUserId,
            rawSize, rawFileMd5: rawMd5, fileSize: aesEcbPaddedSize(rawSize),
            aesKeyHex: aesKey.toString('hex'),
        })
        log(`getUploadUrl response: upload_param=${(uploadResp.upload_param ?? 'N/A').slice(0, 30)} full_url=${(uploadResp.upload_full_url ?? 'N/A').slice(0, 80)} filekey=${uploadResp.filekey}`)

        // 优先使用服务端返回的完整上传 URL，否则自行拼接
        let cdnUrl: string
        if (uploadResp.upload_full_url?.trim()) {
            cdnUrl = uploadResp.upload_full_url.trim()
            log(`Using upload_full_url: ${cdnUrl}`)
        } else if (uploadResp.upload_param) {
            cdnUrl = buildCdnUploadUrl(this.cdnBase, uploadResp.upload_param, uploadResp.filekey)
            log(`Using built URL: ${cdnUrl}`)
        } else {
            throw new Error(`CDN upload URL missing. Got: filekey=${uploadResp.filekey}`)
        }

        log(`CDN POST ${cdnUrl.slice(0, 120)}... (${encrypted.length}B encrypted)`)
        const res = await fetch(cdnUrl, {
            method: 'POST',
            headers: {'Content-Type': 'application/octet-stream'},
            body: new Uint8Array(encrypted),
        })
        log(`CDN upload response: ${res.status}`)
        if (!res.ok) {
            const body = await res.text().catch(() => '(no body)')
            throw new Error(`CDN upload failed: HTTP ${res.status} - ${body.slice(0, 300)}`)
        }

        const ep = res.headers.get('x-encrypted-param')
        if (!ep) throw new Error('CDN response missing x-encrypted-param header')
        log(`CDN upload success: ep=${ep.slice(0, 20)}...`)
        return {
            filekey: uploadResp.filekey,
            upload_param: ep,
            thumb_upload_param: uploadResp.thumb_upload_param,
            fileSize: rawSize,
            fileSizeCiphertext: aesEcbPaddedSize(rawSize),
            aes_key: aesKey.toString('hex'),
        }
    }

    private async getUploadUrl(params: {
        filekey: string; mediaType: number; toUserId: string
        rawSize: number; rawFileMd5: string; fileSize: number; aesKeyHex?: string
    }): Promise<{ filekey: string; upload_param: string; thumb_upload_param?: string; upload_full_url?: string }> {
        const body: Record<string, unknown> = {
            filekey: params.filekey, media_type: params.mediaType,
            to_user_id: params.toUserId, rawsize: params.rawSize,
            rawfilemd5: params.rawFileMd5, filesize: params.fileSize,
            no_need_thumb: true,
            base_info: {channel_version: ILINK.CHANNEL_VERSION},
        }
        // 官方 SDK 要求上传 aeskey（hex 格式）
        if (params.aesKeyHex) body.aeskey = params.aesKeyHex
        const res = await fetch(`${this.apiBase}${API_ENDPOINTS.ILINK_GET_UPLOAD_URL}`, {
            method: 'POST', headers: this.headers(),
            body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error(`getUploadUrl failed: ${res.status}`)
        const data = await res.json()
        return {
            filekey: data.filekey || params.filekey,
            upload_param: data.upload_param,
            thumb_upload_param: data.thumb_upload_param,
            upload_full_url: data.upload_full_url,
        }
    }

    // ─── Headers & Sleep ─────────────────────────────────────

    private headers(): Record<string, string> {
        const uin = Buffer.from(String(Math.floor(Math.random() * 0xFFFFFFFF)), 'utf-8').toString('base64')
        return {
            'Content-Type': 'application/json',
            'AuthorizationType': 'ilink_bot_token',
            'Authorization': `Bearer ${this.config?.botToken || ''}`,
            'X-WECHAT-UIN': uin,
            'iLink-App-Id': 'bot',
            'iLink-App-ClientVersion': ILINK.CLIENT_VERSION,
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms))
    }
}

// ─── 本地版 bodyFromItemList（等价于官方包内部实现，因未导出故本地化） ───

/**
 * 从消息 item_list 中提取文本内容：
 * - TEXT 项 → 返回用户输入的文字
 * - VOICE 项 + voice_item.text → 返回语音转文字
 * - 图片/文件 → 返回空字符串
 */
function bodyFromItemList(itemList?: MessageItem[]): string {
    if (!itemList?.length) return ''
    for (const item of itemList) {
        if (item.type === ILINK.ITEM_TYPE_TEXT && item.text_item?.text != null) {
            return String(item.text_item.text)
        }
        if (item.type === ILINK.ITEM_TYPE_VOICE && item.voice_item?.text) {
            return item.voice_item.text
        }
    }
    return ''
}

// ─── Module-Level Helpers ───────────────────────────────────

function tryStat(p: string): fs.Stats | null {
    try {
        return fs.statSync(p)
    } catch {
        return null
    }
}

function parseAesKey(b64: string): Buffer {
    const d = Buffer.from(b64, 'base64')
    if (d.length === 16) return d
    if (d.length === 32 && /^[0-9a-fA-F]{32}$/.test(d.toString('ascii'))) return Buffer.from(d.toString('ascii'), 'hex')
    throw new Error(`aes_key invalid: ${d.length} bytes`)
}

function classifyExt(ext: string): { itemType: number; mediaType: number } {
    if (IMAGE_EXTENSIONS.has(ext)) return {itemType: ILINK.ITEM_TYPE_IMAGE, mediaType: ILINK.MEDIA_TYPE_IMAGE}
    if (VIDEO_EXTENSIONS.has(ext)) return {itemType: ILINK.ITEM_TYPE_VIDEO, mediaType: ILINK.MEDIA_TYPE_VIDEO}
    if (AUDIO_EXTENSIONS.has(ext)) return {itemType: ILINK.ITEM_TYPE_VOICE, mediaType: ILINK.MEDIA_TYPE_VOICE}
    return {itemType: ILINK.ITEM_TYPE_FILE, mediaType: ILINK.MEDIA_TYPE_FILE}
}

function encryptAesEcb(plain: Buffer, key: Buffer): Buffer {
    const c = crypto.createCipheriv('aes-128-ecb', key, null)
    return Buffer.concat([c.update(plain), c.final()])
}

function decryptAesEcb(enc: Buffer, key: Buffer): Buffer {
    const d = crypto.createDecipheriv('aes-128-ecb', key, null)
    return Buffer.concat([d.update(enc), d.final()])
}

async function silkToWav(silk: Buffer): Promise<Buffer | null> {
    try {
        const {decode} = await import('silk-wasm')
        const r = await decode(silk, CDN.SILK_SAMPLE_RATE)
        const h = Buffer.allocUnsafe(44)
        let o = 0
        h.write('RIFF', o);
        o += 4
        h.writeUInt32LE(36 + r.data.byteLength, o);
        o += 4
        h.write('WAVE', o);
        o += 4
        h.write('fmt ', o);
        o += 4
        h.writeUInt32LE(16, o);
        o += 4
        h.writeUInt16LE(1, o);
        o += 2
        h.writeUInt16LE(1, o);
        o += 2
        h.writeUInt32LE(CDN.SILK_SAMPLE_RATE, o);
        o += 4
        h.writeUInt32LE(CDN.SILK_SAMPLE_RATE * 2, o);
        o += 4
        h.writeUInt16LE(2, o);
        o += 2
        h.writeUInt16LE(16, o);
        o += 2
        h.write('data', o);
        o += 4
        h.writeUInt32LE(r.data.byteLength, o);
        o += 4
        return Buffer.concat([h, Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength)])
    } catch {
        logErr('silkToWav failed, fallback to raw SILK')
        return null
    }
}
