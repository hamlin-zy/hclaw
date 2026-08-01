import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import {ipcMain, dialog} from 'electron'
import sharp from 'sharp'
import {getHclawDataDir} from '../config'

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']

/** 背景图存储目录：<hclawDir>/data/backgrounds/ */
function getBackgroundDir(): string {
    const dir = path.join(getHclawDataDir(), 'backgrounds')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true})
    return dir
}

/**
 * 拷贝并裁掉图片四边纯色边框（任意颜色/透明）
 *
 * 用户选择的背景图常带边框（截图黑框、PPT 白边、壁纸透明边等），
 * 铺满窗口后边框会变成明显的色块。这里用 sharp.trim() 链式裁剪：
 * trim() 不带 background 参数时以上一层的左上角像素为参考色，
 * 因此透明、白、黑、任意纯色边框都能裁；链式 3 次可依次裁掉
 * 多层边框（如白底黑框截图）。threshold 15 容忍 JPEG 压缩边缘噪声。
 *
 * 失败（sharp 不可用/格式不支持）时回退为直接拷贝，不阻断流程。
 */
async function copyWithTrim(sourcePath: string, destPath: string): Promise<void> {
    try {
        await sharp(sourcePath)
            .trim({threshold: 15})
            .trim({threshold: 15})
            .trim({threshold: 15})
            .toFile(destPath)
        const trimmed = await sharp(destPath).metadata()
        console.log('[background-pick] trim 完成:', {
            src: path.basename(sourcePath),
            size: `${trimmed.width}x${trimmed.height}`,
        })
    } catch (err) {
        console.warn('[background-pick] trim 失败，回退直接拷贝:', err)
        fs.copyFileSync(sourcePath, destPath)
    }
}

/**
 * 把绝对路径转成 hclaw-media:// URL
 *
 * ⚠️ 必须用带 host 的格式（hclaw-media://local/...），不能用手工拼接的 hclaw-media:///C:/...
 * 原因：Chromium 会把 hclaw-media:///C:/path 规范化为 host="c" + pathname="/path"，
 * 盘符 C: 丢失 → 协议处理器收到 Users/... 找不到文件（已验证，参考 MarkdownRenderer.tsx localPathToMediaUrl）。
 *
 * 项目约定格式（与 MarkdownRenderer.tsx localPathToMediaUrl 一致）：
 * - Windows: hclaw-media://local/C:/path/to/file.png
 * - Unix:    hclaw-media://local/home/user/file.png
 */
function toMediaUrl(absPath: string): string {
    const normalized = absPath.split(path.sep).join('/')
    return `hclaw-media://local/${normalized.replace(/^\/+/, '')}`
}

export function initBackgroundIPC(): void {
    ipcMain.handle('background-pick', async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [
                {name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']},
            ],
            title: '选择背景图片',
        })
        if (result.canceled || result.filePaths.length === 0) return null

        const sourcePath = result.filePaths[0]
        const ext = path.extname(sourcePath).toLowerCase()
        if (!IMAGE_EXTENSIONS.includes(ext)) return null

        const destPath = path.join(getBackgroundDir(), `${crypto.randomUUID()}${ext}`)
        try {
            await copyWithTrim(sourcePath, destPath)
            return {path: toMediaUrl(destPath)}
        } catch (err) {
            console.error('[background-pick] 拷贝失败:', err)
            return null
        }
    })

    ipcMain.handle('background-list', async () => {
        try {
            const dir = getBackgroundDir()
            if (!fs.existsSync(dir)) return []
            const files = fs.readdirSync(dir)
                .filter(f => IMAGE_EXTENSIONS.includes(path.extname(f).toLowerCase()))
            return files
                .map(f => {
                    const abs = path.join(dir, f)
                    const stat = fs.statSync(abs)
                    return {
                        path: toMediaUrl(abs),
                        name: f,
                        size: stat.size,
                        mtime: stat.mtimeMs,
                    }
                })
                .sort((a, b) => b.mtime - a.mtime)
        } catch (err) {
            console.error('[background-list] 失败:', err)
            return []
        }
    })

    ipcMain.handle('background-remove', async (_event, mediaUrl: string) => {
        try {
            // 从 hclaw-media:// 反解绝对路径
            // 新格式: hclaw-media://local/C:/path（host=local, pathname=/C:/path）
            // 旧格式: hclaw-media:///C:/path 与 hclaw-media://c/Users/...（兼容清理）
            let absPath: string
            try {
                const u = new URL(mediaUrl)
                let p = decodeURIComponent(u.pathname)
                if (process.platform === 'win32') {
                    p = p.replace(/^[/\\]+/, '')
                    // 单字母 host 是盘符（旧格式 hclaw-media://c/Users → c:/Users）
                    if (/^[a-zA-Z]$/.test(u.host)) p = u.host + ':/' + p.replace(/^[\\/]+/, '')
                }
                absPath = path.resolve(p.split('/').join(path.sep))
            } catch {
                absPath = path.resolve(mediaUrl.replace(/^hclaw-media:\/\/\/?/, '').split('/').join(path.sep))
            }
            // 安全检查：只允许删除 backgrounds 目录内的文件
            const bgDir = path.resolve(getBackgroundDir())
            if (!absPath.startsWith(bgDir + path.sep)) return false
            if (fs.existsSync(absPath)) fs.unlinkSync(absPath)
            return true
        } catch (err) {
            console.error('[background-remove] 删除失败:', err)
            return false
        }
    })
}
