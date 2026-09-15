/**
 * Channel module utilities
 *
 * Shared utility functions and helpers for the channel module.
 */

// ─── Attachment Classification ─────────────────────────────

const AUDIO_EXT_SET = new Set(['.mp3', '.wav', '.m4a', '.amr', '.ogg', '.flac', '.aac', '.silk'])
const _IMAGE_EXT_SET = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif'])

function getExt(path: string): string {
    return `.${path.split('.').pop()?.toLowerCase() || ''}`
}

/**
 * 检查附件列表中是否包含音频文件
 */
export function hasAudioAttachment(attachments: Array<{ path: string; name: string }>): boolean {
    return attachments.some(a => {
        const ext = getExt(a.path || a.name)
        return AUDIO_EXT_SET.has(ext)
    })
}

/**
 * 判断消息是否只有附件标记（没有用户实际输入的文字内容）
 * 纯附件消息如：msg.text="[图片]" 或 "[语音消息 9:09]" 或 "[文件: xxx.pdf]"
 */
export function isAttachmentOnlyMarker(text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed) return true
    // 检查每一行是否都以 [ 开头（附件标记）
    const lines = trimmed.split('\n').filter(l => l.trim())
    if (lines.length === 0) return true
    return lines.every(l => /^\[.*?\]/.test(l.trim()))
}
