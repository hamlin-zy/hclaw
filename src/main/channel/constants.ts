/**
 * Channel module constants
 *
 * Centralizes all magic strings, numbers, URLs, and configuration
 * to improve maintainability and prevent typos.
 */

// ─── API Endpoints ────────────────────────────────────────

export const API_ENDPOINTS = {
    // iLink (WeChat Personal)
    ILINK_BASE: 'https://ilinkai.weixin.qq.com',
    ILINK_GET_UPDATES: '/ilink/bot/getupdates',
    ILINK_SEND_MESSAGE: '/ilink/bot/sendmessage',
    ILINK_GET_MEDIA: '/ilink/bot/getmedia',
    ILINK_NOTIFY_STOP: '/ilink/bot/msg/notifystop',
    ILINK_GET_QRCODE: '/ilink/bot/get_bot_qrcode',
    ILINK_QRCODE_STATUS: '/ilink/bot/get_qrcode_status',
    ILINK_GET_UPLOAD_URL: '/ilink/bot/getuploadurl',

    // Feishu
    FEISHU_WS: 'wss://open.feishu.cn/open-apis/ws/v1/connect',
    FEISHU_TOKEN: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    FEISHU_SEND_MESSAGE: 'https://open.feishu.cn/open-apis/im/v1/messages',
    // Feishu media download
    FEISHU_IMAGE: 'https://open.feishu.cn/open-apis/im/v1/images',
    FEISHU_FILE: 'https://open.feishu.cn/open-apis/im/v1/files',
    FEISHU_MEDIA: 'https://open.feishu.cn/open-apis/im/v1/media',

} as const

// ─── Timeouts (ms) ─────────────────────────────────────────

export const TIMEOUTS = {
    // iLink
    LONG_POLL: 35_000,
    LONG_POLL_GRACE: 5_000,
    GET_QRCODE: 5_000,
    QR_POLL: 35_000,
    QR_SESSION_TTL: 5 * 60_000,

    // General
    RECONNECT_DELAY: 5_000,
    HEARTBEAT_INTERVAL: 30_000,
    AGENT_RESPONSE_TIMEOUT: 5 * 60_000,
    CONNECTION_TEST_TIMEOUT: 30_000,
    SLEEP_SHORT: 1_000,
    SLEEP_MEDIUM: 3_000,
    WORKER_RESTART_DELAY: 5_000,
} as const

// ─── iLink Protocol Constants ───────────────────────────────
// NOTE: CHANNEL_VERSION must stay aligned with devDependency weixin-agent-sdk.
// When you `npm update weixin-agent-sdk`, update this to match its version.
// Example: weixin-agent-sdk@0.5.0 → CHANNEL_VERSION: '0.5.0'
// See: https://www.npmjs.com/package/weixin-agent-sdk
export const ILINK = {
    CHANNEL_VERSION: '0.5.0',
    BOT_TYPE: 3,
    CLIENT_VERSION: '132099',

    // Message types
    MESSAGE_TYPE_USER: 1,
    MESSAGE_TYPE_BOT: 2,

    // Message states
    MESSAGE_STATE_NEW: 0,
    MESSAGE_STATE_GENERATING: 1,
    MESSAGE_STATE_FINISH: 2,

    // Item types (multimedia)
    ITEM_TYPE_TEXT: 1,
    ITEM_TYPE_IMAGE: 2,
    ITEM_TYPE_VOICE: 3,
    ITEM_TYPE_VIDEO: 4,
    ITEM_TYPE_FILE: 5,

    // Voice formats
    VOICE_FORMAT_DEFAULT: 0,
    VOICE_FORMAT_SILK: 1,
    VOICE_FORMAT_MP3: 2,
    VOICE_FORMAT_WAV: 3,
    VOICE_FORMAT_AAC: 4,

    // Media types for upload
    MEDIA_TYPE_IMAGE: 1,
    MEDIA_TYPE_VIDEO: 2,
    MEDIA_TYPE_FILE: 3,
    MEDIA_TYPE_VOICE: 4,

    // Error codes
    ERR_SESSION_EXPIRED: -14,
} as const

// ─── Voice Format Mapping ─────────────────────────────────

export const VOICE_FORMATS: Record<number, string> = {
    [ILINK.VOICE_FORMAT_DEFAULT]: 'amr',
    [ILINK.VOICE_FORMAT_SILK]: 'silk',
    [ILINK.VOICE_FORMAT_MP3]: 'mp3',
    [ILINK.VOICE_FORMAT_WAV]: 'wav',
    [ILINK.VOICE_FORMAT_AAC]: 'aac',
}

// ─── File Extensions ──────────────────────────────────────

export const AUDIO_EXTENSIONS = new Set([
    '.mp3', '.wav', '.m4a', '.amr', '.ogg', '.webm', '.flac', '.aac', '.silk',
])

export const IMAGE_EXTENSIONS = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif',
])

export const VIDEO_EXTENSIONS = new Set([
    '.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v',
])

export const FILE_EXTENSIONS = new Set([
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip',
    '.rar', '.7z', '.txt', '.csv', '.json', '.xml', '.html', '.css', '.js',
    '.ts', '.py', '.java', '.c', '.cpp', '.h', '.md', '.log',
])

// ─── CDN Constants ────────────────────────────────────────

export const CDN = {
    /** Default CDN base URL for media upload/download */
    DEFAULT_BASE_URL: 'https://novac2c.cdn.weixin.qq.com/c2c',
    /** Maximum file size for media (100MB) */
    MAX_FILE_SIZE: 100 * 1024 * 1024,
    /** Maximum retry attempts for CDN upload */
    UPLOAD_MAX_RETRIES: 3,
    /** Default SILK sample rate for voice transcoding */
    SILK_SAMPLE_RATE: 24_000,
} as const

// ─── iLink Headers ────────────────────────────────────────

export function buildILinkHeaders(token: string, uin: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'AuthorizationType': 'ilink_bot_token',
        'Authorization': `Bearer ${token}`,
        'X-WECHAT-UIN': uin,
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': ILINK.CLIENT_VERSION,
    }
}

export function randomUin(): string {
    const buf = Buffer.alloc(4)
    for (let i = 0; i < 4; i++) buf[i] = Math.floor(Math.random() * 256)
    return Buffer.from(String(buf.readUInt32BE(0)), 'utf-8').toString('base64')
}

// ─── Utility Functions ─────────────────────────────────────

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export function ensureTrailingSlash(url: string): string {
    return url.endsWith('/') ? url : `${url}/`
}

export function getFileExtension(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    return ext.startsWith('.') ? ext : `.${ext}`
}

export function isAudioFile(filePath: string): boolean {
    return AUDIO_EXTENSIONS.has(getFileExtension(filePath))
}

export function isImageFile(filePath: string): boolean {
    return IMAGE_EXTENSIONS.has(getFileExtension(filePath))
}

// ─── CDN Utilities ────────────────────────────────────────

/**
 * Build CDN download URL from encrypted query parameter
 */
export function buildCdnDownloadUrl(encryptQueryParam: string, cdnBaseUrl: string): string {
    return `${cdnBaseUrl.replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`
}

/**
 * Build CDN upload URL from upload parameter and filekey
 * Matches official iLink SDK: {cdnBaseUrl}/upload?encrypted_query_param=...&filekey=...
 */
export function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string {
    return `${cdnBaseUrl.replace(/\/+$/, '')}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

/**
 * Compute AES-128-ECB ciphertext size with PKCS7 padding
 */
export function aesEcbPaddedSize(plaintextSize: number): number {
    return Math.ceil((plaintextSize + 1) / 16) * 16
}

// ─── MIME Type Utilities ───────────────────────────────────

const MIME_TYPES: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.amr': 'audio/amr',
    '.silk': 'audio/silk',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
    '.7z': 'application/x-7z-compressed',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.ts': 'application/typescript',
    '.py': 'text/x-python',
    '.java': 'text/x-java',
    '.c': 'text/x-c',
    '.cpp': 'text/x-c++',
    '.h': 'text/x-chdr',
    '.md': 'text/markdown',
    '.log': 'text/plain',
}

/**
 * Get MIME type from file extension
 */
export function getMimeFromExtension(ext: string): string {
    const lowerExt = ext.toLowerCase().startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
    return MIME_TYPES[lowerExt] || 'application/octet-stream'
}

/**
 * Get MIME type from file path
 */
export function getMimeFromFilePath(filePath: string): string {
    const ext = getFileExtension(filePath)
    return getMimeFromExtension(ext)
}

// ─── Worker Thread Utilities ───────────────────────────────

export function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
    ])
}
