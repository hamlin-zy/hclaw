/**
 * 本地文件路径 → hclaw-media:// URL 转换
 * （从 MediaPlayer.tsx 抽出，供备忘录附件缩略图等处复用）
 */

/**
 * 将本地文件路径转换为 hclaw-media:// URL
 * C:\path\to\file.mp3 → hclaw-media:///C:/path/to/file.mp3
 * /home/user/file.mp3 → hclaw-media:///home/user/file.mp3
 */
export function toMediaUrl(urlOrPath: string): string {
    if (!urlOrPath) return ''

    // 解码 percent-encoded 字符（micromark 的 sanitizeUri 会将反斜杠编码为 %5C）
    let normalized = urlOrPath
    if (urlOrPath.includes('%')) {
        try {
            normalized = decodeURIComponent(urlOrPath)
        } catch { /* 保持原始值 */
        }
    }

    // 统一反斜杠为正斜杠
    normalized = normalized.replace(/\\/g, '/')

    // file:// 协议 → 转为 hclaw-media://（renderer 无法直接加载 file://）
    if (normalized.startsWith('file://')) {
        const path = normalized.slice(7) // remove 'file://'
        return toMediaUrl(path)          // recurse to handle the raw path
    }

    // 已经是网络协议 URL（http/https/data/hclaw-media），直接返回
    if (/^[a-zA-Z][a-zA-Z0-9+\-]*:\/\//.test(normalized)) {
        return normalized
    }

    // Windows 绝对路径: C:\path\to\file
    if (/^[a-zA-Z]:[\\/]/.test(normalized)) {
        return 'hclaw-media:///' + normalized.replace(/\\/g, '/')
    }

    // Unix 绝对路径: /home/user/file
    if (normalized.startsWith('/')) {
        return 'hclaw-media://' + normalized
    }

    // 相对路径（回退）
    return normalized
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i

/** 按扩展名判断是否为可预览的图片附件 */
export function isImageFileName(fileName: string): boolean {
    return IMAGE_EXT_RE.test(fileName)
}
