/**
 * 图片压缩层（load_image 专用）
 *
 * 目标：把任意本地图片规整为「三家 adapter（anthropic/openai/google）都认」的
 *   体积 ≤ MAX_IMAGE_BYTES、长边 ≤ MAX_IMAGE_EDGE 的字节流。
 *
 * 约束（务必保持）：
 * - **Worker-safe**：只依赖 sharp（原生库，非 electron），不得 import electron / renderer。
 * - **纯函数**：不做任何磁盘 IO、无全局状态、无副作用；输出只由 (input, mime) 决定。
 * - **确定性（R2）**：固定 sharp 参数、默认丢弃 EXIF/ICC 等元数据、无时间戳/随机数。
 *   同一输入两次调用必须产出**逐字节相同**的输出（见 tests/main/agent/utils/imageCompress.test.ts）。
 */

import sharp, {type Metadata} from 'sharp'

/**
 * 单图最终体积上限：3.5MB。
 * 依据：Anthropic 单图 base64 上限约 5MB（base64 膨胀 4/3）≈ 原图 3.7MB，取 3.5MB 留余量。
 */
export const MAX_IMAGE_BYTES = Math.floor(3.5 * 1024 * 1024) // 3670016

/** 长边上限（Anthropic 视觉建议 ≤1568px；超出既无收益也推高 token/体积） */
export const MAX_IMAGE_EDGE = 1568

/** 图片压缩默认质量（与设置项 `model.imageCompressQuality` 的默认值一致） */
export const DEFAULT_IMAGE_COMPRESS_QUALITY = 85
/** 质量下界（clamp 用；UI 建议下限另取 40，代码层允许 1-100） */
export const MIN_IMAGE_COMPRESS_QUALITY = 1
/** 质量上界（clamp 用） */
export const MAX_IMAGE_COMPRESS_QUALITY = 100
/** 派生降质档位时的最低质量，避免 q 很小时档位跌到无意义区间 */
const MIN_DERIVED_QUALITY = 20

/**
 * 允许读入内存的**原图**体积硬上限（防御性）。
 * 与 MAX_IMAGE_BYTES 语义不同：超过 MAX_IMAGE_BYTES 的原图会走压缩，超过本上限直接拒绝，
 * 避免一次性把超大文件读进内存。
 */
export const MAX_IMAGE_INPUT_BYTES = 64 * 1024 * 1024

/** 扩展名 → canonical mime（不支持 → undefined，不静默回退） */
const EXT_TO_MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
}

/**
 * load_image 允许的扩展名（其余一律拒绝，不做猜测）。
 * 注：`.bmp` 不在其中 —— 当前运行时的 sharp 构建不含 BMP 解码器（`sharp.format.bmp` 为空），
 * 收录它只会让"承诺可加载"与"实际解码失败"自相矛盾，故显式移除。
 */
export const LOADABLE_IMAGE_EXTS: ReadonlySet<string> = new Set(Object.keys(EXT_TO_MIME))

/** 三家 provider 不支持、必须转码的扩展名（走 sharp → PNG）。BMP 因运行时无解码器不再收录。 */
export const CONVERT_EXTS: ReadonlySet<string> = new Set(['.tiff', '.tif'])

/** mime → 落快照用的规范扩展名 */
const MIME_TO_EXT: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
}

/** mime 别名归一到 canonical（工具层不得依赖回退猜测） */
const MIME_ALIASES: Record<string, string> = {
    'image/jpeg': 'image/jpeg',
    'image/jpg': 'image/jpeg',
    'image/pjpeg': 'image/jpeg',
    'image/png': 'image/png',
    'image/gif': 'image/gif',
    'image/webp': 'image/webp',
    'image/tiff': 'image/tiff',
}

export type ImageCompressErrorCode =
    | 'IMAGE_COMPRESS_UNSUPPORTED'
    | 'IMAGE_COMPRESS_DECODE'
    | 'IMAGE_COMPRESS_TOO_LARGE'
    /** 多帧（动画）GIF：重编码会静默丢帧，显式拒绝而非隐性降级 */
    | 'IMAGE_COMPRESS_ANIMATED'

/** 可识别错误：工具层据此转成明确的 success:false 文案，不静默、不猜测 */
export class ImageCompressError extends Error {
    readonly code: ImageCompressErrorCode

    constructor(code: ImageCompressErrorCode, message: string) {
        super(message)
        this.name = 'ImageCompressError'
        this.code = code
    }
}

export interface CompressedImage {
    buffer: Buffer
    /** 输出字节的真实 mime（与 buffer 内容严格一致） */
    mime: string
    /** 输出字节的规范扩展名（含点，小写） */
    ext: string
}

/** 扩展名是否为 load_image 可接受的图片格式 */
export function isLoadableImageExt(ext: string): boolean {
    return LOADABLE_IMAGE_EXTS.has(ext.toLowerCase())
}

/** 该扩展名是否需要转码（provider 不认、必须转成 PNG） */
export function needsFormatConversion(ext: string): boolean {
    return CONVERT_EXTS.has(ext.toLowerCase())
}

/** 扩展名 → canonical mime；不支持返回 null（禁止静默回退 image/jpeg） */
export function mimeForExt(ext: string): string | null {
    return EXT_TO_MIME[ext.toLowerCase()] ?? null
}

function canonicalMime(mime: string): string {
    const canonical = MIME_ALIASES[(mime || '').toLowerCase()]
    if (!canonical) {
        throw new ImageCompressError('IMAGE_COMPRESS_UNSUPPORTED', `不支持的图片格式: ${mime || '(空)'}`)
    }
    return canonical
}

/** 解码失败（读元数据或编码任一步）的统一错误；文案单一来源，避免两处漂移 */
function decodeError(canonical: string): ImageCompressError {
    return new ImageCompressError(
        'IMAGE_COMPRESS_DECODE',
        `无法解码图片（文件损坏，或该格式在当前运行时不支持）: ${canonical}`,
    )
}

type EncodeFormat = 'png' | 'jpeg' | 'webp'

const MIME_OF: Record<EncodeFormat, string> = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
}

const EXT_OF: Record<EncodeFormat, string> = {
    png: '.png',
    jpeg: '.jpg',
    webp: '.webp',
}

interface Attempt {
    format: EncodeFormat
    quality?: number
    maxEdge: number
}

/** 规范化质量入参：缺省/非法（NaN/非数字）→ 默认 85；越界 → clamp 到 1-100（取整） */
function normalizeQuality(quality: number | undefined): number {
    if (typeof quality !== 'number' || Number.isNaN(quality)) return DEFAULT_IMAGE_COMPRESS_QUALITY
    const rounded = Math.round(quality)
    return Math.min(MAX_IMAGE_COMPRESS_QUALITY, Math.max(MIN_IMAGE_COMPRESS_QUALITY, rounded))
}

/**
 * 迭代策略（最多 3 轮：降质 → 降尺寸）。
 * - 需要转码（tiff）：第 1 轮无损 PNG；若仍超限再走有损（保 alpha 用 WebP，否则 JPEG）。
 * - 其余：第 1 轮即有损 q → 长边 1568。
 *
 * 档位随基础质量 `quality` 派生（尺寸档位 1568/1200/1024 保持不变）：
 * 基础质量越高，首轮越清晰，后续降质档位也整体上移。质量为默认 85 时派生结果与
 * 既有硬编码档位 [85/1568, 70/1200, 50/1024] 逐项一致（回归锁定）。
 */
function buildAttempts(convert: boolean, hasAlpha: boolean, quality: number): Attempt[] {
    const lossy: EncodeFormat = hasAlpha ? 'webp' : 'jpeg'
    const derived = (drop: number) => Math.max(MIN_DERIVED_QUALITY, quality - drop)
    return convert
        ? [
            {format: 'png', maxEdge: MAX_IMAGE_EDGE},
            {format: lossy, quality, maxEdge: MAX_IMAGE_EDGE},
            {format: lossy, quality: derived(15), maxEdge: 1200},
        ]
        : [
            {format: lossy, quality, maxEdge: MAX_IMAGE_EDGE},
            {format: lossy, quality: derived(15), maxEdge: 1200},
            {format: lossy, quality: derived(35), maxEdge: 1024},
        ]
}

/**
 * 固定参数编码（任何影响输出的参数都必须显式写死，保证逐字节确定性）。
 *
 * EXIF 方向：`rotate()` 无参形式 = 按源 EXIF Orientation 自动旋转，修正手机竖拍照片在
 * 模型侧横躺/倒置的问题。**确定性依据**：输出仅由（输入像素 + EXIF Orientation）决定；
 * Orientation 是文件内的确定性整数字段、无参 rotate 不引入任何时间/随机量，且本函数不写回
 * 元数据（输出无 EXIF），故同一输入多次编码 → 逐字节相同（R2 不破）。
 * 透传路径（未触发重编码）不调用本函数，保持原字节输出约定不变。
 */
async function encode(input: Buffer, attempt: Attempt): Promise<Buffer> {
    let pipeline = sharp(input).rotate()
    if (attempt.maxEdge > 0) {
        pipeline = pipeline.resize({
            width: attempt.maxEdge,
            height: attempt.maxEdge,
            fit: 'inside',
            withoutEnlargement: true,
            kernel: 'lanczos3',
        })
    }
    switch (attempt.format) {
        case 'png':
            // PNG 无质量旋钮，固定 compressionLevel；palette 关闭避免调色板量化带来的版本差异
            return pipeline.png({compressionLevel: 9, palette: false}).toBuffer()
        case 'webp':
            return pipeline
                .webp({quality: attempt.quality, alphaQuality: attempt.quality, effort: 4, smartSubsample: false})
                .toBuffer()
        default:
            return pipeline
                .jpeg({
                    quality: attempt.quality,
                    chromaSubsampling: '4:2:0',
                    mozjpeg: false,
                    progressive: false,
                    optimiseCoding: true,
                })
                .toBuffer()
    }
}

/**
 * 压缩/规整图片字节。
 *
 * 触发条件（任一满足才重新编码）：字节 > MAX_IMAGE_BYTES、长边 > MAX_IMAGE_EDGE、需要格式转码。
 * 未触发 → **原字节返回**（保证既有小图行为与哈希完全不变）。
 *
 * `opts.quality`（1-100）：用户可配置的压缩质量，缺省/非法回落 85。质量只是入参，
 * 不引入任何时间/随机量 → 同一 (input, mime, quality) 仍逐字节可复现（R2 不破）。
 *
 * **R2 跨轮稳定性**：设置变更不会改写已有消息。注入层读的是**已落库的快照路径**
 * （文件名 = 内容哈希），不会重新压缩历史图片；因此会话中途调整质量只影响后续
 * load_image 调用，历史前缀不漂移。
 *
 * @throws ImageCompressError 不支持格式 / 解码失败 / 动画 GIF / 压缩后仍超限
 */
export async function compressImage(
    input: Buffer,
    mime: string,
    opts?: {quality?: number},
): Promise<CompressedImage> {
    const canonical = canonicalMime(mime)
    const convert = canonical === 'image/tiff'
    const oversized = input.length > MAX_IMAGE_BYTES

    let meta: Metadata
    try {
        meta = await sharp(input).metadata()
    } catch {
        // 需要转码或需要瘦身时，解码失败必须显式报错（不静默放行 → 避免请求期 400）
        if (convert || oversized) {
            throw decodeError(canonical)
        }
        // 体积与尺寸都无需处理、且 provider 认可该 mime → 原样放行（保持既有行为）
        return {buffer: input, mime: canonical, ext: MIME_TO_EXT[canonical] ?? '.png'}
    }

    // 多帧（动画）GIF：重编码只会保留首帧、静默丢帧且用户无感 → 语义上必须显式拒绝。
    // 静帧 GIF（pages ≤ 1）不受影响，仍按原逻辑透传/缩放。
    if (canonical === 'image/gif' && (meta.pages ?? 1) > 1) {
        throw new ImageCompressError(
            'IMAGE_COMPRESS_ANIMATED',
            `暂不支持动画 GIF（${meta.pages} 帧），请提供静帧或拆分后重试`,
        )
    }

    const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0)
    const resizeNeeded = longEdge > MAX_IMAGE_EDGE
    if (!convert && !oversized && !resizeNeeded) {
        return {buffer: input, mime: canonical, ext: MIME_TO_EXT[canonical] ?? '.png'}
    }

    const quality = normalizeQuality(opts?.quality)
    const attempts = buildAttempts(convert, Boolean(meta.hasAlpha), quality)
    let lastSize = 0
    for (const attempt of attempts) {
        let out: Buffer
        try {
            out = await encode(input, attempt)
        } catch {
            throw decodeError(canonical)
        }
        if (out.length <= MAX_IMAGE_BYTES) {
            return {buffer: out, mime: MIME_OF[attempt.format], ext: EXT_OF[attempt.format]}
        }
        lastSize = out.length
    }

    throw new ImageCompressError(
        'IMAGE_COMPRESS_TOO_LARGE',
        `图片压缩后仍超过 ${MAX_IMAGE_BYTES / (1024 * 1024)}MB（压缩后 ${lastSize} bytes），请手动压缩或裁剪`,
    )
}
