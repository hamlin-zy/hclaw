import {z} from 'zod'
import * as path from 'path'
import * as fs from 'fs/promises'
import type {Tool, ToolContext, ToolResult} from '../types'
import {isNetworkImageUrl} from '../../utils/imageProcessor'
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_INPUT_BYTES,
  DEFAULT_IMAGE_COMPRESS_QUALITY,
  ImageCompressError,
  compressImage,
  mimeForExt,
  type CompressedImage,
} from '../../utils/imageCompress'
import {saveBufferSnapshot, type ImageSnapshot} from '../../utils/imageSnapshot'
import {systemSettingsRepo} from '../../../repositories/sqlite/systemSettingsRepository'
import type {SystemSettings} from '@shared/types'

export const LOAD_IMAGE_TOOL_NAME = 'load_image'

const inputSchema = z.object({
  imagePath: z.string().describe('本地图片的完整路径（绝对路径优先，也可相对当前工作目录）。仅用于当前消息中尚未直接可见的图片；已作为附件直接呈现的图片无需再传。'),
})

type Input = z.infer<typeof inputSchema>

/**
 * 工具输出文本的构造器（供派生解析契约锁定；导出以便单测）。
 * 首行必须是 `image_path: <path>`，全 `\n` 分隔、无 `\r`、无时间戳。
 */
export function formatLoadImageOutput(s: ImageSnapshot, originalName: string): string {
  const name = originalName.replace(/[\r\n]/g, '')
  return [`image_path: ${s.path}`, `mime: ${s.mime}`, `bytes: ${s.bytes}`, `name: ${name}`].join('\n')
}

/**
 * 读取用户配置的图片压缩质量（`settings.model.imageCompressQuality`）。
 * 失败/缺失/非法一律回落默认 85（压缩层还会再 clamp 一次到 1-100）。
 */
export function resolveImageCompressQuality(): number {
  try {
    const q = systemSettingsRepo.getJson<SystemSettings>('settings')?.model?.imageCompressQuality
    return typeof q === 'number' ? q : DEFAULT_IMAGE_COMPRESS_QUALITY
  } catch {
    return DEFAULT_IMAGE_COMPRESS_QUALITY
  }
}

/** 压缩层可识别错误 → 面向模型的明确文案（不静默、不猜测） */
function describeCompressError(err: unknown): string {
  if (err instanceof ImageCompressError) {
    const msg = err.message
    return err.code === 'IMAGE_COMPRESS_TOO_LARGE'
      ? `${msg}（单图上限 ${MAX_IMAGE_BYTES / (1024 * 1024)}MB）`
      : msg
  }
  return `图片压缩失败: ${err instanceof Error ? err.message : String(err)}`
}

export const loadImageTool: Tool<Input, string> = {
  name: LOAD_IMAGE_TOOL_NAME,
  description: '把本地图片文件加载给主模型查看（仅当主模型自身具备视觉能力时可用）。用于图片尚未直接可见的场景：用户消息只在文字里提到某个本地图片路径，或你通过其他工具发现了一个本地图片文件。若图片已作为附件直接提供给你（当前消息中已带图片内容），不要重复调用本工具。返回图片快照路径，图片内容将在下一次请求中直接提供给你。imagePath 必须指向本地文件。',
  inputSchema,
  requiredPermissions: [],
  isDestructive: false,

  async execute(args: Input, context: ToolContext): Promise<ToolResult<string>> {
    const {imagePath} = args
    try {
      if (isNetworkImageUrl(imagePath)) {
        return {success: false, output: '', error: 'load_image 仅支持本地图片，不支持网络 URL'}
      }

      const abs = path.resolve(context.workingDir, imagePath)
      let size: number
      try {
        const st = await fs.stat(abs)
        if (!st.isFile()) throw new Error('not file')
        size = st.size
      } catch {
        return {success: false, output: '', error: `图片文件不存在: ${abs}`}
      }

      // 格式白名单：只放行三家 adapter 都认的 mime；tiff 交给压缩层转 PNG；其余明确拒绝。
      const ext = path.extname(abs).toLowerCase()
      if (ext === '.bmp') {
        // 诚实文案：当前运行时 sharp 构建不含 BMP 解码器（sharp.format.bmp 为空），
        // 收录只会让"承诺可加载"与"实际解码失败"矛盾 → 直接引导用户转换。
        return {
          success: false,
          output: '',
          error: '当前运行时不支持 BMP，请先转换为 PNG/JPEG/WebP',
        }
      }
      const mime = mimeForExt(ext)
      if (!mime) {
        return {
          success: false,
          output: '',
          error: `不是受支持的图片格式: ${ext || '(无扩展名)'}（支持 png/jpg/jpeg/webp/gif；tiff 会自动转换为 PNG）`,
        }
      }

      if (size > MAX_IMAGE_INPUT_BYTES) {
        return {
          success: false,
          output: '',
          error: `图片超过可处理体积上限（${MAX_IMAGE_INPUT_BYTES / (1024 * 1024)}MB）: ${size} bytes`,
        }
      }

      let raw: Buffer
      try {
        raw = await fs.readFile(abs)
      } catch (err: unknown) {
        return {success: false, output: '', error: `读取图片失败: ${err instanceof Error ? err.message : String(err)}`}
      }

      // 压缩/转码必须在落快照之前（R2：快照即注入侧唯一输入，注入层零处理）
      // 质量来自用户设置；同一 (input, quality) 仍逐字节确定 —— 设置变更不改写
      // 已落库的历史快照（注入层读内容哈希路径，不重新压缩），历史前缀不漂移。
      let compressed: CompressedImage
      try {
        compressed = await compressImage(raw, mime, {quality: resolveImageCompressQuality()})
      } catch (err: unknown) {
        return {success: false, output: '', error: describeCompressError(err)}
      }

      const snap = await saveBufferSnapshot(compressed.buffer, compressed.ext, compressed.mime)
      return {success: true, output: formatLoadImageOutput(snap, path.basename(abs))}
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {success: false, output: '', error: `读取或保存图片失败: ${msg}`}
    }
  },
}
